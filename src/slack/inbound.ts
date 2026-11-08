// Slack → sessions. A DM to a teammate's app is that teammate's DM session; a mention in a channel starts a thread
// session (the thread is the conversation); later messages in that thread go to the same session without a
// mention. Attention plumbing only (K2): edits never trigger, bots are context only, and a person's quick follow-ups
// are batched into one submission. "stop" in a thread stops the run in progress.
import { onSlackMessage } from "../ingress/slack.ts";
import { pool } from "../db.ts";
import { appendEvent } from "../store/events.ts";
import { personForSlack } from "../store/people.ts";
import { openSession, submit, type SessionKind } from "../store/sessions.ts";
import { startRun } from "../durable/runs.ts";
import { displayName, isBotUser } from "./api.ts";

export type SlackPlace = { app_id: string; team: string; channel: string; channel_type: string; thread_ts: string; trigger_ts: string; user: string; direct: boolean };
const BATCH_MS = Number(process.env.PEEBLO_SLACK_BATCH_MS ?? 1500);
const pending = new Map<string, { timer: NodeJS.Timeout; parts: { text: string; ts: string }[]; ctx: any }>();

// Mentions of the app's own bot user are stripped; other mentions stay (as <@U…>, which the model can read).
const clean = (text: string, botUser: string | null) => (botUser ? text.replaceAll(`<@${botUser}>`, "") : text).trim();

let stopHandler: ((sessionId: string) => Promise<boolean>) | null = null;
export const setStopHandler = (f: (sessionId: string) => Promise<boolean>) => { stopHandler = f; };

export function installSlackInbound(): void {
  onSlackMessage(async ({ appId, teammateId, teamId, event: ev }) => {
    if (!teammateId) return;                                   // Peeblo's own app: the manager (Phase 4)
    if (ev.subtype && ev.subtype !== "thread_broadcast" && ev.subtype !== "file_share") return; // edits, deletes, joins
    if (!ev.user || (await isBotUser(appId, ev.user))) return; // bots are context only
    const app = (await pool.query("SELECT bot_user_id FROM slack_apps WHERE app_id = $1", [appId])).rows[0];
    const dm = ev.channel_type === "im";
    const mentioned = ev.type === "app_mention" || (app?.bot_user_id && String(ev.text ?? "").includes(`<@${app.bot_user_id}>`));
    const threadTs = ev.thread_ts ?? ev.ts;
    const placeKey = dm ? `${ev.channel}:${threadTs}` : `${ev.channel}:${threadTs}`;
    const kind: SessionKind = dm ? "dm" : "thread";
    // In a channel, a message counts only with a mention, or in a thread this teammate is already in. Peeblo's
    // own app also reads along in channels set to listen: its channel session decides whether to do anything (K2).
    let kindNow: SessionKind = kind;
    let keyNow = placeKey;
    if (!dm && !mentioned) {
      const known = (await pool.query("SELECT id FROM sessions WHERE teammate_id = $1 AND kind = 'thread' AND place_key = $2", [teammateId, placeKey])).rows[0];
      if (!known) {
        const isManager = (await pool.query("SELECT slug FROM teammates WHERE id = $1", [teammateId])).rows[0]?.slug === "peeblo";
        const attention = (await pool.query("SELECT attention FROM channel_settings WHERE team_id = $1 AND channel = $2", [teamId, ev.channel])).rows[0]?.attention ?? "listen";
        if (!isManager || attention !== "listen" || ev.thread_ts) return;
        kindNow = "channel"; keyNow = ev.channel;
      }
    }
    const text = clean(String(ev.text ?? ""), app?.bot_user_id ?? null);
    if (!text) return;
    const place: SlackPlace = { app_id: appId, team: teamId, channel: ev.channel, channel_type: ev.channel_type ?? "channel", thread_ts: threadTs, trigger_ts: ev.ts, user: ev.user, direct: Boolean(dm || mentioned) };
    const session = await openSession(teammateId, kindNow, keyNow, { slack: place });
    if (/^(stop|cancel|stop please)[.!]?$/i.test(text)) {
      const stopped = stopHandler ? await stopHandler(session.id) : false;
      await appendEvent({ sessionId: session.id, type: "slack.stop", data: { user: ev.user, stopped } });
      return;
    }
    // Batch quick follow-ups from the same person in the same place into one submission.
    const key = `${session.id}:${ev.user}`;
    const p = pending.get(key);
    if (p) { clearTimeout(p.timer); p.parts.push({ text, ts: ev.ts }); }
    const entry = p ?? { parts: [{ text, ts: ev.ts }], ctx: { session, place, teamId, appId, user: ev.user }, timer: null as any };
    entry.timer = setTimeout(() => void flush(key).catch((e) => console.error("slack submit:", e)), BATCH_MS);
    pending.set(key, entry);
  });
}

async function flush(key: string): Promise<void> {
  const p = pending.get(key);
  if (!p) return;
  pending.delete(key);
  const { session, place, teamId, appId, user } = p.ctx;
  const person = await personForSlack(teamId, user, { displayName: (await displayName(appId, user)) ?? undefined });
  const last = p.parts.at(-1)!;
  // The latest message is the trigger the view reacts to and threads under.
  const placeNow = { ...place, trigger_ts: last.ts };
  await pool.query("UPDATE sessions SET place = jsonb_set(place, '{slack}', $2::jsonb), last_active_at = now() WHERE id = $1", [session.id, JSON.stringify(placeNow)]);
  // Per app: the same message can be for Peeblo (reading along) and for the teammate it mentions; each is its own job.
  const { run, created } = await submit({ sessionId: session.id, personId: person.id, requestId: `slack:${teamId}:${appId}:${place.channel}:${last.ts}`, text: p.parts.map((x) => x.text).join("\n"), source: "slack" });
  if (created) await startRun(run.id);
}
