// Item 6: money is code. A teammate whose monthly budget can't cover a call is refused by the proxy before
// the call reaches Otari, in Otari's own refusal shape; the person gets a plain sentence.
import { check, expect, save } from "./harness.ts";
import { answer } from "./api.ts";
import { teammate, turn } from "./n-common.ts";
import { pool } from "../../src/db.ts";

const S = "N6";
const tm = await teammate("cap-check", { tools: [], connectors: [], budget: { monthly_usd: 0.00001 } });

await check(S, "an over-cap call is refused before it reaches Otari", async (c) => {
  const r = await turn(tm, "over-cap", "Write a short paragraph about our refund policy.");
  const blocked = r.events.filter((e: any) => e.type === "budget.blocked");
  // The guard model screening the message is not the teammate's call; the teammate's own calls must not reach Otari.
  const reachedOtari = r.events.filter((e: any) => e.type === "model.call.opened" || (e.type === "model.call" && e.data.role !== "guard" && e.data.request_id));
  expect(blocked.some((e: any) => e.data.by === "peeblo" && e.data.scope === "teammate"), `blocked events ${JSON.stringify(blocked.map((e: any) => e.data))}`);
  expect(!reachedOtari.length, `${reachedOtari.length} calls reached Otari`);
  expect(/budget/i.test(answer(r.events)), `reply: ${answer(r.events)}`);
  c.note("reply", answer(r.events));
  c.note("refusal", blocked[0]?.data?.message);
});
await pool.end();
process.exit((await save(S)) ? 0 : 1);
