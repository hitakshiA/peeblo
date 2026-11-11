// Allow-lists on each teammate's Otari key, so the gateway itself holds two of Peeblo's rules:
// - models: only open-weight models (every one Otari's catalog lists that Peeblo counts as open), the exact targets of
//   Peeblo's role policies (as Otari's explain reports them, step-downs included) and Otari's own router for
//   /routing/recommend. Any other model is refused with model_not_allowed, whatever the code asks for.
// - tools: a teammate without the web tool gets none of Otari's search or fetch tools ([]); one with it inherits the
//   workspace's (null).
// Applied when a key is made, at start, and when a teammate's tools change; a key that already holds the same lists
// isn't touched.
import { pool } from "../db.ts";
import type { Teammate } from "../store/teammates.ts";

const ROUTER = "otari:subagent-router";
let cached: { at: number; models: string[] } | null = null;

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
  const models = [...new Set([...(await openWeightModels()).map((m) => m.id), ...targets, ROUTER])].sort();
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
  await admin(
    "PATCH",
    `/organizations/me/keys/${rows[0].key_id}`,
    { allowed_models: models, allowed_tools: tools },
    `limiting ${tm.config.name}'s key to open models`,
    "",
  );
  return "set";
}

// Every teammate key, comparing with Otari's own copy first.
export async function syncAllKeyAllowLists(): Promise<{ set: number; same: number }> {
  const { admin, session } = await import("./admin.ts");
  if (!(await session())) return { set: 0, same: 0 };
  const r: any = await admin("GET", "/organizations/me/keys", undefined, "listing keys", "");
  const byId = new Map(((r.data ?? r) as any[]).map((k) => [k.id, k]));
  const { listTeammates } = await import("../store/teammates.ts");
  const { rows } = await pool.query<{ teammate_id: string; key_id: string }>(
    "SELECT teammate_id, key_id FROM teammate_keys WHERE retired_at IS NULL",
  );
  const crew = new Map((await listTeammates()).map((t) => [t.id, t]));
  const out = { set: 0, same: 0 };
  for (const row of rows) {
    const tm = crew.get(row.teammate_id);
    const key = byId.get(row.key_id);
    if (!tm || !key) continue;
    const res = await syncKeyAllowList(tm, key).catch((e) => {
      console.error(`allow-list ${tm.slug}:`, (e as Error).message);
      return "skipped" as const;
    });
    if (res === "set") out.set++;
    else if (res === "same") out.same++;
  }
  return out;
}
