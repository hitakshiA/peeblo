// Phase 4 "done when", in the real Slack workspace: someone asks Peeblo for a teammate, it hires one (ID card
// approval → config, Otari key, a real Slack app with its face, an intro), and the new teammate gets to work in the
// same thread. Messages go through Slack as Maya (her own user token); her approval is answered through the API with
// her person id (the approval names her as the only approver).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, expect, save } from "./harness.ts";
import { api } from "./api.ts";
const { pool } = await import("../../src/db.ts");
const { slack } = await import("../../src/slack/api.ts");

const S = "P4";
const SECRETS = process.env.PEEBLO_SECRETS_DIR ?? join(import.meta.dirname, "../../local/secrets");
const users = JSON.parse(readFileSync(join(SECRETS, "slack-users.json"), "utf8"));
const MAYA = "U0CFKNZLLSF";
const PEEBLO_APP = process.env.PEEBLO_SLACK_APP_ID!;
const asMaya = async (method: string, body: Record<string, unknown>) => {
  const r = await fetch(`https://slack.com/api/${method}`, { method: "POST", headers: { authorization: `Bearer ${users[MAYA].token}`, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
  const j: any = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.error}`);
  return j;
};
const peebloBot = (await pool.query("SELECT bot_user_id FROM slack_apps WHERE app_id = $1", [PEEBLO_APP])).rows[0].bot_user_id;
const maya = (await pool.query("SELECT id FROM people WHERE slack_user = $1", [MAYA])).rows[0].id;

await check(S, "someone asks Peeblo for a teammate, hires it on its ID card, and it gets to work", async (c) => {
  const im = (await asMaya("conversations.open", { users: peebloBot })).channel.id;
  const t0 = new Date();
  // A job no existing teammate covers (a launch codename per run), so Peeblo hires rather than reusing one.
  const code = ["Orion", "Juniper", "Halcyon", "Tamarind", "Saffron", "Kestrel"][Math.floor(Math.random() * 6)] + "-" + Date.now().toString(36).slice(-4);
  const sent = await asMaya("chat.postMessage", { channel: im, text: `Hi Peeblo! For the ${code} launch I need a new teammate that drafts release notes from our Linear GRO issues when I ask. Read-only on Linear, $5 a month, pick the name. Once it's hired, have it list the titles of the 3 newest GRO issues as a first draft.` });
  // Peeblo may ask up to 2 questions first; answer once, then approve its ID card.
  let hired: any = null, asked = 0;
  for (let i = 0; i < 120 && !hired; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const ap = (await pool.query("SELECT id, action FROM approvals WHERE created_at > $1 AND status = 'pending' AND action->>'kind' = 'hire'", [t0])).rows[0];
    if (ap) { await api("POST", `/v1/approvals/${ap.id}`, { decision: "approved", scope: "once", person_id: maya }); c.note("card", ap.action.summary); }
    hired = (await pool.query("SELECT t.id, t.slug, h.app_id FROM hires h JOIN teammates t ON t.id = h.teammate_id WHERE h.created_at > $1", [t0])).rows[0];
    const q = (await pool.query("SELECT count(*)::int n FROM events e JOIN sessions s ON s.id = e.session_id JOIN teammates t ON t.id = s.teammate_id WHERE t.slug = 'peeblo' AND e.type = 'tool.call' AND e.data->>'tool' = 'ask_human' AND e.at > $1", [t0])).rows[0].n;
    if (q > asked && !ap && !hired) { asked = q; await asMaya("chat.postMessage", { channel: im, thread_ts: sent.ts, text: "Just read-only summaries when I ask, nothing else. Go ahead." }); }
  }
  expect(hired, "no teammate was hired");
  c.note("hired", hired.slug); c.note("questions", asked);
  expect(hired.app_id, "no Slack app was made for it");
  const { getApp } = await import("../../src/ingress/apps.ts");
  expect((await getApp(hired.app_id))?.secrets.client_id, "the app has no credentials stored");
  // The new teammate's first job, in the same thread.
  let job: any = null;
  for (let i = 0; i < 60 && !job; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    // Maya answers the new teammate's approval cards (as she would by clicking), if its mode asks.
    for (const ap of (await pool.query("SELECT a.id FROM approvals a JOIN runs r ON r.id = a.run_id JOIN sessions s ON s.id = r.session_id WHERE s.teammate_id = $1 AND a.status = 'pending'", [hired.id])).rows)
      await api("POST", `/v1/approvals/${ap.id}`, { decision: "approved", scope: "job", person_id: maya }).catch(() => null);
    job = (await pool.query("SELECT r.id, r.status FROM runs r JOIN sessions s ON s.id = r.session_id WHERE s.teammate_id = $1 AND r.status IN ('done', 'failed')", [hired.id])).rows[0];
  }
  expect(job?.status === "done", `the new teammate's job: ${job?.status ?? "never ran"}`);
  const msgs = (await slack(PEEBLO_APP, "conversations.replies", { channel: im, ts: sent.ts, limit: 50 })).messages ?? [];
  const asIt = msgs.filter((m: any) => m.username && m.username.toLowerCase() !== "peeblo");
  c.note("thread", msgs.map((m: any) => `${m.username ?? m.user}: ${String(m.text).slice(0, 60)}`));
  expect(asIt.length >= 2, `posts as the new teammate: ${asIt.length}`); // its intro and its answer
  expect(msgs.some((m: any) => JSON.stringify(m.blocks ?? []).includes("calls ·") || JSON.stringify(m.blocks ?? []).includes("call ·")), "no receipt in the thread");
  const card = msgs.find((m: any) => JSON.stringify(m.blocks ?? []).includes("hire a new teammate"));
  expect(card && (card.blocks ?? []).some((b: any) => b.type === "image"), "the hire card has no ID card image");
});
await pool.end();
process.exit((await save(S)) ? 0 : 1);
