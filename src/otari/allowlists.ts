// Allow-lists on each teammate's Otari key, so the gateway itself holds two of Peeblo's rules:
// - models: only open-weight models (every one Otari's catalog lists that Peeblo counts as open), the exact targets of
//   Peeblo's role policies (step-downs included) and Otari's own router for /routing/recommend. Any other model is
//   refused, whatever the code asks for.
//   Otari matches the list against where a call is sent (instance:model, e.g. deepinfra:Qwen/Qwen3-32B), not the
//   catalog id asked for: a catalog id in the list is accepted but matches nothing (measured Nov 2026). So each
//   catalog model is listed under every provider Otari may send it to, its automatic fallbacks included (from
//   Otari's fallbacks view); a model that view doesn't cover is resolved with routing explain, five at a time.
// - tools: a teammate without the web tool gets none of Otari's search or fetch tools ([]); one with it inherits the
//   workspace's (null).
// Applied when a key is made, at start, and when a teammate's tools change; a key that already holds the same lists
// isn't touched.
import { pool } from "../db.ts";
import type { Teammate } from "../store/teammates.ts";

const ROUTER = "otari:subagent-router";
const EXPLAIN_MAX = 5;
let cached: { at: number; models: string[] } | null = null;

// Where each of these catalog models may be sent. A group explain refuses (one model it can't route) is explained one
// by one, and a model that still can't be routed is left out: nothing could call it anyway.
async function dispatchNames(ids: string[]): Promise<string[]> {
  const { admin, explainPolicy, session } = await import("./admin.ts");
  const s = await session();
  const fallbacks = s
    ? await admin<{ models: { id: string; offerings: { selector: string }[] }[] }>(
        "GET",
        `/organizations/me/automatic-fallbacks?workspace_id=${s.workspaceId}`,
        undefined,
        "reading automatic fallbacks",
        "",
      ).catch(() => null)
    : null;
  // Only selectors whose instance is a name Otari takes in a list (some providers show a label, "TokenHub - China").
  const offered = new Map(
    (fallbacks?.models ?? []).map((m) => [m.id, m.offerings.map((o) => o.selector).filter((x) => /^[a-z0-9][a-z0-9_.-]*:/.test(x))]),
  );
  const out = ids.flatMap((id) => offered.get(id) ?? []);
  ids = ids.filter((id) => !offered.get(id)?.length);
  const plan = (g: string[]) =>
    explainPolicy({ spec: { select: [{ default: g[0] }], ...(g.length > 1 ? { on_failure: g.slice(1) } : {}) } });
  for (let i = 0; i < ids.length; i += EXPLAIN_MAX) {
    const group = ids.slice(i, i + EXPLAIN_MAX);
    const groups = await plan(group)
      .then((p) => [p])
      .catch(async () => Promise.all(group.map((id) => plan([id]).catch(() => null))));
    for (const p of groups) for (const c of p?.candidates ?? []) if (typeof c.dispatch_model === "string") out.push(c.dispatch_model);
  }
  return out;
}

export async function modelAllowList(): Promise<string[]> {
  if (cached && Date.now() - cached.at < 3_600_000) return cached.models;
  const { openWeightModels } = await import("./catalog.ts");
  const { explainPolicy } = await import("./admin.ts");
  const { ROLES } = await import("./routing.ts");
  const targets = new Set<string>();
  for (const [name, role] of Object.entries(ROLES)) {
    // The plan as it is now, and past the role's step-down when it has one.
    for (const pct of role.step_down ? [undefined, role.step_down.at_budget_pct] : [undefined]) {
      const plan = await explainPolicy({ name, budgetUsedPct: pct }).catch(() => null);
      for (const c of plan?.candidates ?? []) if (typeof c.dispatch_model === "string") targets.add(c.dispatch_model);
    }
  }
  const open = await dispatchNames((await openWeightModels()).map((m) => m.id));
  if (!open.length) throw new Error("Otari's routing explain named no model to allow");
  const models = [...new Set([...open, ...targets, ROUTER])].sort();
  cached = { at: Date.now(), models };
  return models;
}

export const toolAllowList = (tm: Teammate): string[] | null => (tm.config.tools.includes("web") ? null : []);

const same = (a: string[] | null | undefined, b: string[] | null) =>
  a == null || b == null ? (a ?? null) === b : a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

// Sets one teammate key's lists when they differ from what Otari holds.
export async function syncKeyAllowList(
  tm: Teammate,
  current?: { allowed_models?: string[] | null; allowed_tools?: string[] | null },
): Promise<"set" | "same" | "skipped"> {
  const { rows } = await pool.query<{ key_id: string }>("SELECT key_id FROM teammate_keys WHERE teammate_id = $1 AND retired_at IS NULL", [
    tm.id,
  ]);
  if (!rows[0]) return "skipped";
  const { admin, session } = await import("./admin.ts");
  if (!(await session())) return "skipped";
  const models = await modelAllowList();
  const tools = toolAllowList(tm);
  if (current && same(current.allowed_models, models) && same(current.allowed_tools, tools)) return "same";
  // An entry Otari won't take (a provider it no longer knows) is dropped from the list and the list sent again.
  for (let tries = 0; ; tries++) {
    try {
      await admin(
        "PATCH",
        `/organizations/me/keys/${rows[0].key_id}`,
        { allowed_models: models, allowed_tools: tools },
        `limiting ${tm.config.name}'s key to open models`,
        "",
      );
      return "set";
    } catch (e) {
      const bad = /'([^']+)': unknown provider or instance/.exec((e as Error).message)?.[1];
      if (!bad || tries >= 20 || !models.includes(bad)) throw e;
      models.splice(models.indexOf(bad), 1);
    }
  }
}

// Every teammate key, comparing with Otari's own copy first.
export async function syncAllKeyAllowLists(): Promise<{ set: number; same: number; failed: string[] }> {
  const { admin, session } = await import("./admin.ts");
  if (!(await session())) return { set: 0, same: 0, failed: [] };
  const r: any = await admin("GET", "/organizations/me/keys", undefined, "listing keys", "");
  const byId = new Map(((r.data ?? r) as any[]).map((k) => [k.id, k]));
  const { listTeammates } = await import("../store/teammates.ts");
  const { rows } = await pool.query<{ teammate_id: string; key_id: string }>(
    "SELECT teammate_id, key_id FROM teammate_keys WHERE retired_at IS NULL",
  );
  const crew = new Map((await listTeammates()).map((t) => [t.id, t]));
  const out = { set: 0, same: 0, failed: [] as string[] };
  for (const row of rows) {
    const tm = crew.get(row.teammate_id);
    const key = byId.get(row.key_id);
    if (!tm || !key) continue;
    const res = await syncKeyAllowList(tm, key).catch((e) => {
      console.error(`allow-list ${tm.slug}:`, (e as Error).message);
      out.failed.push(`${tm.slug}: ${(e as Error).message.slice(-160)}`);
      return "skipped" as const;
    });
    if (res === "set") out.set++;
    else if (res === "same") out.same++;
  }
  return out;
}
