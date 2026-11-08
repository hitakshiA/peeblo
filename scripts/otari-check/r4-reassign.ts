// Round 1f step 4, follow-up: job reassign, live. A long job for Scout is moved to Grove with the job tool (as the
// person who asked): Scout's run stops, and Grove gets the same request as a delegated job and finishes it.
import { check, expect, save } from "./harness.ts";
import { submit } from "./api.ts";
import { turn } from "./n-common.ts";
const { pool } = await import("../../src/db.ts");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const S = "R4R";

await check(S, "job reassign stops the job and hands the same request to another teammate", async (c) => {
  const long = await submit("scout", `C0CHECK:reassign-${Date.now().toString(36)}`, "For each of the 8 newest GRO issues get its full details, then write a two-line summary of each.", `reassign-${Date.now().toString(36)}`);
  await wait(6000);
  // Peeblo moves it with its job tool, in a turn asked by the same person who asked for the job.
  const t = await turn("peeblo", `reassign-${Date.now().toString(36)}`, `Use the job tool to reassign job ${long.runId} to Grove. Don't ask me anything first.`);
  const used = t.tools.map((x: any) => `${x.tool}:${x.status}`);
  c.note("peeblo_tools", used);
  expect(t.tools.some((x: any) => x.tool === "job" && x.status === "completed"), `job didn't run: ${used.join(", ")}`);
  const call = t.events.find((e: any) => e.type === "chain.call")?.data;
  expect(call?.callee === "grove", `no hand-off to Grove: ${JSON.stringify(call)}`);
  const child = call.child_run;
  let a: any = null, b: any = null;
  for (let i = 0; i < 90; i++) {
    await wait(3000);
    a = (await pool.query("SELECT status FROM runs WHERE id = $1", [long.runId])).rows[0]?.status;
    b = (await pool.query("SELECT r.status, t.slug, left(sub.text, 80) AS t FROM runs r JOIN sessions s ON s.id = r.session_id JOIN teammates t ON t.id = s.teammate_id JOIN submissions sub ON sub.id = r.submission_id WHERE r.id = $1", [child])).rows[0];
    if (["done", "failed"].includes(a) && ["done", "failed"].includes(b?.status)) break;
  }
  c.note("scout_run", a); c.note("grove_run", b);
  expect(["done", "failed", "cancelled"].includes(a), `Scout's run is still ${a}`);
  expect(b?.slug === "grove" && b.status === "done" && /8 newest GRO/.test(b.t), `Grove's run: ${JSON.stringify(b)}`);
});
await save(S);
await pool.end();
process.exit(0);
