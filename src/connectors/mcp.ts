// Connectors are MCP servers stored in Otari. Peeblo lists what a teammate may use, decides whether a call
// needs a person's yes, and then has Otari execute exactly that call (caller-orchestrated /mcp/execute with
// the server_revision seen at listing time, so a changed server config is refused rather than run).
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { otari } from "../otari/client.ts";
import type { TeammateConfig } from "../store/teammates.ts";

export type ConnectorTool = {
  name: string;          // what the model sees: <server>__<tool>
  server: string; serverId: string; revision: string;
  tool: string; description: string; inputSchema: Record<string, unknown>; readOnlyHint: boolean | null; // null: the server says nothing
};

const TTL = 30 * 60_000; // tool lists change rarely; a 409 on a stale revision refreshes the server
let servers: { at: number; list: { id: string; name: string; purpose_hint?: string }[] } | null = null;
const toolCache = new Map<string, { at: number; revision: string; tools: any[] }>();
// A copy on disk, so the first session after a restart doesn't wait ~30 s for ~28 servers. A stale entry is served
// while a fresh one loads; a call on a changed server is refused (409) and that server is re-read.
const CACHE_FILE = join(config.dataDir, "catalog-cache.json");
try {
  const saved = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as { servers?: { list: { id: string; name: string; purpose_hint?: string }[] }; tools?: [string, { at: number; revision: string; tools: any[] }][] };
  if (saved.servers?.list) servers = { list: saved.servers.list, at: 0 };
  for (const [id, e] of saved.tools ?? []) toolCache.set(id, { ...e, at: 0 });
} catch { /* no copy yet */ }
const saveCache = () => { try { writeFileSync(CACHE_FILE, JSON.stringify({ servers, tools: [...toolCache] })); } catch { /* best effort */ } };
const refreshing = new Set<string>();

export async function serverList() {
  if (servers && Date.now() - servers.at < TTL) return servers.list;
  if (servers && !refreshing.has("servers")) {
    refreshing.add("servers");
    void otari<{ servers: any[] }>("GET", "/mcp/servers").then(({ data }) => { servers = { at: Date.now(), list: data.servers ?? [] }; saveCache(); }).catch(() => {}).finally(() => refreshing.delete("servers"));
    return servers.list;
  }
  const { data } = await otari<{ servers: { id: string; name: string; purpose_hint?: string }[] }>("GET", "/mcp/servers");
  servers = { at: Date.now(), list: data.servers ?? [] };
  return servers.list;
}

async function serverTools(id: string, fresh = false) {
  const hit = toolCache.get(id);
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit;
  if (!fresh && hit) {
    if (!refreshing.has(id)) { refreshing.add(id); void serverTools(id, true).catch(() => {}).finally(() => refreshing.delete(id)); }
    return hit;
  }
  const { data } = await otari<{ server_revision: string; tools: any[] }>("GET", `/mcp/servers/${id}/tools`);
  const entry = { at: Date.now(), revision: data.server_revision, tools: data.tools ?? [] };
  toolCache.set(id, entry);
  saveCache();
  return entry;
}

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");

// Tools a server always refuses ("not available due to compliance requirements"): noted once, then not offered.
const UNAVAILABLE_FILE = join(config.dataDir, "unavailable-tools.json");
const unavailable = new Set<string>((() => { try { return JSON.parse(readFileSync(UNAVAILABLE_FILE, "utf8")) as string[]; } catch { return []; } })());
export function markUnavailable(server: string, tool: string): void {
  unavailable.add(`${server}.${tool}`);
  try { writeFileSync(UNAVAILABLE_FILE, JSON.stringify([...unavailable])); } catch { /* best effort */ }
}
export const ALWAYS_REFUSES = /not available due to compliance|this tool is (disabled|not enabled)|tool is not available (for|on) (this|your) (plan|account|workspace)/i;

// The tools of every connector the teammate has, as Otari authorizes them for Peeblo's key.
export async function catalogFor(c: TeammateConfig): Promise<{ tools: ConnectorTool[]; missing: string[]; failed: string[] }> {
  if (!c.connectors.length) return { tools: [], missing: [], failed: [] };
  const list = await serverList();
  // "all" (Peeblo, the chief of staff): every MCP server connected in Otari. Their tools start deferred; writes
  // still go through the gate like anyone's.
  if (c.connectors.includes("all")) c = { ...c, connectors: [...new Set([...c.connectors.filter((x) => x !== "all"), ...list.map((x) => x.name)])] };
  const tools: ConnectorTool[] = [];
  const missing: string[] = [];
  const failed: string[] = [];
  // Servers are read in parallel (Peeblo's "all" is ~28 servers; one by one took ~40 s cold).
  const found = c.connectors.map((name) => ({ name, s: list.find((x) => x.name === name) }));
  for (const f of found) if (!f.s) missing.push(f.name);
  const loaded = await Promise.all(found.filter((f) => f.s).map(async (f) => ({ f, t: await serverTools(f.s!.id).catch(() => null) })));
  for (const { f, t } of loaded) {
    const s = f.s!;
    if (!t) { failed.push(f.name); continue; }
    for (const tool of t.tools) {
      if (unavailable.has(`${s.name}.${tool.name}`)) continue;
      tools.push({
        name: `${safe(s.name)}__${safe(tool.name)}`.slice(0, 64), server: s.name, serverId: s.id, revision: t.revision,
        tool: tool.name, description: `[${s.name}] ${tool.description ?? tool.name}`.slice(0, 1024),
        inputSchema: tool.input_schema ?? { type: "object", properties: {} }, readOnlyHint: typeof tool.annotations?.readOnlyHint === "boolean" ? tool.annotations.readOnlyHint : null,
      });
    }
  }
  return { tools, missing, failed };
}

// Whether a call runs at once or waits for a person. A server's own annotations are untrusted (Otari says
// so too), so "auto" only runs tools that both look like reads by name and say they are read-only.
export type CallKind = "read" | "write" | "destructive";
const READ_WORDS = new Set(["get", "list", "search", "read", "fetch", "query", "describe", "retrieve", "find", "lookup", "count", "show", "view", "help", "tools", "info", "schema", "learn", "all",
  "chart", "charts", "render", "metrics", "stats", "logs", "availability", "insights", "report", "reports", "analytics", "inspect", "whoami", "ping", "discover", "analyze", "history", "timeline", "status"]);
// Words that make a call a write even when the server calls it read-only (a server's hint never makes a call safer
// on its own; it can only confirm a name that says nothing about writing).
const NEVER_READ = /(submit|invoke|feedback|trigger|run_|execute(?!read)|send|pay|charge)/i;
// Word lists, matched against whole words of the tool's name (snake, kebab or camel case), never substrings:
// "list_postgres_roles" is a read, not a "post".
const WRITE = new Set(["create", "update", "updates", "write", "save", "set", "add", "post", "send", "push", "merge", "edit", "upsert", "insert", "execute", "trigger", "publish", "invite", "assign", "upload", "submit", "invoke", "run", "pay", "charge", "move", "rename", "enable", "disable", "toggle", "import", "sync", "comment", "reply", "close", "resolve", "acknowledge", "snooze", "transfer", "duplicate", "copy", "generate"]);
const DESTRUCTIVE = new Set(["delete", "remove", "drop", "destroy", "refund", "cancel", "archive", "revoke", "purge", "truncate", "reset", "void", "unpublish", "disconnect"]);
const READ_VERBS = new Set(["get", "list", "search", "read", "fetch", "query", "describe", "retrieve", "find", "lookup", "count", "show", "view", "chart", "render", "inspect", "analyze", "discover", "whoami", "ping"]);
const wordsOf = (name: string) => name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().split(/[_\-\s.]+/).filter(Boolean);
const WRITE_WORDS = { test: (name: string) => wordsOf(name).some((w) => WRITE.has(w)) };
const DESTRUCTIVE_WORDS = { test: (name: string) => wordsOf(name).some((w) => DESTRUCTIVE.has(w)) };

// What a tool name suggests. A destructive word anywhere wins; a name that starts with a read verb is a read
// ("get_status_updates", "list_alert_grouping_settings"); otherwise a write word makes it a write; unknown counts as a write.
function kindOfName(name: string): CallKind {
  const words = wordsOf(name);
  if (words.some((w) => DESTRUCTIVE.has(w))) return "destructive";
  if (READ_VERBS.has(words[0])) return "read";
  if (words.some((w) => WRITE.has(w))) return "write";
  return words.some((w) => READ_WORDS.has(w)) ? "read" : "write";
}

// PostHog's MCP is "code mode": one tool, exec, whose command picks the real tool ("call <tool> <json>").
// Its discovery commands are reads; a call is as risky as the tool it names.
function posthogExecKind(command: string): CallKind {
  const [verb, tool] = command.trim().split(/\s+/);
  if (verb !== "call") return ["help", "tools", "search", "info", "schema", "learn"].includes(verb) ? "read" : "write";
  return tool ? kindOfName(tool) : "write";
}

// The kind of this exact call. A server's own readOnlyHint is untrusted, so it can only make a call look
// riskier, never safer: a read by name that the server says is not read-only counts as a write.
export function classify(t: ConnectorTool, args: Record<string, unknown>): CallKind {
  if (t.server === "posthog" && t.tool === "exec" && typeof args.command === "string") return posthogExecKind(args.command);
  const k = kindOfName(t.tool);
  if (k === "read" && t.readOnlyHint === false) return "write";
  // A tool whose name has no write words (it was "write" only because no read word matched) and that its server
  // marks read-only is a read: Better Stack's incidents and monitors, Neon's list_*, Stripe's reports.
  if (k === "write" && t.readOnlyHint === true && !WRITE_WORDS.test(t.tool) && !DESTRUCTIVE_WORDS.test(t.tool) && !NEVER_READ.test(t.tool)) return "read";
  return k;
}

// Repositories, projects and the like a teammate may touch, per connector (connector_scopes in its config).
// A call that names something outside its scope is refused before anyone is asked.
export function outOfScope(t: ConnectorTool, args: Record<string, unknown>, scopes: Record<string, string[]>): string | null {
  const allowed = scopes[t.server];
  if (!allowed?.length) return null;
  if (t.server === "github" && typeof args.owner === "string" && typeof args.repo === "string") {
    const full = `${args.owner}/${args.repo}`.toLowerCase();
    const glob = (p: string) => new RegExp(`^${p.toLowerCase().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
    const ok = allowed.some((p) => glob(p).test(full));
    return ok ? null : `${full} is not one of the repositories this teammate may use (${allowed.join(", ")})`;
  }
  return null;
}

export function needsApproval(mode: TeammateConfig["mode"], kind: CallKind): boolean {
  if (mode === "yolo") return false;
  if (mode === "ask") return true;
  if (mode === "trusted") return kind === "destructive";
  return kind !== "read";
}

export async function executeTool(t: ConnectorTool, args: Record<string, unknown>): Promise<{ data: any; requestId: string | null }> {
  const body = { mcp_server_id: t.serverId, server_revision: t.revision, tool_name: t.tool, arguments: args, client_execution_id: randomUUID() };
  return otari("POST", "/mcp/execute", body);
}

// After a refusal for a stale revision, the catalog is re-read so the next listing is current.
export function forgetServer(serverId: string): void {
  toolCache.delete(serverId);
}

// Loads every server's tool list once at start (and every 25 min), so the first session isn't the one waiting.
export function warmCatalog(): void {
  const warm = () => void serverList().then((l) => Promise.all(l.map((x) => serverTools(x.id, true).catch(() => null)))).catch(() => {});
  warm();
  setInterval(warm, 25 * 60_000).unref();
}
