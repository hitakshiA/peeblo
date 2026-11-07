// Runs every live Otari check in order (a few cents of Otari spend). Core must be running for the turn checks,
// and OTARI_DASHBOARD_EMAIL / OTARI_DASHBOARD_PASSWORD must be set for the admin checks. The end-to-end run
// (e2e.ts) is separate, because it kills core halfway.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { loadDashboardLogin } from "./dashboard-login.ts";

if (!loadDashboardLogin()) console.log("note: no dashboard login found; the admin checks will fail");

const order = ["a-client", "j-admin", "c-people", "d-routing", "g-mcp", "h-guard", "i-rules", "k-search", "l-decisions", "bef-turns", "m-links", "n-agent-tools", "n7-deferred", "p2-runtime", "p2-secrets", "p2-k5", "p2-loop"];
const only = process.argv.slice(2);
let failed = 0;
for (const name of only.length ? only : order) {
  console.log(`\n# ${name}`);
  const r = spawnSync(process.execPath, [join(import.meta.dirname, `${name}.ts`)], { stdio: "inherit", env: process.env });
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} check file(s) had failures` : "\nall Otari checks passed");
process.exit(failed ? 1 : 0);
