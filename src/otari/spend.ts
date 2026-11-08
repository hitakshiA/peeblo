// Per-teammate spend. Two modes, picked by PEEBLO_TEAMMATE_SPEND (default "auto"):
// - "key": each teammate gets its own Otari service key with its own spend ceiling (its monthly budget).
//   Otari enforces the cap too. Needs the dashboard session to make keys; then every model call of that
//   teammate goes out on its key.
// - "tag": every call carries Otari-Tags teammate=<slug>; Otari reports spend by tag.
// "auto" uses "key" when a session exists, else "tag". In both modes the proxy refuses a call before it
// leaves for Otari when its estimate would go over the teammate's budget or the person's tier (capCheck).
import { config } from "../config.ts";
import { seal, unseal } from "../crypto.ts";
import { pool } from "../db.ts";
import type { Teammate } from "../store/teammates.ts";
import { createBudget, createKeyCeiling, createServiceKey, deleteBudget, deleteCeiling, deleteKey, session, updateBudget } from "./admin.ts";
import { otari, OtariError, usageSummary } from "./client.ts";
import { tiers } from "./people.ts";

export type SpendMode = "key" | "tag";
export async function spendMode(): Promise<SpendMode> {
  if (config.teammateSpend === "key" || config.teammateSpend === "tag") return config.teammateSpend;
  return (await session()) ? "key" : "tag";
}

type KeyRow = { key_id: string; secret: Buffer; budget_id: string | null; ceiling_id: string | null; monthly_usd: string | null };

// The teammate's own key (made on first use), with its ceiling kept at the teammate's monthly budget.
// Sessions of a new teammate can start together, so creation runs one at a time per teammate.
const making = new Map<string, Promise<{ keyId: string; secret: string } | null>>();
export async function teammateKey(tm: Teammate): Promise<{ keyId: string; secret: string } | null> {
  if ((await spendMode()) !== "key") return null;
  const pending = making.get(tm.id);
  if (pending) return pending;
  const p = teammateKeyOnce(tm).finally(() => making.delete(tm.id));
  making.set(tm.id, p);
  return p;
}

async function teammateKeyOnce(tm: Teammate): Promise<{ keyId: string; secret: string } | null> {
  const { rows } = await pool.query<KeyRow>("SELECT key_id, secret, budget_id, ceiling_id, monthly_usd FROM teammate_keys WHERE teammate_id = $1 AND retired_at IS NULL", [tm.id]);
  const want = tm.config.budget.monthly_usd;
  if (rows[0]) {
    if (rows[0].budget_id && Number(rows[0].monthly_usd) !== want) {
      await updateBudget(rows[0].budget_id, want);
      await pool.query("UPDATE teammate_keys SET monthly_usd = $2 WHERE teammate_id = $1", [tm.id, want]);
    }
    return { keyId: rows[0].key_id, secret: unseal<string>(rows[0].secret) };
  }
  const name = `peeblo-teammate-${tm.slug}`;
  // People keep the tiers they have on Peeblo's main key.
  const t = await tiers();
  const budget = await createBudget(name, want);
  const key = await createServiceKey(name, t.map((x) => x.budget_id), t.find((x) => x.is_default)?.budget_id);
  const ceiling = await createKeyCeiling(key.id, budget.id, name);
  await pool.query(
    "INSERT INTO teammate_keys (teammate_id, key_id, secret, budget_id, ceiling_id, monthly_usd) VALUES ($1, $2, $3, $4, $5, $6)",
    [tm.id, key.id, seal(key.key), budget.id, ceiling.id, want],
  );
  await pool.query("INSERT INTO audit (actor, action, target, data) VALUES ('peeblo', 'otari.teammate_key.create', $1, $2)", [tm.id, { key_id: key.id, budget_id: budget.id, ceiling_id: ceiling.id, monthly_usd: want }]);
  return { keyId: key.id, secret: key.key };
}

// Removes the teammate's key, ceiling and budget from Otari (on fire, or when switching modes).
export async function retireTeammateKey(teammateId: string): Promise<void> {
  const { rows } = await pool.query<KeyRow>("SELECT key_id, secret, budget_id, ceiling_id, monthly_usd FROM teammate_keys WHERE teammate_id = $1 AND retired_at IS NULL", [teammateId]);
  if (!rows[0]) return;
  if (rows[0].ceiling_id) await deleteCeiling(rows[0].ceiling_id);
  await deleteKey(rows[0].key_id);
  if (rows[0].budget_id) await deleteBudget(rows[0].budget_id);
  await pool.query("UPDATE teammate_keys SET retired_at = now() WHERE teammate_id = $1", [teammateId]);
}

const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); };
export const usd = (v: number) => (v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);

// Spend readers. Otari is the record; Peeblo reads it at most every 30 s and adds what this core has spent
// since (the proxy notes each call's cost), so a burst of calls can't slip past a cap between reads.
type Reading = { at: number; spent: number; cap: number | null; label: string };
const readings = new Map<string, Reading>();
const sinceRead = new Map<string, number>();
const FRESH_MS = 30_000;
export function noteSpend(teammateId: string, endUser: string | null, usdSpent: number): void {
  for (const k of [`tm:${teammateId}`, ...(endUser ? [`person:${endUser}`] : [])]) {
    sinceRead.set(k, (sinceRead.get(k) ?? 0) + usdSpent);
    const list = notes.get(k) ?? [];
    list.push({ at: Date.now(), usd: usdSpent });
    while (list.length > 500) list.shift();
    notes.set(k, list);
    if (!spentBefore.has(k)) spentBefore.set(k, (t) => {
      const l = notes.get(k) ?? [];
      const before = l.filter((x) => x.at < t).reduce((a, x) => a + x.usd, 0);
      notes.set(k, l.filter((x) => x.at >= t));
      return before;
    });
  }
}
// A stale reading is still used (plus what was spent since) while a fresh one loads in the background, so no
// model call waits on Otari's usage reads; only the first reading for a key is awaited.
const loading = new Map<string, Promise<Reading>>();
async function reading(key: string, read: () => Promise<Omit<Reading, "at">>): Promise<Reading> {
  const r = readings.get(key);
  const load = () => {
    let p = loading.get(key);
    if (!p) {
      const started = Date.now();
      p = read().then((x) => {
        const fresh = { ...x, at: Date.now() };
        readings.set(key, fresh);
        // Spend noted after the read started stays counted on top of it.
        sinceRead.set(key, Math.max(0, (sinceRead.get(key) ?? 0) - (spentBefore.get(key)?.(started) ?? 0)));
        return fresh;
      }).finally(() => loading.delete(key));
      loading.set(key, p);
    }
    return p;
  };
  if (r && Date.now() - r.at < FRESH_MS) return { ...r, spent: r.spent + (sinceRead.get(key) ?? 0) };
  if (r) { void load().catch(() => {}); return { ...r, spent: r.spent + (sinceRead.get(key) ?? 0) }; }
  const fresh = await load();
  return { ...fresh, spent: fresh.spent + (sinceRead.get(key) ?? 0) };
}
// What was noted for a key before a moment (so a background read doesn't drop spend that came after it began).
const notes = new Map<string, { at: number; usd: number }[]>();
const spentBefore = new Map<string, (t: number) => number>();

// The teammate this month: its own key's ceiling use in key mode, else its tag's spend.
export async function teammateSpend(tm: Teammate): Promise<{ spent: number; cap: number; mode: SpendMode }> {
  const mode = await spendMode();
  const cap = tm.config.budget.monthly_usd;
  const r = await reading(`tm:${tm.id}`, async () => {
    if (mode === "key") {
      const k = await teammateKey(tm);
      if (k) {
        const b = (await otari<any>("GET", "/key/budget", undefined, { auth: { authorization: `Bearer ${k.secret}` } })).data;
        return { spent: Number(b.limits?.[0]?.used_usd ?? 0), cap, label: tm.config.name };
      }
    }
    return { spent: (await usageSummary({ start: monthStart(), tag: `teammate:${tm.slug}` })).totals.cost ?? 0, cap, label: tm.config.name };
  });
  return { spent: r.spent, cap, mode };
}

// A person across all of Peeblo's keys (end users belong to the key that made them), against their tier.
export async function personSpend(externalId: string): Promise<{ spent: number; cap: number | null; tier: string | null }> {
  const r = await reading(`person:${externalId}`, async () => {
    const { rows } = await pool.query<{ key_id: string; secret: Buffer }>("SELECT key_id, secret FROM teammate_keys WHERE retired_at IS NULL");
    const auths = [undefined, ...rows.map((x) => ({ authorization: `Bearer ${unseal<string>(x.secret)}` }))];
    let spent = 0;
    let budgetId: string | null = null;
    // Every key at once (one by one took ~12 s with 44 keys).
    const users = await Promise.all(auths.map(async (auth) => {
      try { return (await otari<any>("GET", `/end-users/${encodeURIComponent(externalId)}`, undefined, { auth })).data; }
      catch (e) { if ((e as OtariError).status !== 404) throw e; return null; }
    }));
    for (const u of users) if (u) { spent += Number(u.spend ?? 0); budgetId ??= u.budget_id ?? null; }
    const t = await tiers();
    const tier = t.find((x) => x.budget_id === budgetId) ?? t.find((x) => x.is_default);
    return { spent, cap: tier?.max_budget ?? null, label: tier?.name ?? "" };
  });
  return { spent: r.spent, cap: r.cap, tier: r.label || null };
}

// The proxy's check before a model call leaves for Otari (K16): the call's estimate must fit the teammate's
// monthly budget and the person's tier, across every key Peeblo holds.
export type CapRefusal = { scope: "teammate" | "user" | "unchecked"; spent: number; cap: number; estimate: number; message: string };
export async function capCheck(tm: Teammate, endUser: string | null, model: string, estimate: number): Promise<CapRefusal | null> {
  const t = await teammateSpend(tm);
  if (t.spent + estimate > t.cap) return { scope: "teammate", spent: t.spent, cap: t.cap, estimate, message: `${tm.config.name} has ${usd(Math.max(0, t.cap - t.spent))} of its ${usd(t.cap)} monthly budget left, less than this call's estimated cost of ${usd(estimate)} (${model}).` };
  if (endUser) {
    const p = await personSpend(endUser);
    if (p.cap !== null && p.spent + estimate > p.cap) return { scope: "user", spent: p.spent, cap: p.cap, estimate, message: `This person has ${usd(Math.max(0, p.cap - p.spent))} of budget remaining across Peeblo's teammates, less than this call's estimated cost of ${usd(estimate)}.` };
  }
  return null;
}
