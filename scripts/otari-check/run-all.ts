// Runs every live Otari check in order (a few cents of Otari spend). Core must be running for the turn checks,
// and OTARI_DASHBOARD_EMAIL / OTARI_DASHBOARD_PASSWORD must be set for the admin checks. The end-to-end run
// (e2e.ts) is separate, because it kills core halfway.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const order = ["a-client", "j-admin", "c-people", "d-routing", "g-mcp", "h-guard", "i-rules", "k-search", "l-decisions", "bef-turns", "m-links", "n-agent-tools"];
let failed = 0;
for (const name of order) {
  console.log(`\n# ${name}`);
  const r = spawnSync(process.execPath, [join(import.meta.dirname, `${name}.ts`)], { stdio: "inherit", env: process.env });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} check file(s) had failures` : "\nall Otari checks passed");
process.exit(failed ? 1 : 0);
