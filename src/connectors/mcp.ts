// Connectors are MCP servers stored in Otari. Peeblo lists what a teammate may use, decides whether a call
// needs a person's yes, and then has Otari execute exactly that call (caller-orchestrated /mcp/execute with
// the server_revision seen at listing time, so a changed server config is refused rather than run).
import { randomUUID } from "node:crypto";
import { otari } from "../otari/client.ts";
import type { TeammateConfig } from "../store/teammates.ts";

export type ConnectorTool = {
  name: string;          // what the model sees: <server>__<tool>
  server: string; serverId: string; revision: string;
  tool: string; description: string; inputSchema: Record<string, unknown>; readOnlyHint: boolean | null; // null: the server says nothing
};

const TTL = 5 * 60_000;
let servers: { at: number; list: { id: string; name: string; purpose_hint?: string }[] } | null = null;
const toolCache = new Map<string, { at: number; revision: string; tools: any[] }>();

export async function serverList() {
  if (servers && Date.now() - servers.at < TTL) return servers.list;
  const { data } = await otari<{ servers: { id: string; name: string; purpose_hint?: string }[] }>("GET", "/mcp/servers");
  servers = { at: Date.now(), list: data.servers ?? [] };
  return servers.list;
}

async function serverTools(id: string, fresh = false) {
  const hit = toolCache.get(id);
  if (!fresh && hit && Date.now() - hit.at < TTL) return hit;
  const { data } = await otari<{ server_revision: string; tools: any[] }>("GET", `/mcp/servers/${id}/tools`);
  const entry = { at: Date.now(), revision: data.server_revision, tools: data.tools ?? [] };
  toolCache.set(id, entry);
  return entry;
}

const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");

// The tools of every connector the teammate has, as Otari authorizes them for Peeblo's key.
export async function catalogFor(c: TeammateConfig): Promise<{ tools: ConnectorTool[]; missing: string[]; failed: string[] }> {
  if (!c.connectors.length) return { tools: [], missing: [], failed: [] };
  const list = await serverList();
  const tools: ConnectorTool[] = [];
  const missing: string[] = [];
  const failed: string[] = [];
  for (const name of c.connectors) {
    const s = list.find((x) => x.name === name);
    if (!s) { missing.push(name); continue; }
    try {
      const t = await serverTools(s.id);
      for (const tool of t.tools) {
        tools.push({
          name: `${safe(s.name)}__${safe(tool.name)}`.slice(0, 64), server: s.name, serverId: s.id, revision: t.revision,
          tool: tool.name, description: `[${s.name}] ${tool.description ?? tool.name}`.slice(0, 1024),
          inputSchema: tool.input_schema ?? { type: "object", properties: {} }, readOnlyHint: typeof tool.annotations?.readOnlyHint === "boolean" ? tool.annotations.readOnlyHint : null,
        });
      }
    } catch {
      failed.push(name);
    }
  }
  return { tools, missing, failed };
}

// Whether a call runs at once or waits for a person. A server's own annotations are untrusted (Otari says
// so too), so "auto" only runs tools that both look like reads by name and say they are read-only.
export type CallKind = "read" | "write" | "destructive";
const READ_WORDS = new Set(["get", "list", "search", "read", "fetch", "query", "describe", "retrieve", "find", "lookup", "count", "show", "view", "help", "tools", "info", "schema", "learn", "all"]);
const WRITE_WORDS = /(create|update|write|save|set|add|post|send|push|merge|edit|upsert|insert|run_sql|execute|trigger|publish|invite|assign)/i;
const DESTRUCTIVE_WORDS = /(delete|remove|drop|destroy|refund|cancel|archive|revoke|purge|truncate|reset)/i;

// What a tool name suggests, from its words (snake, kebab or camel case). Unknown counts as a write.
function kindOfName(name: string): CallKind {
  if (DESTRUCTIVE_WORDS.test(name)) return "destructive";
  if (WRITE_WORDS.test(name)) return "write";
  const words = name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().split(/[_\-\s.]+/);
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
  return k === "read" && t.readOnlyHint === false ? "write" : k;
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
