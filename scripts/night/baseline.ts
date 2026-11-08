// The night's spend baseline (NIGHT_PLAN_NOV9.md §0): /key/budget and /key/usage/summary for Peeblo's main key and
// every live teammate key, at the moment the night starts. The night cap counts spend from `at`.
//   node scripts/night/baseline.ts            → writes local/night/spend-start.json (refuses to overwrite)
//   node scripts/night/baseline.ts --status   → spend since the baseline, per key
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
const { pool } = await import("../../src/db.ts");
const { otari, usageSummary } = await import("../../src/otari/client.ts");
const { unseal } = await import("../../src/crypto.ts");

const FILE = "local/night/spend-start.json";
const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); };

if (process.argv.includes("--status")) {
  const { nightSpend } = await import("../../src/otari/night-cap.ts");
  console.log(JSON.stringify(await nightSpend()));
  await pool.end(); process.exit(0);
}
if (existsSync(FILE)) { console.error(`${FILE} exists; the night already has a baseline.`); process.exit(1); }

const at = new Date().toISOString();
const keys: any[] = [];
const read = async (name: string, auth?: Record<string, string>, keyId: string | null = null) => {
  const budget = await otari<any>("GET", "/key/budget", undefined, { auth }).then((r) => r.data).catch((e) => ({ error: String(e.message).slice(0, 200) }));
  const usage = await usageSummary({ start: monthStart(), auth }).then((u) => u.totals).catch((e) => ({ error: String(e.message).slice(0, 200) }));
  keys.push({ name, key_id: keyId, budget, usage_month_to_date: usage });
};
await read("core");
const { rows } = await pool.query("SELECT k.key_id, k.secret, t.slug FROM teammate_keys k JOIN teammates t ON t.id = k.teammate_id WHERE k.retired_at IS NULL ORDER BY t.slug");
for (const r of rows) await read(r.slug, { authorization: `Bearer ${unseal<string>(r.secret)}` }, r.key_id);
mkdirSync("local/night", { recursive: true });
writeFileSync(FILE, JSON.stringify({ at, cap_usd: 5, model: "deepseek/deepseek-v4.1-flash-1017", keys }, null, 2));
const total = keys.reduce((a, k) => a + Number(k.usage_month_to_date?.cost ?? 0), 0);
console.log(`baseline at ${at}: ${keys.length} keys, month-to-date spend $${total.toFixed(4)}`);
await pool.end();
process.exit(0);
