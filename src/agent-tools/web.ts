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
  description: "Read one web page (its text). For finding pages, use web_search first.",
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
export const webSearchTool: AgentTool = {
  name: "web_search",
  description: "Search the public web. Returns up to 5 results (title, link, one line). Cite what you use.",
  input_schema: object({ query: { type: "string" } }),
  kind: "read",
  async run(ctx, a) {
    const { allowed_domains: allow, blocked_domains: block } = ctx.teammate.config.web;
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
