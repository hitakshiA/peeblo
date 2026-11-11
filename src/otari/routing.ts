import type { PolicySpec } from "./admin.ts";
// Routing. A teammate's model is either a catalog id (Otari picks the cheapest healthy provider and fails
// over between providers of that model) or a routing policy name (cross-model fallback, set up per role).
// Policies and /routing/recommend want pinned names (provider:native-name), not catalog ids, and nothing
// maps one to the other, so Peeblo asks Otari which provider serves a catalog id with a one-token call.
import { routingPolicies } from "./admin.ts";
import { tierFile } from "./catalog.ts";
import { otari, type OtariError } from "./client.ts";

const pinned = new Map<string, string>();

// "deepseek/deepseek-v4.1-flash-1017" → "deepinfra:deepseek-ai/DeepSeek-V4.1-Flash-1017"
// A role model is pinned to a provider for its policy. When the workspace requires zero data retention (an admin
// setting in Otari), only a provider the catalog marks zero-retention is used, or the policy can't be made.
export async function zdrRequired(): Promise<boolean> {
  const { admin, session } = await import("./admin.ts");
  if (!(await session())) return false;
  return Boolean((await admin<{ require_zero_data_retention?: boolean }>("GET", "/workspaces/{workspace}/provider-policy", undefined, "reading the provider policy", "").catch(() => null))?.require_zero_data_retention);
}
export async function zdrOffering(catalogId: string): Promise<string | null> {
  const r = await otari<any>("GET", `/catalog/models/${catalogId}`).catch(() => null);
  return (r?.data?.offerings ?? []).find((o: any) => o.zero_data_retention)?.selector ?? null;
}
export async function pinnedName(catalogId: string): Promise<string> {
  if (catalogId.includes(":")) return catalogId;
  if (await zdrRequired()) {
    const zdr = await zdrOffering(catalogId);
    if (!zdr) throw new Error(`${catalogId} has no zero-data-retention provider in Otari, which this workspace requires; pick another model in config/model-tiers.json`);
    return zdr;
  }
  const hit = pinned.get(catalogId);
  if (hit) return hit;
  const r = await otari("POST", "/chat/completions", { model: catalogId, max_tokens: 1, messages: [{ role: "user", content: "hi" }] });
  const provider = r.headers.get("otari-provider");
  const model = r.headers.get("otari-model");
  if (!provider || !model) throw new Error(`Otari did not say which provider serves ${catalogId}`);
  pinned.set(catalogId, `${provider}:${model}`);
  return `${provider}:${model}`;
}

// One policy per role, all open-weight: the default model first, then what Otari falls back to.
// (from config/model-tiers.json, with the quality tiers they were picked from).
export const ROLES: Record<string, { default: string; fallback: string[]; purpose: string; step_down?: { at_budget_pct: number; model: string } }> = tierFile.roles;

// A policy Otari just stored is unknown to some of its servers for several seconds (calls alternate between
// "unknown model" and answers), so wait until it answers several times in a row.
export async function waitUntilServing(name: string, timeoutMs = 60_000, inARow = 5): Promise<{ waitedMs: number; refusedIds: string[] }> {
  const t0 = Date.now();
  const refusedIds: string[] = [];
  let streak = 0;
  while (streak < inARow) {
    try {
      await otari("POST", "/chat/completions", { model: name, max_tokens: 1, messages: [{ role: "user", content: "hi" }] });
      streak++;
    } catch (e) {
      const o = e as OtariError;
      if (o.code !== "invalid_model" || Date.now() - t0 > timeoutMs) throw e;
      if (o.requestId) refusedIds.push(o.requestId);
      streak = 0;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return { waitedMs: Date.now() - t0, refusedIds };
}

export async function rolePoliciesInOtari(): Promise<string[]> {
  const list = await routingPolicies();
  return ((list.data ?? list) as { name: string }[]).map((p) => p.name).filter((n) => n in ROLES);
}

// Which model a piece of delegated work should run on, from Otari's recommender. Candidates are catalog
// ids with what each is for; the answer is a catalog id (falls back to the parent's model on any error).
export type Recommendation = { model: string; probabilities: Record<string, number>; reason: string | null; requestId: string | null; fallback: boolean };
export async function recommend(q: { sessionId: string; toolUseId: string; agentType: string; description: string; prompt: string; parentModel: string; candidates: Record<string, string>; endUser?: string }): Promise<Recommendation> {
  try {
    const byPinned = new Map<string, string>();
    const candidates: Record<string, string> = {};
    // "otari:<catalog id>" names a candidate without pinning a provider, so nothing is called to find one.
    for (const [id, purpose] of Object.entries(q.candidates)) { const p = id.includes(":") ? id : `otari:${id}`; byPinned.set(p, id); candidates[p] = purpose; }
    const r = await otari<{ model: string; reason?: string; probabilities?: Record<string, number> }>("POST", "/routing/recommend", {
      harness: "pi", session_id: q.sessionId, tool_use_id: q.toolUseId, agent_type: q.agentType, description: q.description,
      prompt: q.prompt.slice(0, 8000), parent_model: q.parentModel, candidates,
    });
    const probabilities = Object.fromEntries(Object.entries(r.data.probabilities ?? {}).map(([k, v]) => [byPinned.get(k) ?? k, v]));
    return { model: byPinned.get(r.data.model) ?? q.parentModel, probabilities, reason: r.data.reason ?? null, requestId: r.requestId, fallback: !byPinned.has(r.data.model) };
  } catch (e) {
    const err = e as { status?: number; requestId?: string | null; message?: string };
    console.error(`otari: /routing/recommend failed (${err.status ?? "?"} ${err.requestId ?? "no request id"}): ${String(err.message).slice(0, 200)}`);
    return { model: q.parentModel, probabilities: {}, reason: null, requestId: err.requestId ?? null, fallback: true };
  }
}

// A role's policy in Otari: the default model, Otari's fallback, and a step-down to a cheaper model once the calling
// key's budget is mostly used ("when" is checked by Otari against the key's own ceiling, so each teammate steps
// down on its own budget, and the receipt shows the model that served).
export async function policySpec(r: (typeof ROLES)[string]): Promise<PolicySpec> {
  const step = r.step_down ? [{ when: { budget_used_pct: { gte: r.step_down.at_budget_pct } }, target: await pinnedName(r.step_down.model) }] : [];
  return { select: [...step, { default: await pinnedName(r.default) }], on_failure: await Promise.all(r.fallback.map(pinnedName)) };
}

// Whether Otari holds Peeblo's role policies (made from config/model-tiers.json). Until it does (a fresh install, or
// no admin session to make them), a role name is sent as its default model, so agents work either way.
let policiesReady = false;
export const rolePoliciesReady = () => policiesReady;
export function modelFor(requested: string): string {
  return !policiesReady && requested in ROLES ? ROLES[requested].default : requested;
}
// Creates or updates every role policy. Runs at start and after an admin signs Peeblo in to Otari.
export async function syncRolePolicies(): Promise<boolean> {
  const { session, upsertRoutingPolicy } = await import("./admin.ts");
  if (!(await session())) { policiesReady = false; return false; }
  try {
    // Only what's missing, or what config/model-tiers.json changed since Peeblo last wrote it: an edit made in Otari's
    // dashboard stays until the file changes that role.
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { createHash } = await import("node:crypto");
    const { config } = await import("../config.ts");
    const file = join(config.dataDir, "role-policies.json");
    let pushed: Record<string, string> = {};
    try { pushed = JSON.parse(readFileSync(file, "utf8")); } catch { /* first run */ }
    const have = new Set(await rolePoliciesInOtari());
    const zdr = await zdrRequired();   // turning zero data retention on or off re-pins every role
    for (const [name, r] of Object.entries(ROLES)) {
      const hash = createHash("sha256").update(JSON.stringify(r) + (zdr ? ":zdr" : "")).digest("hex").slice(0, 16);
      if (have.has(name) && pushed[name] === hash) continue;
      if (have.has(name) && !pushed[name]) { pushed[name] = hash; continue; } // made earlier (or by hand): adopt it
      await upsertRoutingPolicy(name, await policySpec(r));
      pushed[name] = hash;
    }
    writeFileSync(file, JSON.stringify(pushed, null, 2));
    policiesReady = true;
  } catch (e) {
    console.error("otari: role policies:", (e as Error).message.slice(0, 200));
    policiesReady = (await rolePoliciesInOtari().catch(() => [])).length === Object.keys(ROLES).length;
  }
  return policiesReady;
}
