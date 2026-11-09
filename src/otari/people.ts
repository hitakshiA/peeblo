// People and their budgets. Every Slack person is an Otari end user (slack-<team>-<user>) on Peeblo's
// service key, so Otari bills and caps each person. Budget tiers are made by an admin (dashboard or
// admin.ts); Peeblo only assigns them. When Otari refuses a call for budget, the person gets a plain
// sentence built from Otari's own numbers.
import { otari, OtariError } from "./client.ts";

const known = new Map<string, string | null>();

// Registers a person. A new person goes on the given tier (or the key's default); a known one keeps theirs.
// End users belong to the key that made them, so a teammate with its own key registers people on it too.
export async function ensureEndUser(externalId: string, alias: string | null, budgetId?: string, key?: { keyId: string; secret: string }): Promise<void> {
  const k = `${key?.keyId ?? "core"}:${externalId}`;
  if (known.has(k) && known.get(k) === (budgetId ?? null)) return;
  const opts = key ? { auth: { authorization: `Bearer ${key.secret}` } } : {};
  // Someone Otari already knows keeps the tier they're on (an admin may have moved them); only new people get one.
  const existing = await otari<EndUser>("GET", `/end-users/${encodeURIComponent(externalId)}`, undefined, opts).then((r) => r.data, (e) => { if ((e as OtariError).status === 404) return null; throw e; });
  if (existing?.budget_id) { known.set(k, budgetId ?? null); return; }
  // Otari's PUT needs a budget; without one named, the key's default tier.
  const budget = budgetId ?? (await otari<Tier[]>("GET", "/end-user-budgets", undefined, opts)).data.find((t) => t.is_default)?.budget_id;
  if (!budget) throw new Error("Peeblo's Otari key has no default end-user budget; set a default end-user budget on the service key in Otari (Keys), or OTARI_END_USER_BUDGET_ID");
  await otari("PUT", `/end-users/${encodeURIComponent(externalId)}`, { alias: alias ?? externalId, budget_id: budget, metadata: { app: "peeblo" } }, opts);
  known.set(k, budgetId ?? null);
}

// Moves a person to a tier (an admin decision, or a check).
export async function moveToTier(externalId: string, alias: string | null, budgetId: string, key?: { keyId: string; secret: string }): Promise<void> {
  const opts = key ? { auth: { authorization: `Bearer ${key.secret}` } } : {};
  await otari("PUT", `/end-users/${encodeURIComponent(externalId)}`, { alias: alias ?? externalId, budget_id: budgetId, metadata: { app: "peeblo" } }, opts);
  known.set(`${key?.keyId ?? "core"}:${externalId}`, budgetId);
}

export type EndUser = { user_id: string; alias: string | null; spend: number; budget_id: string | null; blocked: boolean };
export async function endUser(externalId: string): Promise<EndUser | null> {
  try { return (await otari<EndUser>("GET", `/end-users/${encodeURIComponent(externalId)}`)).data; }
  catch (e) { if ((e as OtariError).status === 404) return null; throw e; }
}

export type Tier = { budget_id: string; name: string; max_budget: number | null; budget_duration_sec: number | null; reset_alignment: string | null; is_default: boolean; end_user_count: number };
// The tiers this service key may put people on.
export async function tiers(): Promise<Tier[]> {
  return (await otari<Tier[]>("GET", "/end-user-budgets")).data;
}

// Otari's refusal: 403 budget_exceeded, Otari-Budget-Scope (user, key, …) and a message with its estimate.
export type BudgetRefusal = { scope: string | null; message: string; remaining: number | null; estimate: number | null };
export function budgetRefusal(status: number, headers: Headers, body: string): BudgetRefusal | null {
  if (status !== 403 && status !== 402 && status !== 429) return null;
  if (!body.includes("budget_exceeded") && headers.get("otari-error-code") !== "budget_exceeded") return null;
  let message = "";
  try { const j = JSON.parse(body); message = typeof j.detail === "string" ? j.detail : j.detail?.message ?? JSON.stringify(j.detail); } catch { message = body.slice(0, 300); }
  const num = (re: RegExp) => { const m = re.exec(message); return m ? Number(m[1]) : null; };
  return { scope: headers.get("otari-budget-scope"), message, remaining: num(/\$(\d+(?:\.\d+)?) of budget remaining/), estimate: num(/estimated cost of \$(\d+(?:\.\d+)?)/) };
}

export function budgetReply(r: BudgetRefusal, teammate: string): string {
  const who = r.scope === "user" ? "your personal Otari budget" : r.scope === "api_token" || r.scope === "key" ? `${teammate}'s budget` : "the team's Otari budget";
  const nums = r.remaining !== null && r.estimate !== null ? ` (${fmt(r.remaining)} left, this would cost about ${fmt(r.estimate)})` : "";
  return `I can't run this: it would go over ${who}${nums}. An admin can raise the limit, or try again when it resets.`;
}
const fmt = (usd: number) => (usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);
