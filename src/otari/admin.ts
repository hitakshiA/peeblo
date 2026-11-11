// Otari admin work through the dashboard session. Hosted Otari has no management key: keys, budgets,
// spend ceilings, routing policies, guardrail mandates, MCP servers and the web-search switch can only be
// changed by a signed-in owner or admin. So an admin may sign Peeblo in once (opt-in); Peeblo keeps the
// session cookie sealed (never the password) and asks again when it ends (about 7 days). Without a
// session, every operation has a deep link (links.ts) so a person can do it in the dashboard instead.
import { config } from "../config.ts";
import { seal, unseal } from "../crypto.ts";
import { pool } from "../db.ts";
import { otari, OtariError } from "./client.ts";
import { links } from "./links.ts";

class NoSession extends Error {
  link: string;
  constructor(link: string, what: string) {
    super(`Peeblo has no Otari dashboard session, so ${what} has to be done by a person: ${link}`);
    this.link = link;
  }
}

type Session = { cookie: string; orgId: string; workspaceId: string; expiresAt: Date; signedInAs: string };
let cached: Session | null | undefined;

export async function session(): Promise<Session | null> {
  if (cached !== undefined) return cached && cached.expiresAt > new Date() ? cached : null;
  const { rows } = await pool.query("SELECT cookie, org_id, workspace_id, expires_at, signed_in_as FROM otari_session WHERE id = 1 AND revoked_at IS NULL AND expires_at > now()");
  cached = rows[0] ? { cookie: unseal<string>(rows[0].cookie), orgId: rows[0].org_id, workspaceId: rows[0].workspace_id, expiresAt: rows[0].expires_at, signedInAs: rows[0].signed_in_as } : null;
  return cached;
}

// Signs in with the admin's email and password (used once, not stored) and keeps the session cookie.
export async function signIn(email: string, password: string): Promise<{ orgId: string; workspaceId: string; expiresAt: Date }> {
  const r = await fetch(`${config.otariBaseUrl}/auth/session`, { method: "POST", headers: { "content-type": "application/json", "user-agent": "peeblo/0.1" }, body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new OtariError(`Otari sign-in failed: ${r.status} ${(await r.text()).slice(0, 200)}`, r.status, r.headers.get("otari-request-id"), null);
  await r.body?.cancel();
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const maxAge = Math.max(...r.headers.getSetCookie().map((c) => Number(/max-age=(\d+)/i.exec(c)?.[1] ?? 0)));
  const expiresAt = new Date(Date.now() + (maxAge > 0 ? maxAge * 1000 : 7 * 86_400_000));
  const auth = { cookie };
  const org = (await otari("GET", "/organizations/me", undefined, { auth })).data;
  // Admin work happens in the workspace of the key Peeblo calls with (keys show only a prefix and suffix).
  const keys = (await otari("GET", "/organizations/me/keys", undefined, { auth })).data;
  const ours = ((keys.data ?? keys) as any[]).find((k) => k.key_prefix && k.key_suffix && config.otariKey.startsWith(k.key_prefix) && config.otariKey.endsWith(k.key_suffix));
  const workspaceId = config.otariWorkspaceId || ours?.workspace_id;
  if (!workspaceId) throw new Error("could not find the workspace of Peeblo's Otari key in this organization; set OTARI_WORKSPACE_ID");
  await pool.query(
    `INSERT INTO otari_session (id, cookie, signed_in_as, org_id, workspace_id, expires_at) VALUES (1, $1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET cookie = $1, signed_in_as = $2, org_id = $3, workspace_id = $4, expires_at = $5, created_at = now(), revoked_at = NULL`,
    [seal(cookie), email, org.organization.id, workspaceId, expiresAt],
  );
  cached = undefined;
  // With a session, Peeblo's role routing policies can be made (or brought up to date) in Otari.
  void import("./routing.ts").then((r) => r.syncRolePolicies()).catch(() => null);
  void import("./mcp-access.ts").then((m) => m.syncAllAccess()).catch(() => null);
  void import("../guard.ts").then((g) => g.ensureScreening()).catch((e) => console.error("screening setup:", (e as Error).message));
  return { orgId: org.organization.id, workspaceId, expiresAt };
}

export async function signOut(): Promise<void> {
  await pool.query("UPDATE otari_session SET revoked_at = now() WHERE id = 1");
  cached = undefined;
}

// One admin call with the session. A 401 means the session ended: forget it, so Peeblo asks again.
export async function admin<T = any>(method: string, path: string, body: unknown, what: string, link: string): Promise<T> {
  const s = await session();
  if (!s) throw new NoSession(link, what);
  try {
    const r = await otari<T>(method, path.replaceAll("{workspace}", s.workspaceId), body, { auth: { cookie: s.cookie } });
    return r.data;
  } catch (e) {
    if ((e as OtariError).status === 401) { await signOut(); throw new NoSession(link, what); }
    throw e;
  }
}

// ---- operations -------------------------------------------------------------------------------------

export type Budget = { id: string; name: string; max_budget: number | null };
// Otari names the id budget_id; Peeblo calls it id like every other object.
const asBudget = (b: any): Budget => ({ ...b, id: b.budget_id ?? b.id });
export const createBudget = async (name: string, maxUsd: number, period: "month" | "day" = "month") => asBudget(await admin<any>("POST", "/organizations/me/budgets", { name, max_budget: maxUsd, ...(period === "month" ? { reset_alignment: "calendar_month" } : { reset_alignment: "calendar_day" }) }, `creating the budget ${name}`, links.budgets()));
export const updateBudget = async (id: string, maxUsd: number) => asBudget(await admin<any>("PATCH", `/organizations/me/budgets/${id}`, { max_budget: maxUsd }, "changing a budget", links.budgets()));
export const budgets = async () => { const r = await admin<any>("GET", "/organizations/me/budgets", undefined, "listing budgets", links.budgets()); return ((r.data ?? r) as any[]).map(asBudget); };
export const deleteBudget = (id: string) => admin("DELETE", `/organizations/me/budgets/${id}`, undefined, "deleting a budget", links.budgets());

export type CreatedKey = { id: string; key: string; key_name: string | null };
export const createServiceKey = (name: string, endUserBudgetIds: string[] | null, defaultEndUserBudget?: string) =>
  admin<CreatedKey>("POST", "/organizations/me/keys", { key_name: name, is_service_key: true, end_user_budget_ids: endUserBudgetIds, ...(defaultEndUserBudget ? { end_user_budget_id: defaultEndUserBudget } : {}), metadata: { app: "peeblo" } }, `creating the key ${name}`, links.keys());
export const deleteKey = (id: string) => admin("DELETE", `/organizations/me/keys/${id}`, undefined, "deleting a key", links.keys());

export const createKeyCeiling = (keyId: string, budgetId: string, name: string) =>
  admin<{ id: string }>("POST", "/organizations/me/spend-ceilings", { scope_type: "api_token", scope_id: keyId, budget_id: budgetId, name }, `capping the key ${name}`, links.budgets());
export const deleteCeiling = (id: string) => admin("DELETE", `/organizations/me/spend-ceilings/${id}`, undefined, "removing a spend ceiling", links.budgets());

export type PolicySpec = { select: ({ default: string } | { when: Record<string, unknown>; target: string })[]; on_failure?: string[] };
export async function upsertRoutingPolicy(name: string, spec: PolicySpec): Promise<void> {
  const s = await session();
  const body = { name, spec, workspace_id: s?.workspaceId };
  try {
    await admin("POST", "/organizations/me/routing-policies", body, `setting the routing policy ${name}`, links.routingPolicy(name));
  } catch (e) {
    if ((e as OtariError).status !== 409) throw e;
    await deleteRoutingPolicy(name);
    await admin("POST", "/organizations/me/routing-policies", body, `setting the routing policy ${name}`, links.routingPolicy(name));
  }
}
const deleteRoutingPolicy = (name: string) =>
  admin("DELETE", `/organizations/me/routing-policies/${encodeURIComponent(name)}?workspace_id={workspace}`, undefined, `deleting the routing policy ${name}`, links.routingPolicy(name));
export const routingPolicies = () => admin<any>("GET", "/organizations/me/routing-policies", undefined, "listing routing policies", links.routing());

export const guardrailMandates = () => admin<any>("GET", "/organizations/me/guardrails", undefined, "listing guardrails", links.guardrails());

export const mcpServers = () => admin<any>("GET", "/workspaces/{workspace}/mcp-servers", undefined, "listing MCP servers", links.mcpServers());

export const webSearch = () => admin<any>("GET", "/workspaces/{workspace}/web-search", undefined, "reading the web-search setting", links.webSearch());
export async function setWebSearch(enabled: boolean): Promise<void> {
  // PUT replaces the whole setting, so keep the lists and limits that are there.
  const cur = await webSearch();
  await admin("PUT", "/workspaces/{workspace}/web-search", { enabled, allowed_domains: cur.allowed_domains ?? null, blocked_domains: cur.blocked_domains ?? null, max_results: cur.max_results ?? null }, `turning web search ${enabled ? "on" : "off"}`, links.webSearch());
}
