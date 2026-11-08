// The night cap (design/NIGHT_PLAN_NOV9.md §0): a hard stop on Otari spend for a run, counted from Otari's own
// usage, never estimated. A baseline file names when the run started; spend since then is each key's
// /key/usage/summary from that moment (Peeblo's main key plus every live teammate key), read every 30 s, plus
// the cost of model calls Peeblo logged since the last read. At the cap, the proxy refuses every model call.
// Off unless the baseline file exists (PEEBLO_NIGHT_BASELINE, default local/night/spend-start.json).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { unseal } from "../crypto.ts";
import { pool } from "../db.ts";
import { usageSummary } from "./client.ts";

const FILE = process.env.PEEBLO_NIGHT_BASELINE ?? join(import.meta.dirname, "..", "..", "local", "night", "spend-start.json");
const CAP = Number(process.env.PEEBLO_NIGHT_CAP_USD ?? 5);
const EVERY_MS = 30_000;

type Baseline = { at: string; cap_usd?: number };
let base: Baseline | null | undefined;
let last: { at: number; spent: number; byKey: Record<string, number> } | null = null;
let reading: Promise<void> | null = null;

function baseline(): Baseline | null {
  if (base !== undefined) return base;
  base = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as Baseline) : null;
  return base;
}

// Every key whose spend counts: Peeblo's own, and each teammate key not retired before the run began.
async function keys(start: Date): Promise<{ name: string; auth?: Record<string, string> }[]> {
  const out: { name: string; auth?: Record<string, string> }[] = [{ name: "core" }];
  const { rows } = await pool.query("SELECT k.key_id, k.secret, t.slug FROM teammate_keys k JOIN teammates t ON t.id = k.teammate_id WHERE k.retired_at IS NULL OR k.retired_at > $1", [start]);
  for (const r of rows) out.push({ name: `${r.slug}:${r.key_id}`, auth: { authorization: `Bearer ${unseal<string>(r.secret)}` } });
  return out;
}

async function refresh(b: Baseline): Promise<void> {
  const start = new Date(b.at);
  const byKey: Record<string, number> = {};
  let spent = 0;
  const ks = await keys(start);
  // All keys at once. A key that can't be read counts as unknown: keep its last value rather than dropping it to zero.
  const vals = await Promise.all(ks.map((k) => usageSummary({ start, auth: k.auth }).then((u) => Number(u.totals.cost ?? 0)).catch(() => last?.byKey[k.name] ?? 0)));
  ks.forEach((k, i) => { byKey[k.name] = vals[i]; spent += vals[i]; });
  last = { at: Date.now(), spent, byKey };
}

// Spend since the baseline: Otari's figure (≤ 30 s old) plus what Peeblo logged since that read.
export async function nightSpend(): Promise<{ spent: number; cap: number; at: string } | null> {
  const b = baseline();
  if (!b) return null;
  if (!last || Date.now() - last.at > EVERY_MS) {
    reading ??= refresh(b).finally(() => { reading = null; });
    if (!last) await reading; // the first read is awaited; later ones refresh in the background
  }
  const since = new Date(last?.at ?? Date.now());
  const logged = Number((await pool.query("SELECT coalesce(sum((data->>'cost_usd')::numeric), 0) AS c FROM events WHERE type = 'model.call' AND at > $1", [since])).rows[0].c);
  return { spent: (last?.spent ?? 0) + logged, cap: b.cap_usd ?? CAP, at: b.at };
}

// The proxy's check: a refusal sentence at the cap, else null.
export async function overNightCap(): Promise<string | null> {
  const n = await nightSpend().catch(() => null);
  if (!n) return null;
  return n.spent >= n.cap ? `The night budget is used up ($${n.spent.toFixed(2)} of $${n.cap.toFixed(2)} since ${n.at}), so model calls are stopped.` : null;
}

void config;
