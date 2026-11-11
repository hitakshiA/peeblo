// The authority rules for a hire or a capability change (rail; the card is the person's approval, these are not
// theirs to waive):
// - YOLO mode is for admins only;
// - the model must be an open-weight chat model in Otari's catalog (checkModel);
// - a teammate's monthly budget can't exceed what its hirer may spend in a month on their own Otari tier (admins: $500);
// - tools come from the fixed list, and connectors must be MCP servers that exist in Otari.
import { isOtariAdmin } from "./authority.ts";
import { serverList } from "../connectors/mcp.ts";
import { checkModel } from "../crew/model-change.ts";
import { endUser, tiers } from "../otari/people.ts";
import type { Person } from "../store/people.ts";

const TOOLS = ["web", "code", "computer"];
const ADMIN_CEILING = 500;
const MONTH = 30 * 86400;

// What the person may give one teammate a month: their own tier's limit, scaled to a month.
async function budgetCeiling(p: Person | null): Promise<number> {
  if (isOtariAdmin(p)) return ADMIN_CEILING;
  if (!p?.end_user_id) return 0;
  const all = await tiers().catch(() => []);
  const mine = await endUser(p.end_user_id).catch(() => null);
  const t = all.find((x) => x.budget_id === mine?.budget_id) ?? all.find((x) => x.is_default);
  if (!t?.max_budget) return 0;
  const per = t.budget_duration_sec ?? MONTH;
  return Math.round(t.max_budget * Math.max(1, MONTH / per) * 100) / 100;
}

export async function configProblems(p: Person | null, c: { mode?: string | null; model?: string | null; fallback?: string | null; budget_usd?: number | null; tools?: string[]; connectors?: string[] }): Promise<string | null> {
  if (c.mode === "yolo" && !isOtariAdmin(p)) return "Only an admin can give a teammate YOLO mode; pick auto or ask.";
  for (const m of [c.model, c.fallback]) {
    if (!m) continue;
    const bad = await checkModel(m);
    if (bad) return `The model can't be used: ${bad}.`;
  }
  if (c.budget_usd != null) {
    const cap = await budgetCeiling(p);
    if (c.budget_usd > cap) return `A teammate's budget can be at most $${cap} a month for you (your own Otari limit); pick that or less, or ask an admin.`;
  }
  const badTools = (c.tools ?? []).filter((t) => !TOOLS.includes(t));
  if (badTools.length) return `Unknown tools: ${badTools.join(", ")} (use web, code or computer).`;
  if (c.connectors?.length) {
    const have = new Set((await serverList()).map((s) => s.name));
    const missing = c.connectors.filter((x) => !have.has(x) && !(x === "all" && isOtariAdmin(p)));
    if (missing.length) return `No connector called ${missing.join(", ")} in Otari (crew_status lists the ones that exist).`;
  }
  return null;
}
