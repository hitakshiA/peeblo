// Phase 7 "done when", in the real Slack workspace: one teammate asks another mid-job in a thread with several people,
// and each person sees the hand-off and the right receipt (the callee's run is billed to the person who started the
// chain). Plus the chain guard: a call past the depth limit is refused in code.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, expect, save } from "./harness.ts";
const { pool } = await import("../../src/db.ts");
const { slack } = await import("../../src/slack/api.ts");

const S = "P7";
const users = JSON.parse(readFileSync(join(process.env.PEEBLO_SECRETS_DIR ?? "local/secrets", "slack-users.json"), "utf8"));
const as = (u: string) => async (m: string, b: any) => {
  const j: any = await (await fetch(`https://slack.com/api/${m}`, { method: "POST", headers: { authorization: `Bearer ${users[u].token}`, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(b) })).json();
  if (!j.ok) throw new Error(`${m}: ${j.error}`);
  return j;
};
const maya = as("U0CFKNZLLSF"), jun = as("U0CFQ1B4KK8");
const SCOUT_APP = "A0CFKJFCERZ", SCOUT = "U0CFRKXPRV0";
const waitRun = async (where: string, ms = 400_000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const r = (await pool.query(where)).rows[0];
    if (r && ["done", "failed"].includes(r.status)) return r;
    await new Promise((x) => setTimeout(x, 3000));
  }
  return null;
};

await check(S, "a teammate asks another mid-job in a shared thread; each signs its own receipt, billed to the asker", async (c) => {
  const channel = (await maya("conversations.list", { types: "public_channel", limit: 200 })).channels.find((x: any) => x.name === "growth").id;
  await jun("conversations.join", { channel }).catch(() => null);
  const sent = await maya("chat.postMessage", { channel, text: `<@${SCOUT}> for standup: ask Grove (our Linear GRO watcher) for the titles of the 3 newest GRO issues, wait for its answer, then post them here with one line on which looks most urgent.` });
  const scout = await waitRun(`SELECT r.id, r.status FROM runs r JOIN submissions s ON s.id = r.submission_id WHERE s.request_id LIKE 'slack:%:${sent.ts}'`);
  expect(scout?.status === "done", `scout's run: ${scout?.status}`);
  const call = (await pool.query("SELECT data FROM events WHERE type = 'chain.call' AND data->>'parent_run' = $1", [scout.id])).rows[0]?.data;
  expect(call?.callee === "grove", `chain call: ${JSON.stringify(call)}`);
  const grove = await waitRun(`SELECT id, status FROM runs WHERE id = '${call.child_run}'`);
  expect(grove?.status === "done", `grove's run: ${grove?.status}`);
  const payers = (await pool.query("SELECT DISTINCT e.run_id, e.data->>'end_user' AS u FROM events e WHERE e.type = 'model.call' AND e.run_id = ANY($1) AND (e.data->>'status')::int = 200", [[scout.id, grove.id]])).rows;
  c.note("payers", payers.map((p) => `${p.run_id === scout.id ? "scout" : "grove"}:${p.u}`));
  expect(payers.length >= 2 && payers.every((p) => p.u === "slack-T0CFKBN3YPM-U0CFKNZLLSF"), "a run in the chain wasn't billed to Maya");
  // Several people: Jun follows up in the same thread.
  const follow = await jun("chat.postMessage", { channel, thread_ts: sent.ts, text: `<@${SCOUT}> thanks! which of those is the oldest?` });
  const second = await waitRun(`SELECT r.id, r.status FROM runs r JOIN submissions s ON s.id = r.submission_id WHERE s.request_id LIKE 'slack:%:${follow.ts}'`);
  expect(second?.status === "done", `follow-up run: ${second?.status}`);
  await new Promise((x) => setTimeout(x, 4000));
  const msgs = (await slack(SCOUT_APP, "conversations.replies", { channel, ts: sent.ts, limit: 100 })).messages ?? [];
  const byGrove = msgs.filter((m: any) => (m.username ?? "").toLowerCase() === "grove");
  const receipts = msgs.filter((m: any) => /calls? ·/.test(JSON.stringify(m.blocks ?? [])));
  c.note("thread", msgs.map((m: any) => `${m.username ?? m.user}: ${String(m.text).slice(0, 50).replace(/\n/g, " ")}`));
  expect(byGrove.length >= 1, "Grove's hand-off isn't visible in the thread");
  expect(receipts.length >= 2, `receipts in the thread: ${receipts.length}`);
});

await check(S, "a call past the depth limit is refused in code", async (c) => {
  const { callTeammate, MAX_DEPTH } = await import("../../src/chains.ts");
  const { getTeammate } = await import("../../src/store/teammates.ts");
  const { newId } = await import("../../src/ids.ts");
  const a = (await getTeammate("scout"))!, b = (await getTeammate("grove"))!;
  // A chain already MAX_DEPTH deep (recorded calls), then one more call from its deepest run.
  const root = newId("ru"); let parent = root;
  for (let d = 1; d <= MAX_DEPTH; d++) { const child = newId("ru"); await pool.query("INSERT INTO events (type, data) VALUES ('chain.call', $1)", [{ root, parent_run: parent, child_run: child, depth: d, caller: "check", callee: "check", kind: "ask" }]); parent = child; }
  const sess = (await pool.query("SELECT id FROM sessions WHERE teammate_id = $1 LIMIT 1", [a.id])).rows[0].id;
  const r = await callTeammate({ runId: parent, sessionId: sess, caller: a, personId: null, toolCallId: "tc" }, b, "check", "ask");
  c.note("result", r);
  expect("refused" in r && /deep/.test(r.refused), `result: ${JSON.stringify(r)}`);
});
await pool.end();
process.exit((await save(S)) ? 0 : 1);
