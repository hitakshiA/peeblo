// Regrades a saved Promptfoo results file with the current trace assertion (no model calls), then prints pass^k.
import { readFileSync, writeFileSync } from "node:fs";
import grade from "./assert/tools.mjs";
const file = process.argv[2];
const j = JSON.parse(readFileSync(file, "utf8"));
for (const r of j.results.results) {
  if (!r.response?.output) continue;
  const g = grade(r.response.output, { vars: r.vars ?? r.testCase?.vars ?? {} });
  const rubric = (r.gradingResult?.componentResults ?? []).filter((c) => c.assertion?.type === "llm-rubric");
  r.success = g.pass && rubric.every((c) => c.pass);
  r.gradingResult = { ...(r.gradingResult ?? {}), reason: g.reason };
}
writeFileSync(file.replace(/\.json$/, ".regraded.json"), JSON.stringify(j));
