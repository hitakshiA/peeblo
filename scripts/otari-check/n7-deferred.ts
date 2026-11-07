// K7b: a session starts with fewer than 20 tools; less-used connector tools are found with find_tools.
import { check, expect, save } from "./harness.ts";
import { calls } from "./api.ts";
import { teammate, turn } from "./n-common.ts";
import { pool } from "../../src/db.ts";

const S = "N7";
const tm = await teammate("agent-check");

await check(S, "a session starts with fewer than 20 tools", async (c) => {
  const r = await turn(tm, "few-tools", "List the three most recently updated issues in the GRO team in Linear.");
  const first = calls(r.events).find((x) => x.role !== "guard" && x.status === 200);
  expect(first && first.tools_declared > 0 && first.tools_declared < 20, `first call declared ${first?.tools_declared} tools`);
  c.note("tools_declared", first.tools_declared);
  c.note("tools", r.tools.map((x: any) => `${x.tool}:${x.status}`));
});

await check(S, "a less-used connector tool is found with find_tools, then used", async (c) => {
  const r = await turn(tm, "find-tool", "Which issue labels exist in the GRO team in Linear?");
  const used = r.tools.map((x: any) => x.tool);
  const later = calls(r.events).filter((x) => x.role !== "guard" && x.status === 200).map((x) => x.tools_declared);
  c.note("tools", r.tools.map((x: any) => `${x.tool}:${x.status}`));
  c.note("declared_per_call", later);
  expect(used.some((t: string) => /label/.test(t)), `no label tool used: ${used.join(", ")}`);
  expect(Math.max(...later) > Math.min(...later), "the declared set never grew (find_tools didn't turn anything on)");
});
await pool.end();
process.exit((await save(S)) ? 0 : 1);
