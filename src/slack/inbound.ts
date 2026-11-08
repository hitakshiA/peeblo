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
// Quick follow-ups from the same person are batched; short, so a single message isn't kept waiting.
const BATCH_MS = Number(process.env.PEEBLO_SLACK_BATCH_MS ?? 500);
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
    // In a channel, a message counts only with a mention, or in a thread this teammate is already in. Peeblo reads
    // along only in a channel someone asked it to keep an eye on (channel_watch); the default is mentions only (R1′).
    let kindNow: SessionKind = kind;
    let keyNow = placeKey;
    let inThread = false;
    if (!dm && !mentioned) {
      const known = (await pool.query("SELECT id FROM sessions WHERE teammate_id = $1 AND kind = 'thread' AND place_key = $2", [teammateId, placeKey])).rows[0];
      inThread = Boolean(known);
      if (!known) {
        const isManager = (await pool.query("SELECT slug FROM teammates WHERE id = $1", [teammateId])).rows[0]?.slug === "peeblo";
        const attention = (await pool.query("SELECT attention FROM channel_settings WHERE team_id = $1 AND channel = $2", [teamId, ev.channel])).rows[0]?.attention ?? "mentions";
        if (!isManager || attention !== "listen" || ev.thread_ts) return;
        // One listener: a message tagging another teammate is that teammate's to answer, so Peeblo doesn't read it.
        const tagged = [...String(ev.text ?? "").matchAll(/<@([A-Z0-9]+)>/g)].map((m) => m[1]);
        if (tagged.length && (await pool.query("SELECT 1 FROM slack_apps a JOIN teammates t ON t.id = a.teammate_id WHERE a.bot_user_id = ANY($1) AND t.slug <> 'peeblo' LIMIT 1", [tagged])).rows.length) return;
        kindNow = "channel"; keyNow = ev.channel;
      }
    }
    let text = clean(String(ev.text ?? ""), app?.bot_user_id ?? null);
    if (!text && !ev.files?.length) return;
    const place: SlackPlace = { app_id: appId, team: teamId, channel: ev.channel, channel_type: ev.channel_type ?? "channel", thread_ts: threadTs, trigger_ts: ev.ts, user: ev.user, direct: Boolean(dm || mentioned || inThread) }; // a reply in its own thread is addressed to it
    const session = await openSession(teammateId, kindNow, keyNow, { slack: place });
    // Start the teammate's Pi now, in parallel with the batching wait below.
    void import("../pi/supervisor.ts").then((m) => m.prewarm(session.id, teammateId)).catch(() => null);
    // Files dropped in the message go onto the teammate's computer (its session folder), and the message says where.
    if (ev.files?.length) text = `${text}\n${await saveFiles(appId, teammateId, session.id, ev.files).catch((e) => `[files: couldn't save them (${(e as Error).message.slice(0, 120)})]`)}`.trim();
    // The kill switch works where the teammate was asked directly or is in the thread; a "stop" said in a channel
    // Peeblo only reads along in is for the people there.
    if (kindNow !== "channel" && /^(stop|cancel|stop please)[.!]?$/i.test(text)) {
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

// Downloads a message's files (Slack's private URLs, with the app's bot token) into the teammate's workspace for this
// session; a teammate without a computer is told it can't open them. At most 5 files of 25 MB each.
async function saveFiles(appId: string, teammateId: string, sessionId: string, files: any[]): Promise<string> {
  const { getApp } = await import("../ingress/apps.ts");
  const { getTeammate } = await import("../store/teammates.ts");
  const { workspaceOf } = await import("../environment/controller.ts");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join, basename } = await import("node:path");
  const tm = await getTeammate(teammateId);
  const names = files.map((f) => String(f.name ?? f.title ?? "file"));
  if (!tm?.config.tools.includes("computer")) return `[files shared: ${names.join(", ")}; you have no computer to open them, so say so if they matter]`;
  const token = (await getApp(appId))?.secrets.bot_token;
  if (!token) return `[files shared: ${names.join(", ")}; they couldn't be downloaded]`;
  const dir = join(workspaceOf(tm.slug), "sessions", sessionId, "files");
  await mkdir(dir, { recursive: true });
  const saved: string[] = [];
  for (const f of files.slice(0, 5)) {
    const url = f.url_private_download ?? f.url_private;
    if (!url || Number(f.size ?? 0) > 25 * 1024 * 1024) { saved.push(`${f.name} (too large or no link)`); continue; }
    const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) { saved.push(`${f.name} (download failed: ${r.status})`); continue; }
    const name = basename(String(f.name ?? `file-${f.id}`)).replace(/[^\w.\- ]/g, "_").slice(0, 120) || `file-${f.id}`;
    await writeFile(join(dir, name), Buffer.from(await r.arrayBuffer()));
    saved.push(`/workspace/sessions/${sessionId}/files/${name} (${f.filetype ?? "file"}, ${Math.max(1, Math.round(Number(f.size ?? 0) / 1024))} KB)`);
  }
  await appendEvent({ sessionId, type: "slack.files_saved", data: { files: saved } });
  return `[files from the person, saved on your computer: ${saved.join("; ")}]`;
}
