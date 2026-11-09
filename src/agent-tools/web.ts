// web_fetch: read one page through Otari's fetch (POST /fetch), so the page text passes through the harness,
// where it is labelled and screened like any other untrusted content (K13). Web search stays Otari's own
// in-loop tool. The teammate's allowed and blocked sites are enforced here, in code, before and after redirects.
import { otari, OtariError } from "../otari/client.ts";
import { object } from "./schema.ts";
import type { AgentTool, ToolContext } from "./types.ts";

const covers = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);
function siteRefusal(ctx: ToolContext, url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return `${url} is not a URL; send a full https:// address.`; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "Only http and https pages can be read.";
  const host = u.hostname.toLowerCase();
  const { allowed_domains: allow, blocked_domains: block } = ctx.teammate.config.web;
  if (block.some((d) => covers(host, d))) return `${host} is on this teammate's blocked sites.`;
  if (allow.length && !allow.some((d) => covers(host, d))) return `${host} isn't one of this teammate's sites (${allow.join(", ")}). Tell the person, or ask the owner to add it.`;
  return null;
}

export const webFetch: AgentTool = {
  name: "web_fetch",
  description: "Read one public web page's text through Otari (screened for injected instructions; a paid call). Use it for the one or two pages that answer the question, after web_search found them; prefer it to a scraper connector (Apify) for a single page. Never for internal docs (use their connectors), never to browse.",
  input_schema: object({ url: { type: "string", description: "The full https:// address." } }),
  kind: "read",
  authorize: (ctx, a) => siteRefusal(ctx, a.url),
  async run(ctx, a) {
    try {
      const r = await otari<any>("POST", "/fetch", { url: a.url, max_chars: 20_000, ...(ctx.endUser ? { user: ctx.endUser } : {}) });
      const final = r.data.final_url ?? a.url;
      const after = siteRefusal(ctx, final);
      if (after) return { text: `The page redirected to ${final}. ${after}`, isError: true };
      const text = `${r.data.title ? `# ${r.data.title}\n` : ""}${r.data.text ?? ""}${r.data.truncated ? "\n[truncated at 20,000 characters]" : ""}`;
      return { text, untrusted: `web:${final}`, data: { request_id: r.requestId, final_url: final, chars: text.length } };
    } catch (e) {
      const o = e as OtariError;
      return { text: `Couldn't read ${a.url}: ${o.message.replace(/^Otari POST \/fetch → /, "").slice(0, 300)}`, isError: true, data: { request_id: o.requestId } };
    }
  },
};

// web_search: the model chooses it (it isn't attached to every call). One small call with Otari's web search on,
// limited to the teammate's sites, answered as a list of results; the text is untrusted like any page.
// The org has no search tool for direct search: skip trying for a while.
let noSearchToolUntil = 0;
export const webSearchTool: AgentTool = {
  name: "web_search",
  description: "Search the public web through Otari (screened; a paid call). Use it when the answer lives outside the company and no connector has it: a competitor, a vendor's docs or pricing, news, a public fact. Prefer it to a scraper connector (Apify, Exa) for a plain search. Never for company data, and skip it when you already know the answer. Returns up to 5 results (title, link, one line); cite what you use.",
  input_schema: object({ query: { type: "string" } }),
  kind: "read",
  async run(ctx, a) {
    const { allowed_domains: allow, blocked_domains: block } = ctx.teammate.config.web;
    // Otari's direct search, when the org has a search tool set up (no model call, so no model can reword the
    // hits); otherwise its built-in web search inside one small model call, which needs no setup.
    if (Date.now() > noSearchToolUntil) {
      try {
        const r = await otari<any>("POST", "/search", { query: a.query, max_results: 5, ...(allow.length || block.length ? { search_domain_filter: [...allow, ...block.map((d: string) => `-${d}`)] } : {}), ...(ctx.endUser ? { user: ctx.endUser } : {}) });
        const hits: any[] = r.data?.results ?? r.data?.data ?? [];
        const text = hits.slice(0, 5).map((h) => `${h.title ?? h.url} — ${h.url ?? h.link} — ${String(h.snippet ?? h.content ?? h.description ?? "").replace(/\s+/g, " ").slice(0, 160)}`).join("\n") || "No results.";
        return { text, untrusted: "web:search", data: { request_id: r.requestId, via: "otari /search" } };
      } catch (e) {
        if (!/No search tools are configured/i.test((e as Error).message)) return { text: `Web search failed: ${(e as Error).message.slice(0, 200)}`, isError: true, data: { request_id: (e as OtariError).requestId } };
        noSearchToolUntil = Date.now() + 10 * 60_000;
      }
    }
    const tool: Record<string, unknown> = { type: "otari_web_search", ...(allow.length ? { allowed_domains: allow } : {}), ...(block.length ? { blocked_domains: block } : {}) };
    try {
      const r = await otari<any>("POST", "/chat/completions", {
        model: ctx.teammate.config.model.default, max_tokens: 600, temperature: 0, tools: [tool], ...(ctx.endUser ? { user: ctx.endUser } : {}),
        messages: [{ role: "user", content: `Search the web for: ${a.query}\nReply with up to 5 results, one per line: title — URL — one short line on what it says. Nothing else.` }],
      });
      const text = String(r.data?.choices?.[0]?.message?.content ?? "").trim() || "No results.";
      return { text, untrusted: "web:search", data: { request_id: r.requestId, cost_usd: r.data?.usage?.cost_usd ?? null } };
    } catch (e) {
      const o = e as OtariError;
      return { text: `Web search failed: ${o.message.slice(0, 200)}`, isError: true, data: { request_id: o.requestId } };
    }
  },
};


// run_code: a short Python snippet in Otari's code sandbox, chosen by the agent for the cases its own computer is
// the wrong tool for (quick exact math, a date calculation, parsing a pasted table). It is never attached to every
// model call: one small call with Otari's code tool, and its output comes back as the result.
export const runCodeTool: AgentTool = {
  name: "run_code",
  description: "Run a short Python snippet in Otari's code sandbox (a small paid call, no computer needed) and get what it prints. Use it when a conversation needs an exact figure and a slip would matter: money, credits, refunds, percentages, dates, a total from a pasted table. It is quicker than waking your computer for one calculation. For files, repos, data pulled from connectors, or anything with several steps, use your computer instead. Don't use it for numbers a source already gives you.",
  input_schema: object({ code: { type: "string", description: "Python 3 that prints its answer." } }),
  kind: "read",
  async run(ctx, a) {
    // Otari's direct code execution (POST /code/execute): no model call; one sandbox per session, kept between runs.
    const held = sandboxes.get(ctx.sessionId);
    try {
      const r = await otari<any>("POST", "/code/execute", { code: String(a.code).slice(0, 20_000), container: held ?? "auto", timeout_seconds: 30, ...(ctx.endUser ? { user: ctx.endUser } : {}) });
      const id = r.headers.get("otari-container-id"); if (id) sandboxes.set(ctx.sessionId, id);
      const out = [String(r.data?.stdout ?? "").trim(), r.data?.stderr ? `stderr: ${String(r.data.stderr).trim()}` : ""].filter(Boolean).join("\n") || "(no output)";
      return { text: `Ran in Otari's sandbox (exit ${r.data?.return_code ?? "?"}):\n${out.slice(0, 4000)}`, isError: r.data?.return_code ? r.data.return_code !== 0 : false, data: { request_id: r.requestId, container: id } };
    } catch (e) {
      if (held) sandboxes.delete(ctx.sessionId);
      return { text: `The sandbox didn't run it: ${(e as OtariError).message.slice(0, 300)}`, isError: true };
    }
  },
};
const sandboxes = new Map<string, string>(); // session → Otari container id

