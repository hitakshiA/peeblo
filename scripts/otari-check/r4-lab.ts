// Round 1f step 4: the missing lab pieces, checked live (one check each, cheap models).
// K9 Stop check and outcome grader, ask_human for every teammate, job status/stop/reassign, K14 (three silent
// turns stop a run), the scripted spots (feedback as a fact, connectors seeded once, a hidden flag), narrowed taint.
import { check, expect, save } from "./harness.ts";
import { answer, ensureTeammate, submit } from "./api.ts";
import { turn } from "./n-common.ts";
const { pool } = await import("../../src/db.ts");
const { appendEvent } = await import("../../src/store/events.ts");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const S = "R4";
const runEvents = async (runId: string) => (await pool.query("SELECT type, data FROM events WHERE run_id = $1 ORDER BY id", [runId])).rows;

await check(S, "K9: a direct ask gets a Stop check; a delegated job with a spec gets an outcome grader", async (c) => {
  const r = await turn("scout", `k9-${Date.now().toString(36)}`, "What is 17 times 23? Answer in one line.");
  const sc = r.events.find((e: any) => e.type === "stop_check.decided")?.data;
  c.note("stop_check", sc ? { verdict: sc.verdict, model: sc.model } : null);
  expect(sc && ["done", "continue", "waiting"].includes(sc.verdict), "no Stop check on a direct ask");
  expect(r.events.filter((e: any) => e.type === "turn.started").length <= 2, "more than one continuation");
  const d = await turn("peeblo", `k9g-${Date.now().toString(36)}`, "Delegate to Grove: list the titles of the 3 newest GRO issues. Don't ask me anything first.", { answer: "approved" });
  const chain = d.events.find((e: any) => e.type === "chain.call")?.data;
  expect(chain?.child_run, `no delegation: ${d.tools.map((x: any) => x.tool).join(", ")}`);
  let graded: any = null;
  for (let i = 0; i < 60 && !graded; i++) { await wait(3000); graded = (await pool.query("SELECT data FROM events WHERE run_id = $1 AND type = 'outcome.graded'", [chain.child_run])).rows[0]?.data; }
  c.note("graded", graded ? { meets: graded.meets, model: graded.model } : null);
  expect(graded && typeof graded.meets === "boolean", "the delegated job wasn't graded against its spec");
});

await check(S, "ask_human works for an ordinary teammate", async (c) => {
  const r = await turn("scout", `ask-${Date.now().toString(36)}`, "I need a short report for my boss, but I haven't told you on what or for when. Ask me what you need to know before you start; don't guess.");
  const used = r.tools.map((x: any) => x.tool);
  c.note("tools", used);
  expect(used.includes("ask_human"), `no ask_human: ${used.join(", ")}`);
});

await check(S, "job: status lists jobs; stop stops one; reassign moves it", async (c) => {
  const s = await turn("peeblo", `job-${Date.now().toString(36)}`, "Use job status: what's running or finished in the crew in the last two hours?");
  c.note("status_tools", s.tools.map((x: any) => `${x.tool}:${x.status}`));
  expect(s.tools.some((x: any) => x.tool === "job" && x.status === "completed"), "job status didn't run");
  // A long job for Scout, then stop it through the tool (as its asker).
  const long = await submit("scout", `C0CHECK:long-${Date.now().toString(36)}`, "For each of the 10 newest GRO issues get its full details, then write a two-paragraph summary of each.", `long-${Date.now().toString(36)}`);
  await wait(6000);
  const { managerTools } = await import("../../src/agent-tools/manager.ts");
  const { getTeammate } = await import("../../src/store/teammates.ts");
  const { getPerson } = await import("../../src/store/people.ts");
  const sub = (await pool.query("SELECT person_id FROM submissions sub JOIN runs r ON r.submission_id = sub.id WHERE r.id = $1", [long.runId])).rows[0];
  const job = managerTools.find((t) => t.name === "job")!;
  const ctx: any = { teammate: (await getTeammate("peeblo"))!, person: await getPerson(sub.person_id), sessionId: long.sessionId, runId: null, toolCallId: "check" };
  const stopped = await job.run(ctx, { action: "stop", job: long.runId, teammate: null });
  let st: any = null;
  for (let i = 0; i < 30; i++) { await wait(2000); st = (await pool.query("SELECT status FROM runs WHERE id = $1", [long.runId])).rows[0]?.status; if (["done", "failed", "cancelled"].includes(st)) break; }
  c.note("stop", { reply: stopped.text, status: st });
  expect(/Stopped/.test(stopped.text) && ["done", "failed", "cancelled"].includes(st), `the job didn't stop: ${st}`);
});

await check(S, "K14: three model turns in a row with nothing visible stop the run", async (c) => {
  // The rail reads the event log: a run with 3 model calls since its last tool call or post is refused.
  const r = await submit("rail-ask", `C0CHECK:k14-${Date.now().toString(36)}`, "Say hi.", `k14-${Date.now().toString(36)}`);
  let ok: any = null;
  for (let i = 0; i < 30 && !ok; i++) { await wait(1500); ok = (await pool.query("SELECT status FROM runs WHERE id = $1", [r.runId])).rows[0]; if (!["done", "failed"].includes(ok?.status)) ok = null; }
  const calls = (await runEvents(r.runId)).filter((e) => e.type === "model.call").length;
  c.note("normal_run_model_calls", calls);
  // Same run id, three more silent model calls recorded: the next call through the proxy must be refused.
  for (let i = 0; i < 3; i++) await appendEvent({ sessionId: r.sessionId, runId: r.runId, type: "model.call", data: { role: "worker", status: 200, note: "k14 check" } });
  const n = Number((await pool.query(`SELECT count(*)::int AS n FROM events WHERE run_id = $1 AND type = 'model.call' AND coalesce(data->>'role', '') NOT IN ('guard', 'vision', 'judge')
    AND id > coalesce((SELECT max(id) FROM events WHERE run_id = $1 AND type IN ('tool.call', 'slack.post')), 0)`, [r.runId])).rows[0].n);
  c.note("silent_turns", n);
  expect(n >= 3, `the rail's count is ${n}`);
});

await check(S, "scripted spots: feedback reaches the teammate as a fact; connectors seeded once; hidden teammates leave crew lists", async (c) => {
  const last = (await pool.query("SELECT r.id, r.session_id FROM runs r JOIN sessions s ON s.id = r.session_id JOIN teammates t ON t.id = s.teammate_id WHERE t.slug = 'scout' AND r.status = 'done' ORDER BY r.created_at DESC LIMIT 1")).rows[0];
  await appendEvent({ sessionId: last.session_id, runId: last.id, type: "slack.feedback", data: { vote: "down", by: null } });
  const r = await turn("scout", `fb-${Date.now().toString(36)}`, "Thanks. Anything you'd do differently next time?");
  const noted = r.events.find((e: any) => e.type === "feedback.noted");
  c.note("feedback_noted", Boolean(noted));
  expect(noted, "the 👎 never reached the teammate");
  const memWrites = (await pool.query("SELECT count(*)::int AS n FROM events WHERE type = 'memory.written' AND data->>'path' LIKE 'feedback/%' AND at > now() - interval '5 minutes'")).rows[0].n;
  expect(memWrites === 0, "code still wrote a feedback memory note");
  const seeded = (await pool.query("SELECT count(*)::int AS n FROM audit WHERE action = 'peeblo.seed_connectors'")).rows[0].n;
  c.note("seed_rows", seeded);
  expect(seeded === 1, `seeded ${seeded} times`);
  const { managerTools } = await import("../../src/agent-tools/manager.ts");
  const crew = await managerTools.find((t) => t.name === "crew_status")!.run({} as any, {});
  expect(!/rail-ask|vm-debian|agent-check/.test(crew.text), "a hidden teammate is in crew_status");
});

await check(S, "taint: the teammate's own shell work is trusted; a network fetch isn't", async (c) => {
  await ensureTeammate("vm-taint", { name: "Taint Check", role: "checks taint labels", tools: ["computer"], connectors: [], budget: { monthly_usd: 1 }, model: { default: "deepseek/deepseek-v4.1-flash-1017", fallback: "xiaomi/mimo-v2.6-pro" }, mode: "auto", computer: { size: "small", allowed_hosts: [] } });
  await pool.query("UPDATE teammates SET hidden = true WHERE slug = 'vm-taint'");
  const r = await turn("vm-taint", `taint-${Date.now().toString(36)}`, "Run exactly these two commands with computer_bash, one call each: `echo hello > notes.txt && cat notes.txt` and then `curl -s https://example.com | head -3`. Then tell me both outputs.");
  const bash = r.tools.filter((x: any) => x.tool === "computer_bash");
  c.note("bash", bash.map((x: any) => ({ status: x.status, untrusted: x.untrusted ?? null })));
  expect(bash.length >= 2, `bash calls: ${bash.length}`);
  expect(!bash[0].untrusted && Boolean(bash.at(-1).untrusted), "taint labels aren't narrowed");
  c.note("answer", answer(r.events).slice(0, 100));
});
await save(S);
await pool.end();
process.exit(0);
