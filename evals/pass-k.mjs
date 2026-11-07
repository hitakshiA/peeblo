// pass^k from a Promptfoo results file run with --repeat k: a case passes only if every one of its k runs passed.
import { readFileSync } from "node:fs";

const file = process.argv[2];
const need = Number(process.argv[3] ?? 1); // required share of cases passing all k runs (1 = every case)
const j = JSON.parse(readFileSync(file, "utf8"));
const rows = j.results?.results ?? j.results ?? [];
const byCase = new Map();
for (const r of rows) {
  const key = `${r.provider?.label ?? r.provider?.id ?? ""} · ${r.testCase?.description ?? r.vars?.request}`;
  const c = byCase.get(key) ?? { runs: 0, passed: 0, reasons: [] };
  c.runs++;
  if (r.success) c.passed++; else c.reasons.push(r.gradingResult?.reason ?? r.error ?? "failed");
  byCase.set(key, c);
}
let all = 0;
for (const [k, c] of byCase) {
  const ok = c.passed === c.runs;
  if (ok) all++;
  console.log(`${ok ? "✓" : "✗"} ${k}  ${c.passed}/${c.runs}${ok ? "" : `  — ${c.reasons[0]?.slice(0, 160)}`}`);
}
const share = byCase.size ? all / byCase.size : 0;
console.log(`\npass^k: ${all}/${byCase.size} cases passed every run (${(share * 100).toFixed(0)}%)`);
// The gate counts only the role models; providers labelled "baseline-…" are reported apart.
const split = (base) => { const cs = [...byCase].filter(([k]) => k.startsWith("baseline-") === base); return `${cs.filter(([, c]) => c.passed === c.runs).length}/${cs.length}`; };
console.log(`gate (role models): ${split(false)}  ·  baseline: ${split(true)}`);
process.exit(share >= need ? 0 : 1);
