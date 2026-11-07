// Item 5: typed judges are called by code at hook points and are never agent tools. The judge's own checks
// (typed answers, unknown, safe default) are l-decisions.ts, run first: loading config removes the secret
// variables from this process's environment, so the child must start before anything imports it.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const judge = spawnSync(process.execPath, [join(import.meta.dirname, "l-decisions.ts")], { stdio: "inherit", env: process.env });
const H = await import("./harness.ts");
const { check, save } = H;
const expect: (cond: unknown, message: string) => asserts cond = H.expect;
const { peebloTools } = await import("../../src/agent-tools/index.ts");
const { getTeammate } = await import("../../src/store/teammates.ts");
const { pool } = await import("../../src/db.ts");

const S = "N5";
await check(S, "no session's tool list has a decision tool", async (c) => {
  const tm = await getTeammate("agent-check");
  if (!tm) throw new Error("no agent-check teammate");
  const names = peebloTools(tm).map((t) => t.name);
  expect(!names.some((n) => /decide|decision|judge/.test(n)), `tools: ${names.join(", ")}`);
  c.note("tools", names);
});
await check(S, "the judge's typed answers, unknown and safe default (l-decisions)", async () => {
  expect(judge.status === 0, "l-decisions failed");
});
await pool.end();
process.exit((await save(S)) ? 0 : 1);
