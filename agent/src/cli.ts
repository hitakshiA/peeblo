import { cases } from "./store.ts";
import { runCase } from "./runner.ts";

// Local driver: `node src/cli.ts assign "<work description>"` or `node src/cli.ts resume <case_id> "<trigger>"`.
const [cmd, a, b] = process.argv.slice(2);
if (cmd === "assign" && a) {
  const c = cases.create(a.slice(0, 80), a);
  console.log(`case ${c.id}`);
  const r = await runCase(c.id, `Slack assignment: ${a}`, { onEvent: console.log });
  console.log("\n=== RESULT", r.status, "iterations", r.iterations, "tokens", r.usage.inputTokens, "/", r.usage.outputTokens, r.error ?? "");
  console.log(`status: ${r.case.status}\ntitle: ${r.case.title}\nsummary: ${r.case.summary}\nnext: ${r.case.next_action}`);
} else if (cmd === "resume" && a) {
  const r = await runCase(a, b ?? "manual resume", { onEvent: console.log });
  console.log("\n=== RESULT", r.status, r.case.status, "\n", r.case.summary, "\nnext:", r.case.next_action);
} else if (cmd === "list") {
  console.table(cases.list().map((c) => ({ id: c.id, status: c.status, title: c.title.slice(0, 60), next: (c.next_action ?? "").slice(0, 60) })));
} else {
  console.log('usage: node src/cli.ts assign "<work>" | resume <case_id> "<trigger>" | list');
}
