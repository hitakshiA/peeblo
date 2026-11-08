// Teammates calling teammates (K18). A call is a submission to the callee in the same Slack thread, through its own app
// (so every person there sees the hand-off and each teammate's own receipt), billed to the person who started the chain. Code owns the
// guards: at most 3 deep, at most 6 calls per chain, and a spend cap per chain; "stop" in the thread stops the chain.
// A busy callee gets a new session for the call, so a call never waits behind another conversation.
import { pool } from "./db.ts";
import { startRun } from "./durable/runs.ts";
import { appendEvent } from "./store/events.ts";
import { getSession, openSession, submit } from "./store/sessions.ts";
import type { Teammate } from "./store/teammates.ts";
import type { SlackPlace } from "./slack/inbound.ts";
import { getApp } from "./ingress/apps.ts";
import { getPerson } from "./store/people.ts";

export const MAX_DEPTH = Number(process.env.PEEBLO_CHAIN_DEPTH ?? 3);
export const MAX_CALLS = Number(process.env.PEEBLO_CHAIN_CALLS ?? 6);
export const CHAIN_CAP_USD = Number(process.env.PEEBLO_CHAIN_CAP_USD ?? 1);

// The chain a run belongs to: its root run and its depth (0 for a person's own ask).
export async function chainOf(runId: string | null): Promise<{ root: string | null; depth: number }> {
  if (!runId) return { root: null, depth: 0 };
  const { rows } = await pool.query("SELECT data FROM events WHERE type = 'chain.call' AND data->>'child_run' = $1 LIMIT 1", [runId]);
  return rows[0] ? { root: rows[0].data.root, depth: Number(rows[0].data.depth) } : { root: runId, depth: 0 };
}

export async function chainRuns(root: string): Promise<string[]> {
  const { rows } = await pool.query("SELECT data->>'child_run' AS r FROM events WHERE type = 'chain.call' AND data->>'root' = $1", [root]);
  return [root, ...rows.map((x) => x.r)];
}

async function chainSpend(root: string): Promise<number> {
  const runs = await chainRuns(root);
  const { rows } = await pool.query("SELECT coalesce(sum((data->>'cost_usd')::numeric), 0) AS c FROM events WHERE type = 'model.call' AND run_id = ANY($1)", [runs]);
  return Number(rows[0].c);
}

async function ownApp(teammateId: string, team: string): Promise<string | null> {
  const ids = (await pool.query("SELECT app_id FROM slack_apps WHERE teammate_id = $1", [teammateId])).rows.map((r) => r.app_id);
  for (const id of ids) { const a = await getApp(id); if (a?.secrets.bot_token && a.team_id === team) return id; }
  return null;
}

// Calls a teammate from a run. Returns the callee's run, or a refusal sentence when a guard says no.
export async function callTeammate(from: { runId: string | null; sessionId: string; caller: Teammate; personId: string | null; toolCallId: string }, callee: Teammate, text: string, kind: "ask" | "delegate"): Promise<{ runId: string; sessionId: string; inDm?: boolean } | { refused: string }> {
  if (callee.id === from.caller.id) return { refused: "You can't call yourself; do it here." };
  const { root, depth } = await chainOf(from.runId);
  if (depth + 1 > MAX_DEPTH) return { refused: `This chain is already ${depth} hand-offs deep (the limit is ${MAX_DEPTH}). Finish with what you have and tell the person.` };
  if (root) {
    const calls = (await chainRuns(root)).length - 1;
    if (calls >= MAX_CALLS) return { refused: `This chain has already made ${calls} calls (the limit is ${MAX_CALLS}). Finish with what you have.` };
    const spent = await chainSpend(root);
    if (spent >= CHAIN_CAP_USD) return { refused: `This chain has spent $${spent.toFixed(4)} (the cap is $${CHAIN_CAP_USD}). Finish with what you have.` };
  }
  const here = ((await getSession(from.sessionId))?.place as any)?.slack as SlackPlace | undefined;
  // A teammate works only through its own Slack app. Not installed: it doesn't run, and nobody works for it; the
  // person gets its install button again.
  const { installState, offerAgain } = await import("./slack/install.ts");
  if ((await installState(callee.id)).waiting) {
    const who = from.personId ? await getPerson(from.personId) : null;
    const offered = here ? await offerAgain(here, callee, who?.slack_user ?? null) : false;
    await appendEvent({ sessionId: from.sessionId, runId: from.runId, type: "chain.refused", data: { callee: callee.slug, reason: "not_installed" } });
    return { refused: `${callee.config.name} isn't installed yet, so it can't work.${offered ? " Its install button is now in this thread." : ""} Tell the person to install it to start working with it. Don't do the job yourself and don't speak for it.` };
  }
  // In Slack, the callee speaks through its own app: in this thread when it can post here, else in its own DM with
  // the person (a DM with another app, or a private channel it isn't in).
  let place: SlackPlace | null = null;
  if (here) {
    const own = await ownApp(callee.id, here.team);
    if (!own) return { refused: `${callee.config.name} isn't in this Slack workspace.` };
    const { slack } = await import("./slack/api.ts");
    if (!["im", "mpim"].includes(here.channel_type)) {
      const joined: any = await slack(own, "conversations.join", { channel: here.channel }).catch(() => null);
      const member: any = joined?.ok ? joined : await slack(own, "conversations.info", { channel: here.channel }).catch(() => null);
      if (member?.channel?.is_member) place = { ...here, app_id: own, direct: true };
    }
    if (!place) {
      const who = from.personId ? await getPerson(from.personId) : null;
      const dm: any = who?.slack_user ? await slack(own, "conversations.open", { users: who.slack_user }).catch(() => null) : null;
      if (!dm?.channel?.id) return { refused: `${callee.config.name} can't reach the person from its own app here.` };
      const top: any = await slack(own, "chat.postMessage", { channel: dm.channel.id, text: `${from.caller.config.name} handed me this: ${text.split("\n").find((l) => l.startsWith("Objective:") || l.length > 20)?.slice(0, 280) ?? "a job"}` });
      place = { app_id: own, team: here.team, channel: dm.channel.id, channel_type: "im", thread_ts: top.ts, trigger_ts: top.ts, user: who!.slack_user!, direct: true };
    }
  }
  const placeKey = place ? `${place.channel}:${place.thread_ts}` : `api:${from.sessionId}`;
  const where = place ? { slack: place, called_by: from.caller.slug } : { called_by: from.caller.slug };
  // A busy callee (a run already going in its session for this thread) gets a separate session for the call.
  let s = await openSession(callee.id, place ? (place.channel_type === "im" ? "dm" : "thread") : "api", placeKey, where);
  const busy = (await pool.query("SELECT 1 FROM runs WHERE session_id = $1 AND status IN ('queued', 'running', 'waiting') LIMIT 1", [s.id])).rows[0];
  if (busy) s = await openSession(callee.id, place ? "thread" : "api", `${placeKey}:call-${from.toolCallId}`, where);
  else await pool.query("UPDATE sessions SET place = $2 WHERE id = $1", [s.id, where]);
  const { run, created } = await submit({ sessionId: s.id, personId: from.personId, requestId: `${kind}:${from.runId}:${callee.slug}:${from.toolCallId}`, text, source: "teammate", chainId: root });
  if (created) {
    await appendEvent({ sessionId: from.sessionId, runId: from.runId, type: "chain.call", data: { root: root ?? from.runId, parent_run: from.runId, child_run: run.id, depth: depth + 1, caller: from.caller.slug, callee: callee.slug, kind } });
    await startRun(run.id);
  }
  return { runId: run.id, sessionId: s.id, inDm: Boolean(place && here && place.channel !== here.channel) };
}

// The callee's answer: what it posted, else its final text.
export async function answerOf(runId: string, timeoutMs: number): Promise<{ status: string; text: string }> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = (await pool.query("SELECT status FROM runs WHERE id = $1", [runId])).rows[0];
    if (r && ["done", "failed", "cancelled"].includes(r.status)) {
      const posts = (await pool.query("SELECT data->>'text' AS t FROM events WHERE run_id = $1 AND type = 'slack.post' ORDER BY id", [runId])).rows.map((x) => x.t);
      const fin = (await pool.query("SELECT data->>'text' AS t FROM events WHERE run_id = $1 AND type = 'turn.finished' ORDER BY id DESC LIMIT 1", [runId])).rows[0]?.t ?? "";
      return { status: r.status, text: (posts.join("\n\n") || fin).slice(0, 6000) };
    }
    if (Date.now() > until) return { status: "running", text: "" };
    await new Promise((x) => setTimeout(x, 2000));
  }
}

// Stop for a whole chain: every run of every teammate working in this thread.
export async function threadSessions(sessionId: string): Promise<string[]> {
  const s = await getSession(sessionId);
  const slack = (s?.place as any)?.slack;
  if (!slack) return [sessionId];
  const { rows } = await pool.query("SELECT id FROM sessions WHERE place->'slack'->>'channel' = $1 AND place->'slack'->>'thread_ts' = $2", [slack.channel, slack.thread_ts]);
  return rows.map((r) => r.id);
}
