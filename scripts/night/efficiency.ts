// The night's efficiency probes (NIGHT_PLAN_NOV9 §1): six real turns, measured only from the event log.
//   node scripts/night/efficiency.ts <label>   → appends a table to local/night/efficiency.md
// Per probe: model calls, prompt tokens, cached share (from the second call), tools declared on the first call,
// seconds, cost, any Otari code execution or fetch calls (must be 0), and guessed GitHub owners (a miss). A delegation counts its child runs.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { turn } from "../otari-check/n-common.ts";
const { pool } = await import("../../src/db.ts");

const label = process.argv[2] ?? "run";
const stamp = () => Date.now().toString(36);
const PROBES: { name: string; slug: string; text: string; answer?: "approved" | "denied" }[] = [
  { name: "\"hi\" to Peeblo", slug: "peeblo", text: "hi" },
  { name: "\"who are you\" to a teammate", slug: "scout", text: "who are you" },
  { name: "one lookup", slug: "peeblo", text: "what's GRO-6 about?" },
  { name: "a two-tool read", slug: "peeblo", text: "what are the 3 newest GRO issues, and is there an open PR on acme-web for any of them?" },
  { name: "a delegate", slug: "peeblo", text: "have Grove list the titles of the 3 newest GRO issues for me", answer: "approved" },
  { name: "a write with an approval", slug: "scout", text: "add a comment saying 'efficiency probe' to GRO-323 in Linear", answer: "denied" },
];

async function chainRuns(root: string): Promise<string[]> {
  const kids = (await pool.query("SELECT data->>'child_run' AS r FROM events WHERE type = 'chain.call' AND data->>'root' = $1", [root])).rows.map((r) => r.r);
  return [root, ...kids];
}

const rows: string[] = [];
for (const p of PROBES) {
  const r = await turn(p.slug, `eff-${label}-${stamp()}`, p.text, p.answer ? { answer: p.answer } : {});
  await new Promise((x) => setTimeout(x, 3000));
  const runs = await chainRuns(r.runId);
  // Wait for children (a delegation) to finish too, up to 3 minutes.
  for (let i = 0; i < 60; i++) {
    const open = (await pool.query("SELECT count(*)::int n FROM runs WHERE id = ANY($1) AND status IN ('queued','running','waiting')", [runs])).rows[0].n;
    if (!open) break;
    await new Promise((x) => setTimeout(x, 3000));
  }
  const calls = (await pool.query("SELECT data FROM events WHERE run_id = ANY($1) AND type = 'model.call' AND data->>'status' = '200' ORDER BY id", [runs])).rows.map((x) => x.data);
  const first = (await pool.query("SELECT data FROM events WHERE run_id = $1 AND type = 'model.call' ORDER BY id LIMIT 1", [r.runId])).rows[0]?.data;
  const t = (await pool.query("SELECT min(at) a, max(at) b FROM events WHERE run_id = ANY($1)", [runs])).rows[0];
  const otariTools = (await pool.query("SELECT count(*)::int n FROM events WHERE run_id = ANY($1) AND type = 'tool.call' AND data->>'by' = 'otari' AND data->>'tool' IN ('code_execution', 'web_fetch')", [runs])).rows[0].n;
  // A guessed GitHub owner is a miss: a repo call that GitHub answers with "not found" or "can't be searched".
  const guesses = (await pool.query("SELECT count(*)::int n FROM events WHERE run_id = ANY($1) AND type = 'tool.call' AND data->>'tool' LIKE 'github\\_\\_%' AND data->>'status' = 'failed' AND (data->>'error' ~ '404 Not Found' OR data->>'error' ~ 'cannot be searched')", [runs])).rows[0].n;
  const prompt = calls.reduce((a, c) => a + Number(c.prompt_tokens ?? 0), 0);
  const later = calls.slice(1);
  const cached = later.reduce((a, c) => a + Number(c.cached_tokens ?? 0), 0) / Math.max(1, later.reduce((a, c) => a + Number(c.prompt_tokens ?? 0), 0));
  const cost = calls.reduce((a, c) => a + Number(c.cost_usd ?? 0), 0);
  const secs = (new Date(t.b).getTime() - new Date(t.a).getTime()) / 1000;
  rows.push(`| ${p.name} | ${calls.length} | ${prompt.toLocaleString("en-US")} | ${later.length ? `${Math.round(cached * 100)}%` : "–"} | ${first?.tools_declared ?? "?"} | ${secs.toFixed(1)} | $${cost.toFixed(5)} | ${otariTools} | ${guesses} | \`${r.runId}\` |`);
  console.log(rows.at(-1));
}
mkdirSync("local/night", { recursive: true });
const FILE = "local/night/efficiency.md";
if (!existsSync(FILE)) writeFileSync(FILE, "# Efficiency probes (NIGHT_PLAN_NOV9 §1), from the event log\n");
appendFileSync(FILE, `\n## ${label} (${new Date().toISOString()})\n\n| Probe | Calls | Prompt tokens | Cached (2nd call on) | Tools declared | Seconds | $ | Otari code/fetch | Owner guesses (miss) | Run |\n|---|---|---|---|---|---|---|---|---|---|\n${rows.join("\n")}\n`);
await pool.end();
process.exit(0);
