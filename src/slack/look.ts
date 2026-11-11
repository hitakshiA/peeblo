// The words and small pieces of a reply, matched to the landing page: steps as a past-tense verb
// plus the service ("Read Linear", "Searched GitHub", "Updated Google Sheets"), a short result in words ("3 issues"),
// a one-line summary when done ("Read Linear, searched GitHub"), and the receipt chip (model logo, readable model
// name, provider, calls, cost). Code draws all of it; the model never writes a receipt.
import { config } from "../config.ts";
import type { Receipt } from "../runs/receipts.ts";

const SERVICES: Record<string, string> = {
  linear: "Linear", github: "GitHub", posthog: "PostHog", stripe: "Stripe", supabase: "Supabase", intercom: "Intercom",
  atlassian: "Jira", neon: "Neon", airtable: "Airtable", monday: "monday.com", postman: "Postman", sanity: "Sanity",
  upstash: "Upstash", betterstack: "Better Stack", resend: "Resend", notion: "Notion", cloudflare: "Cloudflare",
  zapier: "Zapier", apify: "Apify", context7: "Context7", exa: "Exa", hubspot: "HubSpot", sheets: "Google Sheets",
  grafana: "Grafana", pagerduty: "PagerDuty", freshdesk: "Freshdesk", sentry: "Sentry", deepwiki: "DeepWiki", slack: "Slack",
};
export const serviceName = (server: string) => SERVICES[server] ?? server.charAt(0).toUpperCase() + server.slice(1);

// Atlassian covers Jira and Confluence: the tool says which.
export const atlassianName = (tool: string) => (/confluence|page|space/i.test(tool) ? "Confluence" : "Jira");

// "Read Linear", "Searched GitHub", "Updated Google Sheets", from the tool's own words.
export function stepTitle(tool: string, d: { command?: string; kind?: string; callee?: string } = {}): string | null {
  const own: Record<string, string | null> = {
    memory_read: "Checked memory", memory_search: "Searched memory", memory_write: "Saved a note", recall: "Checked past work",
    crew_status: "Checked the crew", job: "Checked the job", web_search: "Searched the web", web_fetch: "Read a web page",
    browser_read: "Read a web page", browser_act: "Used a web page", computer_read: "Read a file", computer_write: "Wrote a file",
    computer_edit: "Edited a file", repo_open: "Opened the repo", repo_publish: "Opened a pull request", subagent: "Asked a helper",
    ask_teammate: d.callee ? `Asked ${cap(d.callee)}` : "Asked a teammate", ask_human: "Asked a question", teammate_hire: "Drafted a hire",
    teammate_update: "Changed a teammate", teammate_retire: "Retired a teammate", recipe_propose: "Proposed a setup change", schedule: "Set up a schedule", watch: "Set up a watch",
    company_memory_propose: "Proposed a company note", models_list: "Looked up models", price_estimate: "Estimated a price",
    canvas_write: "Wrote a canvas", show_data: "Drew it up", skill_save: "Saved a skill", channel_watch: "Changed what it watches",
    // Not steps: the reply itself, the plan, reading a skill, and a hand-off (its own line says who has it).
    slack_post: null, slack_react: null, plan: null, read_skill: null, find_tools: null, use_tool: null, delegate: null,
  };
  if (tool in own) return own[tool];
  // Code work reads like the landing page, never the command itself.
  if (tool === "computer_job") return "Checked a background job";
  if (tool === "computer_bash") return /\b(pytest|npm test|jest|vitest|go test|cargo test)\b/.test(String(d.command ?? "")) ? "Ran the tests" : "Worked it out on its computer";
  const [server, action = ""] = tool.split("__");
  if (!action) return cap(tool.replace(/_/g, " "));
  const svc = server === "atlassian" ? atlassianName(action) : serviceName(server);
  if (/pull_request/.test(action) && /^create/.test(action)) return "Opened a pull request";
  if (/^(search|find|query)/.test(action) || /_search$/.test(action)) return `Searched ${svc}`;
  // A read verb as a whole word anywhere (stripe_api_read, hubspot-list-objects) is a read.
  if (/^(list|get|read|fetch|retrieve|describe|show|view|count|lookup)/.test(action) || /(^|[_-])(read|list|get|fetch|retrieve)([_-]|$)/.test(action) || action === "exec" && d.kind === "read") return `Read ${svc}`;
  if (/refund/.test(action)) return `Refunded in ${svc}`;
  if (/^(delete|remove|archive|cancel|close)/.test(action)) return `Changed ${svc}`;
  if (/comment/.test(action)) return `Commented in ${svc}`;
  if (/^(send)/.test(action)) return `Sent from ${svc}`;
  // Only a call known to write is labelled a change; a repeat or refusal carries no kind.
  return d.kind === "write" ? `Updated ${svc}` : d.kind === "read" || !d.kind ? `Read ${svc}` : `Updated ${svc}`;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// The result in words: "3 issues" rather than "3 results"; a record's name; never JSON or paths.
export function stepOutput(tool: string, summary: string | undefined, listed = 0): string | undefined {
  if (!summary) return undefined;
  // Peeblo's own tools: a count in words, or nothing (their text is for the model, not the person).
  if (!tool.includes("__")) {
    const lines = listed;
    if (tool === "crew_status") return lines ? `${lines} teammate${lines === 1 ? "" : "s"}` : undefined;
    if (tool === "memory_search" || tool === "recall") return lines ? `${lines} note${lines === 1 ? "" : "s"}` : undefined;
    if (tool === "web_search") return lines ? `${lines} result${lines === 1 ? "" : "s"}` : undefined;
    return undefined;
  }
  const n = /^(\d+) results?$/.exec(summary.trim());
  if (n) {
    const count = Number(n[1]);
    const noun = nounOf(tool, count);
    return noun ? `${count} ${noun}` : `${count} found`;
  }
  const s = summary.trim();
  if (/^[[{]/.test(s) || /\/work\/|\/Users\/|[a-z]+__[a-z]/.test(s) || /^\[(company|team|you)\]/.test(s) || /^[a-z][A-Za-z_]*: /.test(s) || /^[0-9a-f-]{20,}$/.test(s)) return undefined;
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
}
function nounOf(tool: string, count: number): string | null {
  const action = tool.split("__")[1] ?? "";
  const m = /^(?:list|search|get|find|query|fetch|retrieve)_(.+)$/.exec(action);
  if (!m) return null;
  let noun = m[1].replace(/_/g, " ").replace(/^(my |all |recent )/, "");
  if (count === 1) noun = noun.replace(/ies$/, "y").replace(/(s)$/, "");
  else if (!/s$/.test(noun)) noun = `${noun}s`;
  return noun.length <= 24 ? noun : null;
}

// "Read Linear, searched GitHub": the step verbs, the first capitalised, the rest lowercase.
export function summaryLine(titles: string[]): string {
  const uniq = [...new Set(titles)].slice(0, 4);
  return uniq.map((t, i) => (i === 0 ? t : t.charAt(0).toLowerCase() + t.slice(1))).join(", ");
}

// Readable model names, the same set as the landing page.
const MODELS: [RegExp, string, string][] = [
  [/deepseek-v4\.1-flash/i, "DeepSeek V4.1 Flash", "deepseek"], [/deepseek-v4-pro/i, "DeepSeek V4 Pro", "deepseek"],
  [/kimi-k3\.1-pro/i, "Kimi K3.1 Pro", "kimi"], [/kimi-k3/i, "Kimi K3", "kimi"], [/glm-5\.3/i, "GLM-5.3", "zhipu"], [/qwen3\.8-27b/i, "Qwen3.8 27B", "qwen"],
  [/minimax-m3\.1-flash/i, "MiniMax M3.1 Flash", "minimax"], [/minimax-m3/i, "MiniMax M3", "minimax"], [/nemotron-3-ultra/i, "Nemotron 3 Ultra", "nvidia"], [/mimo-v2\.6-pro/i, "MiMo V2.6 Pro", ""],
];
export function readableModel(id: string): { name: string; logo: string | null } {
  const hit = MODELS.find(([re]) => re.test(id));
  if (hit) return { name: hit[1], logo: hit[2] && config.publicUrl ? `${config.publicUrl}/models/${hit[2]}.png` : null };
  const short = id.split("/").pop() ?? id;
  return { name: short.replace(/-\d{4}$/, "").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), logo: null };
}
// A teammate's model in words: a role policy reads as the model it runs ("DeepSeek V4.1 Flash"), never "peeblo-worker".
export async function modelLabel(id: string): Promise<string> {
  const { ROLES } = await import("../otari/routing.ts");
  return readableModel(ROLES[id]?.default ?? id).name;
}
const PROVIDERS: Record<string, string> = { deepinfra: "DeepInfra", together: "Together", fireworks: "Fireworks", nebius: "Nebius", novita: "Novita", mistral: "Mistral", bedrock: "Bedrock", groq: "Groq", cerebras: "Cerebras", baseten: "Baseten", parasail: "Parasail" };
export const readableProvider = (p: string) => PROVIDERS[p.toLowerCase()] ?? cap(p);

// Money: $0.01 or more gets 2 decimals; below that at most 4 decimal places, and tiny costs keep one digit ($0.00007).
export function money(usd: number): string {
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  if (usd >= 0.0001) return `$${String(Number(usd.toFixed(4)))}`;
  if (usd > 0) return `$${Number(usd.toPrecision(1)).toFixed(10).replace(/0+$/, "")}`;
  return "$0";
}

// The chip: one context block shaped like receipt.tsx. No calls means no chip, only "Nothing was charged."
export function receiptChip(r: Receipt | null): any {
  if (!r || r.calls === 0) return { type: "context", elements: [{ type: "mrkdwn", text: "Nothing was charged." }] };
  const models = r.models.map(readableModel);
  const first = models[0] ?? { name: "a model", logo: null };
  const rest = [...(r.providers.length ? [`via ${readableProvider(r.providers[0])}`] : []), `${r.calls} call${r.calls === 1 ? "" : "s"}`,
    // Otari's fallback, said whenever it happened (the served model may be the only one on the receipt).
    ...(r.fallbacks ? [models[1] ? `fell back to ${models[1].name}` : `Otari's fallback answered ${r.fallbacks === 1 ? "once" : `${r.fallbacks} times`}`] : []), money(r.cost_usd)];
  // One text element after the logo, as receipt.tsx draws it: "*DeepSeek V4.1 Flash*  via DeepInfra · 6 calls · $0.0017".
  return { type: "context", elements: [...(first.logo ? [{ type: "image", image_url: first.logo, alt_text: first.name }] : []), { type: "mrkdwn", text: `*${first.name}*  ${rest.join(" · ")}` }] };
}

// A service's brand mark on a light rounded tile (as on the landing page), served by Peeblo; else its favicon.
const TILES = new Set(["linear", "github", "posthog", "stripe", "hubspot", "notion", "intercom", "sheets", "supabase", "atlassian", "neon", "airtable", "monday", "betterstack", "cloudflare", "exa", "grafana", "pagerduty", "freshdesk", "sentry", "slack", "sanity", "upstash", "resend", "zapier", "apify", "postman", "deepwiki", "context7"]);
export function serviceIcon(server: string): string | null {
  if (TILES.has(server) && config.publicUrl) return `${config.publicUrl}/services/${server}.png`;
  return null;
}
