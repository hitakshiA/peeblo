// End-to-end harness (sandbox only): assign -> approval -> interrupt mid-correction -> resume -> verify.
// The approval here is issued by the harness on behalf of the configured approver, for automated testing.
import { cases, db } from "./store.ts";
import { runCase } from "./runner.ts";
import { decide, interrupts } from "./executor.ts";
import { env } from "./connectors.ts";
import { replay } from "./bus.ts";

const text = process.argv[2] ?? "Eastbridge still hasn't paid their Q3 invoice and their AP team says something is wrong with it. Can you take this and sort it out?";
const c = cases.create(text.slice(0, 80), `Slack assignment from Marcus Bell (AE): ${text}`);
const say = (...m: unknown[]) => console.log(`\n### ${m.join(" ")}`);
say("case", c.id);
let r = await runCase(c.id, `Slack assignment: ${text}`, { onEvent: (l) => console.log(l.slice(0, 260)) });
say("run 1", r.status, r.case.status, "|", r.case.summary);
const pending = db.prepare("SELECT a.id, o.kind FROM approvals a JOIN operations o ON o.id = a.operation_id WHERE a.case_id = ? AND a.status = 'pending'").all(c.id) as any[];
say("pending approvals", JSON.stringify(pending));
if (process.env.E2E_INTERRUPT !== "0") interrupts.arm("*");
for (const p of pending) say("decide", p.kind, JSON.stringify(await decide(p.id, env.SLACK_APPROVER_USER_IDS.split(",")[0], "approved")));
r = await runCase(c.id, "Resumed after interruption", { onEvent: (l) => console.log(l.slice(0, 260)) });
say("run 2", r.status, r.case.status, "|", r.case.summary, "| next:", r.case.next_action);
say("operations");
console.table(db.prepare("SELECT kind, status, verification FROM operations WHERE case_id = ?").all(c.id));
say("events", replay(c.id).length);
