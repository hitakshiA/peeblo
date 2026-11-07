// Runs the agent-tool checks n1..n6 in order. Each is a real teammate turn on a cheap model; see each file.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

let failed = 0;
for (const name of ["n1-tools", "n2-routing", "n3-guard", "n4-connectors", "n5-decisions", "n6-budgets"]) {
  console.log(`\n# ${name}`);
  if (spawnSync(process.execPath, [join(import.meta.dirname, `${name}.ts`)], { stdio: "inherit", env: process.env }).status !== 0) failed++;
}
process.exit(failed ? 1 : 0);
