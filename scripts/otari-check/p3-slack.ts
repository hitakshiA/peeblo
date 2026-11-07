// Phase 3 "done when", in the real Slack workspace: a person DMs a teammate and tags it in a channel; it streams
// its work with task cards and signs its reply with a receipt. Messages are sent as a real member (Maya, with her
// own user token) through Slack, so they arrive like any person's: Slack → the public URL → ingress.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, expect, save } from "./harness.ts";
const { pool } = await import("../../src/db.ts");
const { slack } = await import("../../src/slack/api.ts");

const S = "P3";
const SECRETS = process.env.PEEBLO_SECRETS_DIR ?? join(import.meta.dirname, "../../local/secrets");
const users = JSON.parse(readFileSync(join(SECRETS, "slack-users.json"), "utf8"));
const MAYA = "U0CFKNZLLSF";
const APP = "A0CFKJFCERZ"; // scout
const BOT = "U0CFRKXPRV0";
const asMaya = async (method: string, body: Record<string, unknown>) => {
  const r = await fetch(`https://slack.com/api/${method}`, { method: "POST", headers: { authorization: `Bearer ${users[MAYA].token}`, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
  const j: any = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.error}`);
  return j;
};
async function waitRun(ts: string, ms = 300_000): Promise<any> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const { rows } = await pool.query("SELECT r.id, r.status, r.session_id FROM runs r JOIN submissions s ON s.id = r.submission_id WHERE s.request_id LIKE $1", [`slack:%:${ts}`]);
    if (rows[0] && ["done", "failed"].includes(rows[0].status)) return rows[0];
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("no finished run for the message");
}
// What people see in the thread (read with the teammate's own token), once the view has caught up.
async function thread(channel: string, ts: string): Promise<any[]> {
  for (let i = 0; i < 10; i++) {
    const r = await slack(APP, "conversations.replies", { channel, ts, limit: 50 });
    const msgs = r.messages ?? [];
    if (msgs.some((m: any) => JSON.stringify(m.blocks ?? []).includes("feedback_buttons") || JSON.stringify(m.blocks ?? []).includes("calls ·"))) return msgs;
    await new Promise((x) => setTimeout(x, 2000));
  }
  return (await slack(APP, "conversations.replies", { channel, ts, limit: 50 })).messages ?? [];
}
const reactions = async (channel: string, ts: string) => ((await slack(APP, "reactions.get", { channel, timestamp: ts })).message?.reactions ?? []).map((r: any) => r.name);

await check(S, "a DM to a teammate: task cards while it works, then a signed reply", async (c) => {
  const im = (await asMaya("conversations.open", { users: BOT })).channel.id;
  const sent = await asMaya("chat.postMessage", { channel: im, text: "Hi Scout! Using code, what's the week-over-week change in percent for signups 412, 398, 455, 301 and 288? Then tell me the newest gondolin release on GitHub." });
  const run = await waitRun(sent.ts);
  const msgs = await thread(im, sent.ts);
  const reply = msgs.find((m: any) => m.ts !== sent.ts && m.bot_id);
  const receipt = msgs.map((m: any) => JSON.stringify(m.blocks ?? [])).find((b: string) => b.includes("calls ·") || b.includes("call ·"));
  const tasks = (await pool.query("SELECT count(*)::int n FROM events WHERE run_id = $1 AND type = 'tool.call'", [run.id])).rows[0].n;
  const rs = await reactions(im, sent.ts);
  c.note("run", run.id); c.note("tools", tasks); c.note("reactions", rs);
  expect(run.status === "done", `run ${run.status}`);
  expect(reply && (reply.text ?? "").length > 20, "no reply in the DM thread");
  expect(receipt, "no receipt on the reply");
  expect(tasks >= 2, `only ${tasks} tool calls shown as tasks`);
  expect(rs.includes("white_check_mark") && !rs.includes("eyes"), `reactions: ${rs.join(", ")}`);
  c.note("reply", String(reply.text).slice(0, 160));
});

await check(S, "a mention in a channel starts a thread; a follow-up there needs no mention", async (c) => {
  const ch = String(process.env.PEEBLO_CHECK_CHANNEL ?? "");
  const channel = ch || (await asMaya("conversations.list", { types: "public_channel", limit: 200 })).channels.find((x: any) => x.name === "growth")?.id;
  expect(channel, "no #growth channel");
  await slack(APP, "conversations.join", { channel }).catch(() => null);
  const sent = await asMaya("chat.postMessage", { channel, text: `<@${BOT}> what are the three most recently updated issues in the GRO team in Linear? Just the titles.` });
  const run = await waitRun(sent.ts);
  const msgs = await thread(channel, sent.ts);
  expect(run.status === "done" && msgs.some((m: any) => m.bot_id && m.ts !== sent.ts), "no threaded reply");
  const follow = await asMaya("chat.postMessage", { channel, thread_ts: sent.ts, text: "Thanks! Which of those is the oldest?" });
  const run2 = await waitRun(follow.ts);
  expect(run2.session_id === run.session_id, "the follow-up went to a new session");
  expect(run2.status === "done", `follow-up run ${run2.status}`);
  c.note("session", run.session_id);
});
await pool.end();
process.exit((await save(S)) ? 0 : 1);
