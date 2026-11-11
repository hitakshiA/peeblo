// What a tool result looks like to the model: the short summary on the task card, the text of an MCP result, a long
// result saved on the computer with its key fields shown, a list cut mid-record salvaged, the notes and hints about
// each connection, and which sources count as outside text.
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { computerTools } from "../agent-tools/computer.ts";
import type { ToolContext, ToolResult } from "../agent-tools/types.ts";
import { catalogFor, executeTool, type ConnectorTool } from "../connectors/mcp.ts";
import { companyDir } from "../memory/store.ts";
import { getTeammate } from "../store/teammates.ts";

// What a task card shows under a finished tool: a short result, from the tool's own output.
export function summarize(text: string): string {
  const t = text.trim();
  try {
    const j = JSON.parse(t);
    const list = Array.isArray(j)
      ? j
      : Array.isArray(j?.results)
        ? j.results
        : Array.isArray(j?.items)
          ? j.items
          : Array.isArray(j?.issues)
            ? j.issues
            : Array.isArray(j?.data)
              ? j.data
              : Array.isArray(j?.nodes)
                ? j.nodes
                : null;
    if (list) return `${list.length} result${list.length === 1 ? "" : "s"}`;
    // One record: its id and title, the way a person would name it ("GRO-331 · Pricing page footer…").
    if (j && typeof j === "object") {
      const name = [j.identifier ?? j.id ?? j.number ?? j.key, j.title ?? j.name ?? j.subject ?? j.summary]
        .filter((x) => typeof x === "string" || typeof x === "number")
        .join(" · ");
      if (name) return name.length > 80 ? `${name.slice(0, 79)}…` : name;
    }
  } catch {
    /* not JSON */
  }
  const first = t.split(/\n/).find((l) => l.trim()) ?? "";
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}
// Web addresses in a result, for the card's sources (at most 5).
export function urlsIn(text: string): string[] {
  return [...new Set((text.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? []).map((u) => u.replace(/[.,;]+$/, "")))].slice(0, 5);
}

export function mcpText(data: any): { text: string; isError: boolean } {
  // /mcp/execute answers with the MCP tool result; keep its text blocks, else the JSON.
  const r = data?.result ?? data;
  const blocks = Array.isArray(r?.content) ? r.content : null;
  const text = blocks ? blocks.map((b: any) => (b?.type === "text" ? b.text : JSON.stringify(b))).join("\n") : JSON.stringify(r);
  return { text: text.slice(0, MAX_RESULT), isError: r?.isError === true || data?.is_error === true };
}

// A connector result longer than this is saved on the agent's computer; the model gets the start, a count and the path.
export const RESULT_CAP = 16_000;
// The most of one connector result Peeblo keeps (about 1 MB); Otari sends results whole.
export const MAX_RESULT = 1_000_000;

// Where a vendor tool is the wrong road for a common question, the right one, in front of the model: in the tool's
// description and in its error. (Stripe's analytics needs Sigma access many accounts don't have.)
const TOOL_HINTS: Record<string, string> = {
  "apify:apify--web-search":
    "For a plain web search, web_search is cheaper and screened; use this only for what it can't do (many results, a specific engine).",
  "apify:apify--web-fetch":
    "For one public page, web_fetch is cheaper and screened; use this only to scrape many pages or a page web_fetch can't read.",
  "stripe:stripe_analytics":
    'For MRR, active customers or subscription counts, don\'t wait on this tool: list active subscriptions with stripe_api_read (stripe_api_operation_id "GetSubscriptions", parameters {"status": "active", "limit": 40, "starting_after": "<last id>"}, every page until has_more is false) and add them up on your computer.',
};
// Connection facts per server: ids the model would otherwise guess (vendors answer a wrong id with a misleading
// auth error), plan limits, and the query shapes that work.
// Two layers, read fresh each minute: what ships with Peeblo for that vendor
// (config/connections/<server>.md, generic quirks), this workspace's company memory (connections/<server>.md: ids,
// plan limits, lessons the crew learned; changed by talking, approved by an admin).
let notes: { at: number; v: Record<string, string> } = { at: 0, v: {} };
const body = (file: string) => {
  try {
    return readFileSync(file, "utf8")
      .replace(/^---[\s\S]*?---\n/, "")
      .trim();
  } catch {
    return "";
  }
};
export function serverNote(server: string): string {
  if (Date.now() - notes.at > 60_000) notes = { at: Date.now(), v: {} };
  if (notes.v[server] !== undefined) return notes.v[server];
  const shipped = body(join(import.meta.dirname, "..", "..", "config", "connections", `${server}.md`));
  const company = body(join(companyDir(), "connections", `${server}.md`));
  notes.v[server] = [shipped, company].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return notes.v[server];
}
export const hintFor = (server: string, tool: string) =>
  [
    serverNote(server) &&
      `About this connection: ${serverNote(server)} Use any ids given here exactly, never a guess; if you learn something lasting about it, propose it for company memory connections/${server}.`,
    TOOL_HINTS[`${server}:${tool}`],
  ]
    .filter(Boolean)
    .join(" ");

// A JSON list cut mid-record (a result over MAX_RESULT): the complete records before the cut,
// as {"data": [...], "has_more": true}. Null when the text isn't the start of a JSON list.
export function salvageList(text: string): { data: any[]; has_more: true } | null {
  const at = text.search(/\[\s*\{/);
  if (at < 0) return null;
  const out: any[] = [];
  let depth = 0,
    start = -1,
    inStr = false,
    esc = false;
  for (let i = at + 1; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth++ === 0) start = i;
    } else if (c === "}") {
      if (--depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          break;
        }
        start = -1;
      }
    } else if (c === "]" && depth === 0) break;
  }
  return out.length ? { data: out, has_more: true } : null;
}

// How many records a JSON result holds: the longest array at the top or one level down.
export function recordCount(text: string): number | null {
  try {
    const v = JSON.parse(text);
    const arrays = Array.isArray(v) ? [v] : v && typeof v === "object" ? Object.values(v).filter(Array.isArray) : [];
    return arrays.length ? Math.max(...arrays.map((a) => (a as unknown[]).length)) : null;
  } catch {
    return null;
  }
}

// The key fields of each record, one line each (up to 40), so the summary is usually enough to answer from.
const KEY_FIELDS = [
  "identifier",
  "key",
  "number",
  "id",
  "full_name",
  "name",
  "title",
  "subject",
  "state",
  "status",
  "email",
  "amount",
  "currency",
  "created_at",
  "createdAt",
  "updated_at",
  "html_url",
  "url",
];
export function compactList(text: string): string | null {
  let v: any;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const arr: any[] | undefined = Array.isArray(v)
    ? v
    : v && typeof v === "object"
      ? (Object.values(v).filter(Array.isArray) as any[][]).sort((a, b) => b.length - a.length)[0]
      : undefined;
  if (!arr?.length || typeof arr[0] !== "object") return null;
  const meta =
    v && !Array.isArray(v)
      ? Object.entries(v)
          .filter(([, x]) => typeof x !== "object")
          .map(([k, x]) => `${k}: ${x}`)
          .join(", ")
      : "";
  const money = (o: any) => {
    const item = o?.items?.data?.[0];
    const price = item?.price ?? o?.price ?? o?.plan;
    const bits: string[] = [];
    if (price?.unit_amount ?? price?.amount) bits.push(`price=${price.unit_amount ?? price.amount}`);
    if (price?.currency && !o?.currency) bits.push(`currency=${price.currency}`);
    const iv = price?.recurring?.interval ?? price?.interval;
    if (iv)
      bits.push(
        `interval=${iv}${(price?.recurring?.interval_count ?? price?.interval_count ?? 1) > 1 ? `×${price.recurring?.interval_count ?? price.interval_count}` : ""}`,
      );
    const q = item?.quantity ?? o?.quantity;
    if (q !== undefined && q !== null) bits.push(`quantity=${q}`);
    if (o?.discount?.coupon?.percent_off ?? o?.discounts?.[0]?.coupon?.percent_off)
      bits.push(`percent_off=${o.discount?.coupon?.percent_off ?? o.discounts[0].coupon.percent_off}`);
    if (typeof o?.customer === "string") bits.push(`customer=${o.customer}`);
    return bits;
  };
  const line = (o: any) =>
    [
      ...KEY_FIELDS.filter((f) => o?.[f] !== undefined && o[f] !== null && typeof o[f] !== "object").map(
        (f) => `${f}=${String(o[f]).slice(0, 90)}`,
      ),
      ...money(o),
    ]
      .join(" · ")
      .slice(0, 320);
  const lines = arr.slice(0, 40).map((o, i) => `${i + 1}. ${line(o)}`);
  return `${meta ? `${meta}\n` : ""}${lines.join("\n")}${arr.length > 40 ? `\n… and ${arr.length - 40} more` : ""}`;
}

// A long connector result goes to a file on the agent's own computer. The model reads the
// start, the record count and the path, and works on the file there with computer_bash when it needs the rest.
export async function capResult(
  ctx: ToolContext,
  t: ConnectorTool,
  r: ToolResult,
  callId: string,
): Promise<ToolResult & { chars: number; saved?: string }> {
  const chars = r.text.length;
  // Otari's web firewall answers some request shapes with a bare nginx 403 page (no request id): a filter, not a
  // permission problem. Seen on SQL with comments or a sub-select inside the select list.
  if (r.isError && /403/.test(r.text) && /<html|nginx|403 Forbidden<\/title>/i.test(r.text)) {
    return { ...r, chars, text: firewallHint(t) };
  }
  if (r.isError && hintFor(t.server, t.tool)) return { ...r, chars, text: `${r.text}\n[peeblo: ${hintFor(t.server, t.tool)}]` };
  if (r.isError || chars <= RESULT_CAP) return { ...r, chars };
  // Over MAX_RESULT, Peeblo kept only the start: keep the records that are whole.
  const over = chars >= MAX_RESULT;
  let salvaged: ReturnType<typeof salvageList> = null;
  if (over && recordCount(r.text) === null) salvaged = salvageList(r.text);
  if (salvaged) r = { ...r, text: JSON.stringify(salvaged) };
  const n = recordCount(r.text);
  const head = compactList(r.text) ?? r.text.slice(0, 3000);
  const path = `/work/${ctx.sessionId}/results/${t.server}-${t.tool}-${callId.slice(-8)}.${n === null ? "txt" : "json"}`;
  const write = computerTools.find((x) => x.name === "computer_write");
  try {
    const w = write ? await write.run(ctx, { path, content: r.text }) : { text: "no computer", isError: true };
    if (w.isError) throw new Error(w.text);
    // Say when the result was too big to keep whole, or the model works on half a list without knowing.
    const max = MAX_RESULT.toLocaleString("en-US");
    let cut = "";
    if (salvaged)
      cut = ` This result was over ${max} characters, so Peeblo kept only the start: the ${n} complete records in it are below and in the file (valid JSON), the rest are missing. Before you total anything, get the rest: ask for smaller pages (a lower limit, then its cursor or starting_after the last id), and add them up together.`;
    else if (over && n === null) {
      try {
        JSON.parse(r.text);
      } catch {
        cut = ` This result was over ${max} characters, so Peeblo kept only the start and the file ends mid-record. Ask again for fewer records or only the fields you need (a limit, a page, a properties list) before you count anything.`;
      }
    }
    return {
      ...r,
      chars,
      saved: path,
      text: `${head}\n…\n[peeblo:${cut} ${over ? "what was kept" : "the full result"} is ${chars.toLocaleString("en-US")} characters${n !== null ? `, ${n} records` : ""}, saved on your computer at ${path}. The lines above are every record's key fields; answer from them when they're enough, and open the file (computer_bash with jq) only for a field they don't show.]`,
    };
  } catch {
    return {
      ...r,
      chars,
      text: `${r.text.slice(0, RESULT_CAP)}\n…\n[peeblo: cut at ${RESULT_CAP.toLocaleString("en-US")} of ${chars.toLocaleString("en-US")} characters${n !== null ? ` (${n} records)` : ""}. Ask for fewer fields or a smaller page.]`,
    };
  }
}

// The repos an unscoped GitHub connection can see, read once every 30 minutes (get_me, then one search), so agents
// use exact owner/repo names instead of guessing. It never blocks a session start: until the first read lands (it's
// warmed when core starts), the tools carry the "find the owner first" line instead.
let ghSeen: { at: number; text: string } | null = null;
// biome-ignore lint/correctness/noUnusedVariables: read by ??= below, so only one read runs at a time
let ghLoading: Promise<string> | null = null;
export async function githubVisible(tools: ConnectorTool[]): Promise<string> {
  const me = tools.find((t) => t.server === "github" && t.tool === "get_me");
  const search = tools.find((t) => t.server === "github" && t.tool === "search_repositories");
  if (!me || !search) return "";
  if (ghSeen && Date.now() - ghSeen.at < 30 * 60_000) return ghSeen.text;
  ghLoading ??= (async () => {
    const who = JSON.parse(mcpText((await executeTool(me, {})).data).text);
    const login = String(who.login ?? who.user?.login ?? "");
    if (!login) return "";
    const found = JSON.parse(
      mcpText((await executeTool(search, { query: `user:${login} fork:true`, sort: "updated", perPage: 30 })).data).text,
    );
    const names = (found.items ?? found.repositories ?? found ?? [])
      .map((x: any) => x.full_name ?? x.fullName ?? (x.owner?.login && x.name ? `${x.owner.login}/${x.name}` : null))
      .filter(Boolean);
    ghSeen = { at: Date.now(), text: names.slice(0, 30).join(", ") };
    return ghSeen.text;
  })()
    .catch(() => ghSeen?.text ?? "")
    .finally(() => {
      ghLoading = null;
    });
  return ghSeen?.text ?? "";
}
export async function warmGithubVisible(): Promise<void> {
  const peeblo = await getTeammate("peeblo");
  if (peeblo) await githubVisible((await catalogFor(peeblo.config)).tools).catch(() => "");
}

// Otari's web firewall answers some request shapes with a bare nginx 403 page: a filter on the request's content,
// not a permission problem. Seen on SQL (comments, sub-selects in the select list) and on HTML email bodies.
export function firewallHint(t: { server: string; tool: string }): string {
  return `A gateway filter in front of ${t.server} blocked this request's shape before it reached the service (not a permission problem, and nothing ran). Rewrite it more simply and try once more: for SQL, no comments (-- or /* */), no sub-selects inside the select list, no UNION, split into two plain queries if needed; for an email or page body, send plain text (the text field) with no HTML tags or <!DOCTYPE>. If it's blocked again, say the gateway refused it and stop.${hintFor(t.server, t.tool) ? ` ${hintFor(t.server, t.tool)}` : ""}`;
}

// Sources whose text comes from outside the company, so a guard model checks it for injected instructions.
// GitHub issues and comments, Jira service-desk tickets and Sentry error payloads are written by people outside the
// team too, so they count as outside text.
export const OUTSIDE =
  /^(web:|file:|computer:network|slack:|mcp:(intercom|freshdesk|zendesk|apify|exa|deepwiki|context7|gmail|hubspot|github|atlassian|sentry)\.)/;
