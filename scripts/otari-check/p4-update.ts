// teammate_update's rails (K5, K6): only the owner or an admin can change a teammate; raising a capability asks
// first, lowering applies at once; YOLO is admin only. Calls the tool's own checks and its run, on a real teammate.
import { check, expect, save } from "./harness.ts";
const { pool } = await import("../../src/db.ts");
const { managerTools } = await import("../../src/agent-tools/manager.ts");
const { getTeammate } = await import("../../src/store/teammates.ts");
const { getPerson } = await import("../../src/store/people.ts");

const S = "P4U";
const tool = managerTools.find((t) => t.name === "teammate_update")!;
const grove = (await getTeammate("grove"))!;
const owner = (await getPerson(grove.owner_person!))!;
const other = (await pool.query("SELECT * FROM people WHERE slack_user = 'U0CFQ1B4KK8'")).rows[0]; // Jun
const peeblo = (await getTeammate("peeblo"))!;
const ctx = (person: any) => ({ teammate: peeblo, person, sessionId: "se_check", runId: null, endUser: null, toolCallId: "tc", otariKey: null, subagent: false });

await check(S, "someone who isn't the owner or an admin is refused", async (c) => {
  const r = await tool.authorize!(ctx(other) as any, { teammate: "Grove", field: "budget_usd", value: "50", reason: "check" });
  expect(r && /owner or an admin/.test(r), `refusal: ${r}`);
  c.note("refusal", r);
});
await check(S, "the owner raising a capability is asked first; lowering applies at once", async (c) => {
  const up = await tool.gate!(ctx(owner) as any, { teammate: "Grove", field: "budget_usd", value: String(grove.config.budget.monthly_usd + 10), reason: "check" });
  const down = await tool.gate!(ctx(owner) as any, { teammate: "Grove", field: "budget_usd", value: String(Math.max(1, grove.config.budget.monthly_usd - 1)), reason: "check" });
  expect(up?.ask && !down, `raise: ${JSON.stringify(up)} lower: ${JSON.stringify(down)}`);
  const before = (await getTeammate("grove"))!.version;
  await tool.run(ctx(owner) as any, { teammate: "Grove", field: "budget_usd", value: String(Math.max(1, grove.config.budget.monthly_usd - 1)), reason: "check" });
  const after = (await getTeammate("grove"))!;
  expect(after.version === before + 1, "no new config version");
  await tool.run(ctx(owner) as any, { teammate: "Grove", field: "budget_usd", value: String(grove.config.budget.monthly_usd), reason: "check: restore" });
  c.note("versions", [before, after.version]);
});
await check(S, "YOLO is admin only", async () => {
  const r = await tool.authorize!(ctx(owner) as any, { teammate: "Grove", field: "mode", value: "yolo", reason: "check" });
  expect(r && /admin/.test(r), `refusal: ${r}`);
});
await pool.end();
process.exit((await save(S)) ? 0 : 1);
