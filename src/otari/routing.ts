// Routing. A teammate's model is either a catalog id (Otari picks the cheapest healthy provider and fails
// over between providers of that model) or a routing policy name (cross-model fallback, set up per role).
// Policies and /routing/recommend want pinned names (provider:native-name), not catalog ids, and nothing
// maps one to the other, so Peeblo asks Otari which provider serves a catalog id with a one-token call.
import { upsertRoutingPolicy, routingPolicies } from "./admin.ts";
import { tierFile } from "./catalog.ts";
import { otari, OtariError } from "./client.ts";

const pinned = new Map<string, string>();

// "deepseek/deepseek-v4.1-flash-1017" → "deepinfra:deepseek-ai/DeepSeek-V4.1-Flash-1017"
export async function pinnedName(catalogId: string): Promise<string> {
  if (catalogId.includes(":")) return catalogId;
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
export const ROLES: Record<string, { default: string; fallback: string[]; purpose: string }> = tierFile.roles;

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

// Creates or replaces the role policies in Otari (needs the dashboard session). Returns what was set.
export async function ensureRolePolicies(): Promise<Record<string, { select: { default: string }[]; on_failure: string[] }>> {
  const out: Record<string, { select: { default: string }[]; on_failure: string[] }> = {};
  for (const [name, r] of Object.entries(ROLES)) {
    const spec = { select: [{ default: await pinnedName(r.default) }], on_failure: await Promise.all(r.fallback.map(pinnedName)) };
    await upsertRoutingPolicy(name, spec);
    await waitUntilServing(name);
    out[name] = spec;
  }
  return out;
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
      prompt: q.prompt.slice(0, 8000), parent_model: q.parentModel, candidates, ...(q.endUser ? { user: q.endUser } : {}),
    });
    const probabilities = Object.fromEntries(Object.entries(r.data.probabilities ?? {}).map(([k, v]) => [byPinned.get(k) ?? k, v]));
    return { model: byPinned.get(r.data.model) ?? q.parentModel, probabilities, reason: r.data.reason ?? null, requestId: r.requestId, fallback: !byPinned.has(r.data.model) };
  } catch {
    return { model: q.parentModel, probabilities: {}, reason: null, requestId: null, fallback: true };
  }
}
