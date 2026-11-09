// Connector access per teammate, held in Otari. Each teammate has its own Otari key; for each connector it's given,
// that key gets the same tools Otari already allows Peeblo's other keys on that server, except where the teammate is
// read-only there (then it keeps only the server's default, normally the read tools). Its connector calls then run on
// its own key, so Otari sees who called and refuses what the teammate may not do. Peeblo's own checks stay in front.
// Until a teammate's grants are confirmed (no admin session yet), its calls run on Peeblo's core key, as before.
// Peeblo never changes a server's default access ("everyone" tools): when that default is every tool, Otari can't
// make one key read-only, and `./peeblo check` says so.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import type { Teammate } from "../store/teammates.ts";
import { admin, mcpServers, session } from "./admin.ts";

type Access = { everyone_tools: string[]; grants: { id: string; api_key_id: string; key_name?: string; tools: string[] }[] };
type State = Record<string, { keyId: string; servers: string[] }>;   // teammate id → servers ready on its own key

const file = () => join(config.dataDir, "mcp-access.json");
const load = (): State => { try { return existsSync(file()) ? JSON.parse(readFileSync(file(), "utf8")) : {}; } catch { return {}; } };
let state: State | null = null;

// The servers whose calls can run on this teammate's own key.
export function ownKeyServers(teammateId: string, keyId: string | null): Set<string> {
  state ??= load();
  const s = state[teammateId];
  return new Set(s && s.keyId === keyId ? s.servers : []);
}

export async function syncTeammateAccess(tm: Teammate, teammateKeyIds?: Set<string>): Promise<{ ready: string[]; failed: string[] }> {
  const ready: string[] = [], failed: string[] = [];
  if (tm.slug === "peeblo" || !(await session())) return { ready, failed };
  teammateKeyIds ??= await keyIds();
  const { teammateKey } = await import("./spend.ts");
  const key = await teammateKey(tm).catch(() => null);
  if (!key) return { ready, failed };
  const list = await mcpServers();
  const servers: { id: string; name: string }[] = Array.isArray(list) ? list : list.servers ?? list.data ?? [];
  const want = new Set(tm.config.connectors);
  const readOnly = new Set(tm.config.read_only ?? []);
  state ??= load();
  const before = new Set(state[tm.id]?.servers ?? []);
  for (const s of servers.filter((x) => want.has(x.name) || before.has(x.name))) {
    try {
      const path = `/workspaces/{workspace}/mcp-servers/${s.id}/access`;
      const a = await admin<Access>("GET", path, undefined, `reading access for ${s.name}`, "");
      const mine = a.grants.find((g) => g.api_key_id === key.keyId);
      // What Peeblo's other keys may use here (its core key, set up by the admin), never another teammate's grant.
      const allowed = [...new Set(a.grants.filter((g) => g.api_key_id !== key.keyId && !teammateKeyIds.has(g.api_key_id)).flatMap((g) => g.tools))];
      // A teammate that may write gets its own grant: what the admin allowed Peeblo's core key there, else every tool.
      // So a server's default access can be "read tools" (Otari then refuses read-only teammates' writes) without
      // taking writes away from anyone else. Read-only teammates get no grant and stay on that default.
      const tools = !want.has(s.name) || readOnly.has(s.name) ? [] : allowed.length ? allowed : ["*"];
      if (!tools.length) { if (mine) await admin("DELETE", `${path}/grants/${mine.id}`, undefined, `removing ${tm.slug}'s access to ${s.name}`, ""); }
      else if (!mine) await admin("POST", `${path}/grants`, { api_key_ids: [key.keyId], tools }, `giving ${tm.slug} access to ${s.name}`, "");
      else if (mine.tools.slice().sort().join() !== tools.slice().sort().join()) await admin("PATCH", `${path}/grants/${mine.id}`, { tools }, `changing ${tm.slug}'s access to ${s.name}`, "");
      if (want.has(s.name)) ready.push(s.name);
    } catch { if (want.has(s.name)) failed.push(s.name); }
  }
  state[tm.id] = { keyId: key.keyId, servers: ready };
  writeFileSync(file(), JSON.stringify(state, null, 2));
  return { ready, failed };
}

// Every teammate, after an admin signs in; one teammate, after its connectors or read-only list change.
export async function syncAllAccess(): Promise<void> {
  const { listTeammates } = await import("../store/teammates.ts");
  const ids = await keyIds();
  for (const t of await listTeammates()) await syncTeammateAccess(t, ids).catch((e) => console.error(`mcp access ${t.slug}:`, (e as Error).message));
}

// Per server: whether Otari itself can keep a teammate read-only there (its default access is the read tools).
export async function readOnlyEnforced(): Promise<{ enforced: string[]; open: string[] }> {
  const list = await mcpServers();
  const servers: { id: string; name: string; everyone_tools?: string[] }[] = Array.isArray(list) ? list : list.servers ?? list.data ?? [];
  const open = servers.filter((s) => (s.everyone_tools ?? []).includes("*")).map((s) => s.name);
  return { enforced: servers.map((s) => s.name).filter((n) => !open.includes(n)), open };
}

async function keyIds(): Promise<Set<string>> {
  const { pool } = await import("../db.ts");
  return new Set((await pool.query<{ key_id: string }>("SELECT key_id FROM teammate_keys WHERE retired_at IS NULL")).rows.map((r) => r.key_id));
}

// A teammate is hired, or its connectors or read-only list changed: its grants follow (in the background, with a session).
export function followTeammateChanges(): void {
  void import("../store/events.ts").then(({ onEvent }) => onEvent(async (e) => {
    // A new hire too: its first connector call should already run on its own key.
    if (e.type !== "teammate.updated" && e.type !== "teammate.hired") return;
    const { getTeammate } = await import("../store/teammates.ts");
    const tm = await getTeammate(String((e.data as any).teammate_id));
    if (tm) await syncTeammateAccess(tm).catch((x) => console.error(`mcp access ${tm.slug}:`, (x as Error).message));
  }));
}
