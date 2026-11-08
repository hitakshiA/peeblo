// A teammate's App Home (SLACK_UX_SPEC §3.2): the control surface, drawn per viewer by code. Header and status, the
// jobs running now (with Open thread and Stop), cards waiting on the viewer, recent jobs with cost and receipt, the
// budget meter, schedules (Pause), memory to verify, and owner-only Settings / Pause teammate. Viewers from the
// last 10 minutes get it re-published when a run, approval or budget event fires (at most every 3 s each).
import { config } from "../config.ts";
import { pool } from "../db.ts";
import { getApp } from "../ingress/apps.ts";
import { teammateSpend, usd } from "../otari/spend.ts";
import { onEvent } from "../store/events.ts";
import { personForSlack } from "../store/people.ts";
import { getTeammate, type Teammate } from "../store/teammates.ts";
import { slack } from "./api.ts";

const viewers = new Map<string, { appId: string; teammateId: string; user: string; at: number; last: number; timer?: NodeJS.Timeout }>();

async function permalink(appId: string, place: any): Promise<string | null> {
  if (!place?.channel || !place?.thread_ts) return null;
  const r: any = await slack(appId, "chat.getPermalink", { channel: place.channel, message_ts: place.thread_ts }).catch(() => null);
  return r?.permalink ?? null;
}

export async function homeBlocks(appId: string, tm: Teammate, user: string): Promise<any[]> {
  const c = tm.config;
  const team = String((await getApp(appId))?.team_id ?? "");
  const viewer = await personForSlack(team, user);
  const { mayManageTeammate, isOtariAdmin } = await import("../authority.ts");
  const manager = mayManageTeammate(tm, viewer);
  const paused = Boolean((await pool.query("SELECT paused_at FROM teammates WHERE id = $1", [tm.id])).rows[0]?.paused_at);
  const running = (await pool.query(
    `SELECT r.id, r.status, s.place, left(sub.text, 90) AS asked, sub.source FROM runs r JOIN sessions s ON s.id = r.session_id JOIN submissions sub ON sub.id = r.submission_id
      WHERE s.teammate_id = $1 AND r.status IN ('queued', 'running', 'waiting') ORDER BY r.created_at DESC LIMIT 5`, [tm.id])).rows;
  // Peeblo's owner is whoever runs it (the first admin), never "none yet".
  const owner = tm.owner_person ? (await pool.query("SELECT slack_user, display_name FROM people WHERE id = $1", [tm.owner_person])).rows[0]
    : tm.slug === "peeblo" ? (await pool.query("SELECT slack_user, display_name FROM people WHERE slack_user = ANY($1) ORDER BY created_at LIMIT 1", [config.admins])).rows[0] : null;
  const status = paused ? "Paused" : running.length ? `Working on ${running.length} job${running.length > 1 ? "s" : ""}` : "Idle";
  const face = config.publicUrl ? { type: "image", image_url: `${config.publicUrl}/faces/${tm.slug}.png?v=${tm.version}`, alt_text: c.name } : undefined;
  const blocks: any[] = [
    { type: "section", text: { type: "mrkdwn", text: `*${c.name}*  ·  ${c.role}\nOwner: ${owner?.slack_user ? `<@${owner.slack_user}>` : owner?.display_name ?? "none yet"}  ·  *${status}*` }, ...(face ? { accessory: face } : {}) },
  ];
  // Now: running jobs, each with its current plan step.
  blocks.push({ type: "header", text: { type: "plain_text", text: "Now" } });
  if (!running.length) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "Nothing running." }] });
  for (const r of running) {
    const step = (await pool.query("SELECT data FROM events WHERE run_id = $1 AND type = 'plan.updated' ORDER BY id DESC LIMIT 1", [r.id])).rows[0]?.data?.steps?.find((x: any) => x.status === "doing")?.step;
    const link = await permalink(appId, r.place?.slack);
    // What a person asked, in their words; runs no person started are named for what they are.
    const label = r.source === "welcome" ? "Saying hello to someone new" : r.source === "schedule" || r.source === "webhook" ? "A scheduled job" : r.source === "teammate" ? `A job from another teammate: ${String(r.asked).split("\n").find((l: string) => l.startsWith("Objective:"))?.slice(11) ?? ""}` : String(r.asked).replace(/<[^>]+>/g, "").replace(/\n/g, " ");
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `${r.status === "waiting" ? "⏸️ waiting for approval" : "⏳"} ${label.slice(0, 200)}${step ? `\n_${step}_` : ""}` } });
    blocks.push({ type: "actions", elements: [
      ...(link ? [{ type: "button", text: { type: "plain_text", text: "Open thread" }, url: link, action_id: `open_thread:${r.id}` }] : []),
      { type: "button", style: "danger", text: { type: "plain_text", text: "Stop" }, action_id: "stop_run", value: r.id },
    ] });
  }
  // Waiting on you: cards this viewer may answer.
  const cards = (await pool.query(
    `SELECT a.id, a.action FROM approvals a JOIN runs r ON r.id = a.run_id JOIN sessions s ON s.id = r.session_id
      WHERE s.teammate_id = $1 AND a.status = 'pending' AND a.expires_at > now() AND a.action->'approvers' ? $2 ORDER BY a.created_at DESC LIMIT 5`, [tm.id, viewer.id])).rows;
  if (cards.length) {
    blocks.push({ type: "header", text: { type: "plain_text", text: "Waiting on you" } });
    for (const a of cards) {
      const what = a.action.summary ?? (a.action.tool ? `${a.action.tool}${a.action.server ? ` (${a.action.server})` : ""}` : a.action.kind);
      blocks.push({ type: "section", text: { type: "mrkdwn", text: `${String(what).slice(0, 280)}${a.action.risk === "money" ? " · moves money" : ""}` } });
      blocks.push({ type: "actions", elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" }, action_id: "approve_once", value: a.id },
        { type: "button", text: { type: "plain_text", text: "Not now" }, action_id: "deny", value: a.id },
      ] });
    }
  }
  // Recent: the last 5 finished jobs, with cost and receipt link.
  const recent = (await pool.query(
    `SELECT r.id, r.status, left(sub.text, 80) AS asked, (SELECT coalesce(sum((e.data->>'cost_usd')::numeric), 0) FROM events e WHERE e.run_id = r.id AND e.type = 'model.call') AS cost
       FROM runs r JOIN sessions s ON s.id = r.session_id JOIN submissions sub ON sub.id = r.submission_id
      WHERE s.teammate_id = $1 AND r.status IN ('done', 'failed') AND sub.source <> 'welcome'
        AND r.created_at > coalesce((SELECT max(at) FROM audit WHERE action = 'peeblo.clean_start'), 'epoch') ORDER BY r.created_at DESC LIMIT 5`, [tm.id])).rows;
  blocks.push({ type: "header", text: { type: "plain_text", text: "Recent" } });
  const lines: string[] = [];
  for (const r of recent) {
    const { buildReceipt } = await import("../receipts.ts");
    const link = await buildReceipt(r.id).then((x) => x.links?.session ?? null).catch(() => null);
    lines.push(`${r.status === "done" ? "✅" : "⚠️"} ${String(r.asked).replace(/\n/g, " ").replace(/<[^>]+>/g, "").trim() || "(a job)"} · ${usd(Number(r.cost))}${link ? ` · <${link}|receipt>` : ""}`);
  }
  blocks.push({ type: "section", text: { type: "mrkdwn", text: lines.join("\n") || "No jobs yet." } });
  // Budget meter: the teammate's month, and the viewer's share of it.
  const spend = await teammateSpend(tm).catch(() => null);
  const mine = Number((await pool.query(
    `SELECT coalesce(sum((e.data->>'cost_usd')::numeric), 0) AS c FROM events e JOIN sessions s ON s.id = e.session_id
      WHERE s.teammate_id = $1 AND e.type = 'model.call' AND e.data->>'end_user' = $2 AND e.at >= date_trunc('month', now())`, [tm.id, viewer.end_user_id])).rows[0].c);
  blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Budget*  ${spend ? `${usd(spend.spent)} of ${usd(spend.cap)} this month` : `${usd(c.budget.monthly_usd)} a month`} · yours ${usd(mine)}` } });
  // Schedules: next run, Pause.
  const sch = (await pool.query("SELECT id, kind, name, cron, run_at, enabled FROM schedules WHERE teammate_id = $1 ORDER BY created_at DESC LIMIT 5", [tm.id])).rows;
  if (sch.length) {
    blocks.push({ type: "header", text: { type: "plain_text", text: "Schedules" } });
    for (const s of sch) blocks.push({ type: "section", text: { type: "mrkdwn", text: `${s.enabled ? "🟢" : "⏸️"} *${s.name ?? s.id}* · ${s.kind === "cron" ? `\`${s.cron}\` UTC` : s.kind === "once" ? `once at ${new Date(s.run_at).toISOString().slice(0, 16)} UTC` : s.kind}` },
      accessory: { type: "button", text: { type: "plain_text", text: s.enabled ? "Pause" : "Resume" }, action_id: s.enabled ? "pause_schedule" : "resume_schedule", value: s.id } });
  }
  const { memoryBlocks } = await import("./interactions.ts");
  blocks.push(...(await memoryBlocks(tm, user)));
  // Owner (or admin) controls.
  if (manager || isOtariAdmin(viewer)) blocks.push({ type: "actions", elements: [
    { type: "button", text: { type: "plain_text", text: "Settings" }, action_id: "open_settings", value: tm.slug },
    paused ? { type: "button", style: "primary", text: { type: "plain_text", text: "Resume teammate" }, action_id: "resume_teammate", value: tm.slug }
      : { type: "button", style: "danger", text: { type: "plain_text", text: "Pause teammate" }, action_id: "pause_teammate", value: tm.slug },
  ] });
  const { readableModel } = await import("./look.ts");
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `Runs on ${readableModel(c.model.default).name} · ${c.mode.charAt(0).toUpperCase()}${c.mode.slice(1)} mode · every reply ends with its receipt` }] });
  return blocks;
}

export async function publishHome(appId: string, teammateId: string, user: string, extra: any[] = []): Promise<void> {
  const tm = await getTeammate(teammateId);
  if (!tm) return;
  const k = `${appId}:${user}`;
  const v = viewers.get(k) ?? { appId, teammateId, user, at: 0, last: 0 };
  v.at = Date.now(); v.last = Date.now();
  viewers.set(k, v);
  await slack(appId, "views.publish", { user_id: user, view: { type: "home", blocks: [...extra, ...(await homeBlocks(appId, tm, user))].slice(0, 100) } });
}

// Live updates for anyone who looked in the last 10 minutes, throttled to one publish per 3 s per viewer.
export function installLiveHome(extraFor: (appId: string, teammateId: string, user: string) => Promise<any[]>): void {
  onEvent(async (e) => {
    if (!/^(run\.|approval\.|budget\.|plan\.updated)/.test(e.type) || !e.session_id) return;
    const tmId = (await pool.query("SELECT teammate_id FROM sessions WHERE id = $1", [e.session_id])).rows[0]?.teammate_id;
    if (!tmId) return;
    for (const [k, v] of viewers) {
      if (v.teammateId !== tmId) continue;
      if (Date.now() - v.at > 600_000) { viewers.delete(k); continue; }
      if (v.timer) continue;
      const delay = Math.max(0, v.last + 3000 - Date.now());
      v.timer = setTimeout(() => { v.timer = undefined; v.last = Date.now(); void extraFor(v.appId, v.teammateId, v.user).then((x) => slack(v.appId, "views.publish", { user_id: v.user, view: { type: "home", blocks: x } })).catch(() => {}); }, delay);
    }
  });
}
