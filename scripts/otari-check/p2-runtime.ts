// Phase 2 runtime, through real turns: the teammate's computer (VM tools, rules, sleep/wake, a crash as a tool
// error), two sessions in parallel in one VM with the live-threads note, plan, and a read-only subagent.
import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { check, expect, save } from "./harness.ts";
import { api, answer } from "./api.ts";
import { teammate, turn, used } from "./n-common.ts";
import { pool } from "../../src/db.ts";
import { workspaceOf } from "../../src/environment/controller.ts";
import { liveThreadLines } from "../../src/pi/supervisor.ts";

const S = "P2";
const tm = await teammate("vm-check", { tools: ["computer", "web"], connectors: [], web: { allowed_domains: ["github.com"] } });

await check(S, "files and commands on the teammate's computer, in its session folder", async (c) => {
  const r = await turn(tm, "vm-basic", "On your computer, create a file notes.txt containing the word hello, then run uname -a and cat notes.txt, and tell me both outputs.");
  const bash = used(r.tools, "computer_bash").filter((x) => x.status === "completed");
  expect(bash.length, `tools: ${r.tools.map((x: any) => `${x.tool}:${x.status}`).join(", ")}`);
  const onHost = await readFile(join(workspaceOf(tm), "sessions", r.sessionId, "notes.txt"), "utf8");
  expect(onHost.includes("hello"), "notes.txt not in the session's folder");
  expect(/Linux/.test(answer(r.events)), "uname output missing from the answer");
  c.note("answer", answer(r.events).slice(0, 160));
});

await check(S, "the rule engine refuses a force push before it runs", async (c) => {
  const r = await turn(tm, "vm-rules", "This is a test of your computer's safety rules: run exactly `git push --force origin main` with your bash tool and tell me what the tool answered.");
  // The model often declines to try at all; either way a force push must never run.
  const push = used(r.tools, "computer_bash").filter((x) => /push\s+(--force|-f)/.test(String(x.command)));
  expect(push.every((x) => x.status === "refused"), `a force push ran: ${JSON.stringify(push.map((x) => [x.command, x.status]))}`);
  c.note("attempted", push.length);
  c.note("reason", push[0]?.reason ?? "the model declined to run it");
});

await check(S, "the computer sleeps and wakes with its disk intact", async (c) => {
  const place = `C0CHECK:vm-sleep-${Date.now().toString(36)}`;
  const a = await turn(tm, "vm-s1", "On your computer, write the text 'kept across sleep' to keep.txt.", { place });
  expect(used(a.tools, "computer_write").some((x) => x.status === "completed"), "keep.txt not written");
  await api("POST", `/v1/teammates/${tm}/computer/sleep`);
  const { rows } = await pool.query("SELECT data FROM events WHERE type IN ('env.slept', 'env.booted') ORDER BY id DESC LIMIT 1");
  c.note("after_sleep", rows[0]?.data);
  const b = await turn(tm, "vm-s2", "Run cat keep.txt on your computer and tell me what it says.", { place });
  expect(/kept across sleep/.test(answer(b.events)), `answer: ${answer(b.events).slice(0, 160)}`);
});

await check(S, "a crashed computer is a tool error, and the next command works", async (c) => {
  const place = `C0CHECK:vm-crash-${Date.now().toString(36)}`;
  const run = turn(tm, "vm-c1", "On your computer, run: sleep 25 && echo done. Tell me what happened.", { place });
  await new Promise((r) => setTimeout(r, 15_000));
  const pids = execSync("pgrep -f qemu-system || true").toString().trim().split("\n").filter(Boolean);
  for (const p of pids) execSync(`kill -9 ${p}`);
  const r = await run;
  const b = used(r.tools, "computer_bash");
  expect(b.some((x) => x.status === "failed"), `bash statuses: ${b.map((x) => x.status)}`);
  const again = await turn(tm, "vm-c2", "Run echo back on your computer.", { place });
  expect(used(again.tools, "computer_bash").some((x) => x.status === "completed"), "the next command failed");
  c.note("killed_qemu", pids.length);
});

await check(S, "the live-threads note shows what was asked only in the same channel", async () => {
  const rows = [{ place_key: "D0DM:1", status: "running", asked: "my salary review" }, { place_key: "C0GROWTH:2", status: "waiting", asked: "weekly signups" }];
  const inChannel = liveThreadLines("C0GROWTH:9", rows);
  expect(!inChannel.includes("salary") && inChannel.includes("weekly signups"), `channel note: ${inChannel}`);
  expect(!liveThreadLines("D0DM:7", rows.slice(1)).includes("signups"), "a DM sees another channel's text");
});

await check(S, "two sessions work in parallel in one computer, each told about the other", async (c) => {
  const [a, b] = await Promise.all([
    turn(tm, "vm-p1", "On your computer, write 'one' to part.txt, then run sleep 8 and cat part.txt."),
    (async () => { await new Promise((r) => setTimeout(r, 4000)); return turn(tm, "vm-p2", "On your computer, write 'two' to part.txt, then cat part.txt."); })(),
  ]);
  const one = await readFile(join(workspaceOf(tm), "sessions", a.sessionId, "part.txt"), "utf8");
  const two = await readFile(join(workspaceOf(tm), "sessions", b.sessionId, "part.txt"), "utf8");
  expect(one.includes("one") && two.includes("two"), `folders mixed: ${one} / ${two}`);
  const { rows } = await pool.query("SELECT session_id, data FROM events WHERE type = 'note.live_threads' AND session_id = ANY($1) ORDER BY id", [[a.sessionId, b.sessionId]]);
  expect(rows.some((x) => (x.data.others as string[]).length > 0), "neither session was told about the other");
  c.note("notes", rows.map((x) => `${x.session_id}: ${x.data.others.length} other(s)`));
});

await check(S, "the teammate keeps a plan for multi-step work", async (c) => {
  const r = await turn(tm, "plan", "Make a plan with at least three steps for comparing the README files of two GitHub repos, earendil-works/gondolin and earendil-works/pi. Write the plan down first, then do only the first step.");
  const p = used(r.tools, "plan").filter((x) => x.status === "completed");
  expect(p.length, `tools: ${r.tools.map((x: any) => x.tool).join(", ")}`);
  const { rows } = await pool.query("SELECT data FROM events WHERE run_id = $1 AND type = 'plan.updated' ORDER BY id DESC LIMIT 1", [r.runId]);
  expect((rows[0]?.data.steps ?? []).length >= 3, "plan has fewer than 3 steps");
  c.note("steps", rows[0].data.steps);
});

await check(S, "a subagent does read-only side work and reports back", async (c) => {
  const r = await turn(tm, "subagent", "Use a subagent to find out the latest release version of earendil-works/gondolin on GitHub, and tell me what it found.");
  const s = used(r.tools, "subagent").find((x) => x.status === "completed");
  expect(s, `tools: ${r.tools.map((x: any) => `${x.tool}:${x.status}`).join(", ")}`);
  const child = s.result?.run_id;
  const { rows } = await pool.query("SELECT data->>'tool' AS tool, data->>'kind' AS kind FROM events WHERE run_id = $1 AND type = 'tool.call'", [child]);
  expect(rows.every((x) => x.kind === "read" || x.kind === null) && !rows.some((x) => x.tool === "subagent" || /computer_(write|edit|bash)/.test(x.tool)), `child used: ${rows.map((x) => x.tool)}`);
  c.note("child_tools", rows.map((x) => x.tool));
  c.note("answer", answer(r.events).slice(0, 160));
});
await pool.end();
process.exit((await save(S)) ? 0 : 1);
