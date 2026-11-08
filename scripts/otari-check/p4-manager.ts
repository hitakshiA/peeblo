// Phase 4 "done when", in the real Slack workspace. A teammate works only through its own Slack app; Peeblo hires it
// and hands over the install button, and never works or speaks for it.
//   node scripts/otari-check/p4-manager.ts start   → Maya asks Peeblo for a teammate in a DM; the ID card is approved;
//     the card and Peeblo's "is ready" message carry the install button; nothing posts as the teammate; asking Peeblo
//     to hand it a job gets "isn't installed yet" and the button again; a direct run of it is refused by the rail.
//     Prints the install URL.
//   (one click: open the URL as a workspace member and allow)
//   node scripts/otari-check/p4-manager.ts finish  → it says it's installed from its own app, and Maya's first
//     question to it gets a signed reply from its own app.
// Messages go through Slack as Maya (her own user token); her approval is answered through the API with her person
// id (the approval names her as the only approver).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, expect, save } from "./harness.ts";
import { api, submit } from "./api.ts";
const { pool } = await import("../../src/db.ts");
const { slack } = await import("../../src/slack/api.ts");
const { getApp } = await import("../../src/ingress/apps.ts");

const S = "P4";
const STATE = "local/otari-check/p4-run.json";
const SECRETS = process.env.PEEBLO_SECRETS_DIR ?? join(import.meta.dirname, "../../local/secrets");
const users = JSON.parse(readFileSync(join(SECRETS, "slack-users.json"), "utf8"));
const MAYA = "U0CFKNZLLSF";
const PEEBLO_APP = process.env.PEEBLO_SLACK_APP_ID!;
const asMaya = async (method: string, body: Record<string, unknown>) => {
  // Slack's read methods want a form body; writes take JSON.
  const read = /^conversations\.(history|replies|info)$/.test(method);
  const r = await fetch(`https://slack.com/api/${method}`, { method: "POST", headers: { authorization: `Bearer ${users[MAYA].token}`, "content-type": read ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8" }, body: read ? new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])) : JSON.stringify(body) });
  const j: any = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.error}`);
  return j;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const peebloBot = (await pool.query("SELECT bot_user_id FROM slack_apps WHERE app_id = $1", [PEEBLO_APP])).rows[0].bot_user_id;
const maya = (await pool.query("SELECT id FROM people WHERE slack_user = $1", [MAYA])).rows[0].id;
const thread = async (channel: string, ts: string) => (await slack(PEEBLO_APP, "conversations.replies", { channel, ts, limit: 100 })).messages ?? [];
const hasButton = (m: any, slug: string) => JSON.stringify(m.blocks ?? []).includes(`install:${slug}`);

if (process.argv[2] === "start") {
  const im = (await asMaya("conversations.open", { users: peebloBot })).channel.id;
  const t0 = new Date();
  let st: any = { im };
  await check(S, "Peeblo hires a teammate on its ID card and hands over the install button; nothing posts as it", async (c) => {
    // A job no existing teammate covers (a launch codename per run), so Peeblo hires rather than reusing one.
    const code = ["Orion", "Juniper", "Halcyon", "Tamarind", "Saffron", "Kestrel"][Math.floor(Math.random() * 6)] + "-" + Date.now().toString(36).slice(-4);
    const sent = await asMaya("chat.postMessage", { channel: im, text: `Hi Peeblo! For the ${code} launch I need a new teammate that drafts release notes from our Linear GRO issues when I ask. Read-only on Linear, $5 a month, pick the name.` });
    st.ts = sent.ts;
    // Peeblo may ask up to 2 questions first; answer once, then approve its ID card.
    let hired: any = null, asked = 0;
    for (let i = 0; i < 120 && !hired; i++) {
      await wait(5000);
      const ap = (await pool.query("SELECT id, action FROM approvals WHERE created_at > $1 AND status = 'pending' AND action->>'kind' = 'hire'", [t0])).rows[0];
      if (ap) { await api("POST", `/v1/approvals/${ap.id}`, { decision: "approved", scope: "once", person_id: maya }); c.note("card", ap.action.summary); }
      hired = (await pool.query("SELECT t.id, t.slug, v.config->>'name' AS name, h.app_id, h.install_url FROM hires h JOIN teammates t ON t.id = h.teammate_id JOIN teammate_versions v ON v.teammate_id = t.id AND v.version = t.version WHERE h.created_at > $1", [t0])).rows[0];
      const q = (await pool.query("SELECT count(*)::int n FROM events e JOIN sessions s ON s.id = e.session_id JOIN teammates t ON t.id = s.teammate_id WHERE t.slug = 'peeblo' AND e.type = 'tool.call' AND e.data->>'tool' = 'ask_human' AND e.at > $1", [t0])).rows[0].n;
      if (q > asked && !ap && !hired) { asked = q; await asMaya("chat.postMessage", { channel: im, thread_ts: sent.ts, text: "Just read-only summaries when I ask, nothing else. Go ahead." }); }
    }
    expect(hired?.install_url, `hired: ${JSON.stringify(hired)}`);
    st = { ...st, slug: hired.slug, name: hired.name, id: hired.id, app_id: hired.app_id, install_url: hired.install_url };
    c.note("hired", hired.slug);
    await wait(8000);
    const msgs = await thread(im, sent.ts);
    c.note("thread", msgs.map((m: any) => `${m.username ?? m.user ?? m.bot_id}: ${String(m.text).slice(0, 70)}`));
    const card = msgs.find((m: any) => (m.blocks ?? []).some((b: any) => b.type === "image"));
    expect(card && hasButton(card, hired.slug), "the ID card has no install button");
    expect(msgs.some((m: any) => /is ready\. Install it to start working with it/.test(m.text) && hasButton(m, hired.slug)), "no 'is ready, install it' message with the button");
    expect(!msgs.some((m: any) => m.username && m.username.toLowerCase() === hired.name.toLowerCase()), "something posted as the teammate through Peeblo");
    const runs = (await pool.query("SELECT r.status FROM runs r JOIN sessions s ON s.id = r.session_id WHERE s.teammate_id = $1 AND r.status = 'done'", [hired.id])).rows;
    expect(!runs.length, "the uninstalled teammate did work");
  });

  await check(S, "asking for a job from the uninstalled teammate: Peeblo says it isn't installed and offers the button again", async (c) => {
    const t1 = new Date();
    const ask = await asMaya("chat.postMessage", { channel: im, thread_ts: st.ts, text: `Peeblo, have ${st.name} list the titles of the 3 newest GRO issues now.` });
    let msgs: any[] = [];
    for (let i = 0; i < 36; i++) {
      await wait(5000);
      msgs = (await thread(im, st.ts)).filter((m: any) => Number(m.ts) > Number(ask.ts));
      if (msgs.some((m: any) => /isn't installed yet/.test(m.text) && hasButton(m, st.slug))) break;
    }
    c.note("replies", msgs.map((m: any) => `${m.username ?? m.user ?? m.bot_id}: ${String(m.text).slice(0, 90)}`));
    expect(msgs.some((m: any) => /isn't installed yet/.test(m.text) && hasButton(m, st.slug)), "no 'isn't installed yet' reply with the install button");
    expect(!msgs.some((m: any) => m.username && m.username.toLowerCase() === st.name.toLowerCase()), "something posted as the teammate");
    const refused = (await pool.query("SELECT count(*)::int n FROM events WHERE type = 'chain.refused' AND data->>'callee' = $1 AND at > $2", [st.slug, t1])).rows[0].n;
    const did = (await pool.query("SELECT count(*)::int n FROM runs r JOIN sessions s ON s.id = r.session_id WHERE s.teammate_id = $1 AND r.status = 'done'", [st.id])).rows[0].n;
    c.note("refused_calls", refused);
    expect(!did, "the uninstalled teammate did work");
    // Peeblo didn't do the job itself: no Linear call in its runs since the ask.
    const linear = (await pool.query("SELECT count(*)::int n FROM events e JOIN sessions s ON s.id = e.session_id JOIN teammates t ON t.id = s.teammate_id WHERE t.slug = 'peeblo' AND e.type = 'tool.call' AND e.data->>'tool' LIKE 'linear__%' AND e.at > $1", [t1])).rows[0].n;
    expect(!linear, `Peeblo did the job itself (${linear} Linear calls)`);
  });

  await check(S, "the rail refuses any run of an uninstalled teammate", async (c) => {
    const { runId } = await submit(st.slug, `C0CHECK:rail-${Date.now().toString(36)}`, "List the 3 newest GRO issues.", `rail-${Date.now().toString(36)}`);
    const r = { runId };
    let run: any = null;
    for (let i = 0; i < 30 && !(run && ["failed", "done"].includes(run.status)); i++) { await wait(1000); run = (await pool.query("SELECT status, error FROM runs WHERE id = $1", [runId])).rows[0]; }
    c.note("run", run);
    expect(run?.status === "failed" && run.error === "not_installed", `run: ${JSON.stringify(run ?? r)}`);
    const ev = (await pool.query("SELECT type FROM events WHERE run_id = $1 ORDER BY id", [runId])).rows.map((x) => x.type);
    expect(ev.includes("run.refused") && !ev.includes("run.started"), `events: ${ev.join(", ")}`);
  });
  writeFileSync(STATE, JSON.stringify(st));
  console.log(`INSTALL ${st.install_url}`);
  await save(S);
  await pool.end();
  process.exit(0);
}

// finish: after the one click.
const st = JSON.parse(readFileSync(STATE, "utf8"));
await check(S, "one click: it says it's installed from its own app, and its first reply comes from its own app", async (c) => {
  let app: any = null;
  for (let i = 0; i < 60 && !app?.secrets.bot_token; i++) { app = await getApp(st.app_id); if (!app?.secrets.bot_token) await wait(2000); }
  expect(app?.secrets.bot_token, "the app was never installed (no OAuth callback)");
  const own = app.bot_user_id;
  // Hired in a DM with Peeblo, so it opens its own DM with Maya and says it's installed.
  const dm = (await asMaya("conversations.open", { users: own })).channel.id;
  let hello: any = null;
  for (let i = 0; i < 30 && !hello; i++) {
    hello = ((await asMaya("conversations.history", { channel: dm, limit: 10 })).messages ?? []).find((m: any) => /I'm installed/.test(m.text));
    if (!hello) await wait(2000);
  }
  expect(hello && hello.user === own, `install message: ${JSON.stringify(hello?.text ?? null)}`);
  const card = (await thread(st.im, st.ts)).find((m: any) => (m.blocks ?? []).some((b: any) => b.type === "image"));
  c.note("card_after", JSON.stringify(card?.blocks ?? []).includes("is in Slack and posts as itself"));
  // Maya's first question to it, in its own DM; the reply is from its own app, with a receipt.
  const q = await asMaya("chat.postMessage", { channel: dm, text: "List the titles of the 3 newest GRO issues." });
  let reply: any = null;
  for (let i = 0; i < 60 && !reply; i++) {
    await wait(5000);
    for (const ap of (await pool.query("SELECT a.id FROM approvals a JOIN runs r ON r.id = a.run_id JOIN sessions s ON s.id = r.session_id WHERE s.teammate_id = $1 AND a.status = 'pending'", [st.id])).rows)
      await api("POST", `/v1/approvals/${ap.id}`, { decision: "approved", scope: "job", person_id: maya }).catch(() => null);
    // In the thread under the question, or top level in the DM.
    const inThread = (await asMaya("conversations.replies", { channel: dm, ts: q.ts, limit: 50 })).messages ?? [];
    const top = (await asMaya("conversations.history", { channel: dm, oldest: q.ts, limit: 20 })).messages ?? [];
    const msgs = [...inThread, ...top].filter((m: any) => Number(m.ts) > Number(q.ts));
    reply = msgs.find((m: any) => m.user === own && /GRO-\d+/.test(JSON.stringify(m)));
    c.note("replies", msgs.map((m: any) => `${m.user}: ${String(m.text).slice(0, 80)}`));
  }
  expect(reply, "no reply from its own app");
  expect(!reply.username, "the reply was posted under a borrowed name");
  c.note("reply", String(reply.text).slice(0, 160));
});
await save(S);
await pool.end();
process.exit(0);
