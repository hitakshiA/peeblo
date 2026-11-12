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
  name: string; // what the model sees: <server>__<tool>
  server: string;
  serverId: string;
  revision: string;
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnlyHint: boolean | null; // null: the server says nothing
  serverReadOnly?: boolean; // every tool on this server only reads (a registered read-only bridge, or nothing on it writes)
};

const TTL = 30 * 60_000; // tool lists change rarely; a 409 on a stale revision refreshes the server
let servers: { at: number; list: { id: string; name: string; purpose_hint?: string }[] } | null = null;
const toolCache = new Map<string, { at: number; revision: string; tools: any[] }>();
// A copy on disk, so the first session after a restart doesn't wait ~30 s for ~28 servers. A stale entry is served
// while a fresh one loads; a call on a changed server is refused (409) and that server is re-read.
const CACHE_FILE = join(config.dataDir, "catalog-cache.json");
try {
  const saved = JSON.parse(readFileSync(CACHE_FILE, "utf8")) as {
    servers?: { list: { id: string; name: string; purpose_hint?: string }[] };
    tools?: [string, { at: number; revision: string; tools: any[] }][];
  };
  if (saved.servers?.list) servers = { list: saved.servers.list, at: 0 };
  for (const [id, e] of saved.tools ?? []) toolCache.set(id, { ...e, at: 0 });
} catch {
  /* no copy yet */
}
const saveCache = () => {
  try {
    writeFileSync(CACHE_FILE, JSON.stringify({ servers, tools: [...toolCache] }));
  } catch {
    /* best effort */
  }
};
const refreshing = new Set<string>();

export async function serverList() {
  if (servers && Date.now() - servers.at < TTL) return servers.list;
  if (servers && !refreshing.has("servers")) {
    refreshing.add("servers");
    void otari<{ servers: any[] }>("GET", "/mcp/servers")
      .then(({ data }) => {
        servers = { at: Date.now(), list: data.servers ?? [] };
        saveCache();
      })
      .catch(() => {})
      .finally(() => refreshing.delete("servers"));
    return servers.list;
  }
  const { data } = await otari<{ servers: { id: string; name: string; purpose_hint?: string }[] }>("GET", "/mcp/servers");
  servers = { at: Date.now(), list: data.servers ?? [] };
  return servers.list;
}

// A server's tools as one key sees them: Otari lists only what that key may call, so a teammate with its own grant
// there is listed on its own key (cached per key), everyone else on the core key.
type KeyView = { keyId: string; auth: Record<string, string> };
async function serverTools(id: string, fresh = false, as?: KeyView) {
  const cacheId = as ? `${as.keyId}:${id}` : id;
  const hit = toolCache.get(cacheId);
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit;
  if (!fresh && hit) {
    if (!refreshing.has(cacheId)) {
      refreshing.add(cacheId);
      void serverTools(id, true, as)
        .catch(() => {})
        .finally(() => refreshing.delete(cacheId));
    }
    return hit;
  }
  const { data } = await otari<{ server_revision: string; tools: any[] }>(
    "GET",
    `/mcp/servers/${id}/tools`,
    undefined,
    as ? { auth: as.auth } : {},
  );
  const entry = { at: Date.now(), revision: data.server_revision, tools: data.tools ?? [] };
  toolCache.set(cacheId, entry);
  saveCache();
  return entry;
}

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");

// Tools a server always refuses ("not available due to compliance requirements"): noted once, then not offered.
const UNAVAILABLE_FILE = join(config.dataDir, "unavailable-tools.json");
const unavailable = new Set<string>(
  (() => {
    try {
      return JSON.parse(readFileSync(UNAVAILABLE_FILE, "utf8")) as string[];
    } catch {
      return [];
    }
  })(),
);
export function markUnavailable(server: string, tool: string): void {
  unavailable.add(`${server}.${tool}`);
  try {
    writeFileSync(UNAVAILABLE_FILE, JSON.stringify([...unavailable]));
  } catch {
    /* best effort */
  }
}
export const ALWAYS_REFUSES =
  /not available due to compliance|this tool is (disabled|not enabled)|tool is not available (for|on) (this|your) (plan|account|workspace)/i;

// The tools of every connector the teammate has, as Otari authorizes them: on the teammate's own key for the servers
// where Otari holds its access (`own`), else on Peeblo's core key.
export async function catalogFor(
  c: TeammateConfig,
  own?: { keyId: string; secret: string; servers: Set<string> },
): Promise<{ tools: ConnectorTool[]; missing: string[]; failed: string[] }> {
  if (!c.connectors.length) return { tools: [], missing: [], failed: [] };
  const list = await serverList();
  // "all" (Peeblo, the chief of staff): every MCP server connected in Otari. Their tools start deferred; writes
  // still go through the gate like anyone's.
  if (c.connectors.includes("all"))
    c = { ...c, connectors: [...new Set([...c.connectors.filter((x) => x !== "all"), ...list.map((x) => x.name)])] };
  const tools: ConnectorTool[] = [];
  const missing: string[] = [];
  const failed: string[] = [];
  // Servers are read in parallel (Peeblo's "all" is ~28 servers; one by one took ~40 s cold).
  const found = c.connectors.map((name) => ({ name, s: list.find((x) => x.name === name) }));
  for (const f of found) if (!f.s) missing.push(f.name);
  const loaded = await Promise.all(
    found
      .filter((f) => f.s)
      .map(async (f) => ({
        f,
        t: await serverTools(
          f.s!.id,
          false,
          own?.servers.has(f.name) ? { keyId: own.keyId, auth: { authorization: `Bearer ${own.secret}` } } : undefined,
        ).catch(() => null),
      })),
  );
  for (const { f, t } of loaded) {
    const s = f.s!;
    if (!t) {
      failed.push(f.name);
      continue;
    }
    // A read-only server: registered as one (PEEBLO_READONLY_SERVERS), or none of its
    // tools has a write or destructive word and none is marked as not read-only.
    const serverReadOnly =
      READONLY_SERVERS.has(s.name) ||
      t.tools.every((x: any) => x.annotations?.readOnlyHint !== false && !WRITE_WORDS.test(x.name) && !DESTRUCTIVE_WORDS.test(x.name));
    for (const tool of t.tools) {
      if (unavailable.has(`${s.name}.${tool.name}`)) continue;
      tools.push({
        name: `${safe(s.name)}__${safe(tool.name)}`.slice(0, 64),
        server: s.name,
        serverId: s.id,
        revision: t.revision,
        tool: tool.name,
        description: `[${s.name}] ${tool.description ?? tool.name}`.slice(0, 1024),
        inputSchema: tool.input_schema ?? { type: "object", properties: {} },
        readOnlyHint: typeof tool.annotations?.readOnlyHint === "boolean" ? tool.annotations.readOnlyHint : null,
        serverReadOnly,
      });
    }
  }
  return { tools, missing, failed };
}

// Whether a call runs at once or waits for a person. A server's own annotations are untrusted (Otari says
// so too), so "auto" only runs tools that both look like reads by name and say they are read-only.
export type CallKind = "read" | "write" | "destructive";
const READ_WORDS = new Set([
  "get",
  "list",
  "search",
  "read",
  "fetch",
  "query",
  "describe",
  "retrieve",
  "find",
  "lookup",
  "count",
  "show",
  "view",
  "help",
  "tools",
  "info",
  "schema",
  "learn",
  "all",
  "chart",
  "charts",
  "render",
  "metrics",
  "stats",
  "logs",
  "availability",
  "insights",
  "report",
  "reports",
  "analytics",
  "inspect",
  "whoami",
  "ping",
  "discover",
  "analyze",
  "history",
  "timeline",
  "status",
]);
// Words that make a call a write even when the server calls it read-only (a server's hint never makes a call safer
// on its own; it can only confirm a name that says nothing about writing).
const READONLY_SERVERS = new Set(config.readonlyServers);
const NEVER_READ = /(submit|invoke|feedback|trigger|run_|execute(?!read)|send|pay|charge)/i;
// Word lists, matched against whole words of the tool's name (snake, kebab or camel case), never substrings:
// "list_postgres_roles" is a read, not a "post".
const WRITE = new Set([
  "create",
  "update",
  "updates",
  "write",
  "save",
  "set",
  "add",
  "post",
  "send",
  "push",
  "merge",
  "edit",
  "upsert",
  "insert",
  "execute",
  "trigger",
  "publish",
  "invite",
  "assign",
  "upload",
  "submit",
  "invoke",
  "run",
  "pay",
  "charge",
  "move",
  "rename",
  "enable",
  "disable",
  "toggle",
  "import",
  "sync",
  "comment",
  "reply",
  "close",
  "resolve",
  "acknowledge",
  "snooze",
  "transfer",
  "duplicate",
  "copy",
  "generate",
]);
const DESTRUCTIVE = new Set([
  "delete",
  "remove",
  "drop",
  "destroy",
  "refund",
  "cancel",
  "archive",
  "revoke",
  "purge",
  "truncate",
  "reset",
  "void",
  "unpublish",
  "disconnect",
]);
const READ_VERBS = new Set([
  "get",
  "list",
  "search",
  "read",
  "fetch",
  "query",
  "describe",
  "retrieve",
  "find",
  "lookup",
  "count",
  "show",
  "view",
  "chart",
  "render",
  "inspect",
  "analyze",
  "discover",
  "whoami",
  "ping",
]);
const wordsOf = (name: string) =>
  name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_\-\s.]+/)
    .filter(Boolean);
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
  // PostHog's insight queries (query-trends, query-funnel, query-web-stats, query-retention…) only read.
  if (/^query-[a-z-]+$/.test(tool ?? "") && !/^query-run$/.test(tool ?? "")) return "read";
  // "call execute-sql {query: SELECT …}" and the query tools only read.
  if (/^(execute-sql|query|query-run|run-query|hogql)/.test(tool ?? ""))
    return /"query"\s*:\s*"\s*(select|with)\b/i.test(command) &&
      !/\b(insert|update|delete|drop|alter|create)\b/i.test(command.replace(/created?_at|createdAt/gi, ""))
      ? "read"
      : "write";
  return tool ? kindOfName(tool) : "write";
}

// Code-mode servers (Cloudflare's): `docs` and `search` run code against the API's own specification, never the API,
// so they read whatever the server's hint says. `execute` runs code that calls the API with cloudflare.request():
// it reads only when every request in the code names GET or HEAD; any other method, or a request whose method
// can't be read from the code, makes it a write.
export function codeModeKind(tool: string, code: string): CallKind {
  if (tool === "docs" || tool === "search") return "read";
  if (tool !== "execute") return "write";
  const requests = code.match(/\.request\s*\(/g)?.length ?? 0;
  const methods = [...code.matchAll(/method\s*:\s*["'`]([A-Za-z]+)["'`]/g)].map((m) => m[1].toUpperCase());
  if (!requests || methods.length < requests) return "write";
  return methods.every((m) => m === "GET" || m === "HEAD") ? "read" : "write";
}

// The kind of this exact call. A server's own readOnlyHint is untrusted, so it can only make a call look
// riskier, never safer: a read by name that the server says is not read-only counts as a write.
export function classify(t: ConnectorTool, args: Record<string, unknown>): CallKind {
  if (t.server === "posthog" && t.tool === "exec" && typeof args.command === "string") return posthogExecKind(args.command);
  if (t.server === "cloudflare" && ["docs", "search", "execute"].includes(t.tool)) return codeModeKind(t.tool, String(args.code ?? ""));
  // Every tool on a read-only server is a read, whatever its name.
  if (t.serverReadOnly) return "read";
  // Generic SQL runners (Neon run_sql, Supabase execute_sql, run_query…): the statement decides.
  if (/^(run_?sql|execute_?sql|run_?query|execute_?query|query_?sql|sql)$/i.test(t.tool)) {
    const q = String(args.sql ?? args.query ?? args.statement ?? args.command ?? "");
    const bare = q.replace(/--[^\n]*/g, "").replace(/created?_at|createdAt|updated_at/gi, "");
    if (/^\s*(select|with|explain|show)\b/i.test(bare) && !/\b(insert|update|delete|drop|alter|create|truncate|grant|merge)\b/i.test(bare))
      return "read";
  }
  // Dispatchers that say their kind in their name (Atlassian's executeRead / executeWrite / executeDestructive).
  const disp = /^execute_?(read|write|destructive)$/i.exec(t.tool)?.[1]?.toLowerCase();
  if (disp) return disp as CallKind;
  const k = kindOfName(t.tool);
  if (k === "read" && t.readOnlyHint === false) return "write";
  // A name of nouns only ("sentry_projects", "incidents", "deployments", "metrics"): no verb says it writes, so it
  // reads unless its server marks it as not read-only.
  const words = wordsOf(t.tool);
  if (
    k === "write" &&
    t.readOnlyHint !== false &&
    !words.some((w) => WRITE.has(w) || DESTRUCTIVE.has(w) || READ_VERBS.has(w)) &&
    !NEVER_READ.test(t.tool)
  )
    return "read";
  // A tool whose name has no write words (it was "write" only because no read word matched) and that its server
  // marks read-only is a read: Better Stack's incidents and monitors, Neon's list_*, Stripe's reports.
  if (k === "write" && t.readOnlyHint === true && !WRITE_WORDS.test(t.tool) && !DESTRUCTIVE_WORDS.test(t.tool) && !NEVER_READ.test(t.tool))
    return "read";
  return k;
}

// Repositories, projects and the like a teammate may touch, per connector (connector_scopes in its config).
// A call that names something outside its scope is refused before anyone is asked.
export function outOfScope(t: ConnectorTool, args: Record<string, unknown>, scopes: Record<string, string[]>): string | null {
  const allowed = scopes[t.server];
  if (!allowed?.length) return null;
  if (t.server === "github" && typeof args.owner === "string" && typeof args.repo === "string") {
    const full = `${args.owner}/${args.repo}`.toLowerCase();
    const glob = (p: string) =>
      new RegExp(
        `^${p
          .toLowerCase()
          .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, "[^/]*")}$`,
      );
    const ok = allowed.some((p) => glob(p).test(full));
    return ok ? null : `${full} is not one of the repositories this teammate may use (${allowed.join(", ")})`;
  }
  return null;
}

// The install-wide GitHub limit (PEEBLO_GITHUB_REPOS): a call naming owner/repo must name one of them, a search is
// narrowed to them (its own repo:, user: and org: qualifiers are replaced), and any other call that could reach
// another repo is refused. Returns the arguments to run with, or the reason it can't run.
export function githubLimit(
  t: ConnectorTool,
  args: Record<string, unknown>,
  repos: string[],
): { args: Record<string, unknown> } | { refuse: string } {
  if (t.server !== "github" || !repos.length) return { args };
  const allowed = repos.map((r) => r.toLowerCase());
  const list = repos.join(", ");
  if (typeof args.owner === "string" && typeof args.repo === "string") {
    return allowed.includes(`${args.owner}/${args.repo}`.toLowerCase())
      ? { args }
      : { refuse: `${args.owner}/${args.repo} isn't one of the repositories Peeblo may use here (${list})` };
  }
  if (t.tool === "get_me" || t.tool === "search_users") return { args };
  if (t.tool.startsWith("search_") && typeof args.query === "string") {
    const query = `${args.query
      .replace(/\b(repo|user|org|owner):\S+/gi, " ")
      .replace(/\s+/g, " ")
      .trim()} ${repos.map((r) => `repo:${r}`).join(" ")}`.trim();
    const { owner: _o, repo: _r, ...rest } = args;
    return { args: { ...rest, query } };
  }
  return {
    refuse: `${t.tool} can reach repositories beyond the ones Peeblo may use here (${list}); name one of those with owner and repo`,
  };
}

export function needsApproval(mode: TeammateConfig["mode"], kind: CallKind): boolean {
  if (mode === "yolo") return false;
  if (mode === "ask") return true;
  if (mode === "trusted") return kind === "destructive";
  return kind !== "read";
}

// With auth, the call runs on that key (a teammate's own, once Otari holds its access: src/otari/mcp-access.ts).
// Optional arguments the model left "empty" in words ("null", "undefined", or null) are left out: servers read them
// as values (Postman's cursor "null" is an invalid cursor; Grafana sees two folder filters). Required ones and empty
// strings stay as given.
export function withoutEmptyOptionals(schema: { required?: string[] } | undefined, args: Record<string, unknown>): Record<string, unknown> {
  const required = new Set(schema?.required ?? []);
  return Object.fromEntries(
    Object.entries(args ?? {}).filter(([k, v]) => required.has(k) || !(v === null || v === "null" || v === "undefined")),
  );
}

export async function executeTool(
  t: ConnectorTool,
  args: Record<string, unknown>,
  auth?: { authorization: string },
): Promise<{ data: any; requestId: string | null }> {
  const body = {
    mcp_server_id: t.serverId,
    server_revision: t.revision,
    tool_name: t.tool,
    arguments: args,
    client_execution_id: randomUUID(),
  };
  try {
    return await otari("POST", "/mcp/execute", body, auth ? { auth } : undefined);
  } catch (e) {
    // The server was re-registered under a new id (an admin replaced it): re-read the list and run it there once.
    if (!/MCP server not found/i.test(String((e as Error).message))) throw e;
    const { data } = await otari<{ servers: any[] }>("GET", "/mcp/servers");
    servers = { at: Date.now(), list: data.servers ?? [] };
    saveCache();
    const now = servers.list.find((x) => x.name === t.server);
    if (!now || now.id === t.serverId) throw e;
    toolCache.delete(t.serverId);
    const fresh = await serverTools(now.id, true);
    return otari(
      "POST",
      "/mcp/execute",
      { ...body, mcp_server_id: now.id, server_revision: fresh.revision, client_execution_id: randomUUID() },
      auth ? { auth } : undefined,
    );
  }
}

// After a refusal for a stale revision, the catalog is re-read so the next listing is current.
export function forgetServer(serverId: string): void {
  toolCache.delete(serverId);
}

// Loads every server's tool list once at start (and every 25 min), so the first session isn't the one waiting.
export function warmCatalog(): void {
  const warm = () =>
    void serverList()
      .then((l) => Promise.all(l.map((x) => serverTools(x.id, true).catch(() => null))))
      .catch(() => {});
  warm();
  setInterval(warm, 25 * 60_000).unref();
}
