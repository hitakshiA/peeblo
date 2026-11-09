// Clicks and views in Slack:
// - approval buttons: the person who clicked is checked on the server (an approval may name its approvers); the
//   card then shows who decided;
// - 👍/👎 on a reply are recorded; 👎 also mutes the thread for unprompted posts (K2);
// - App Home: each teammate's profile page (its card, model, budget, mode, tools and recent jobs).
import { pool } from "../db.ts";
import { answerApproval } from "../durable/approvals.ts";
import { onSlackEvent, onSlackInteraction } from "../ingress/slack.ts";
import { teammateSpend, usd } from "../otari/spend.ts";
import { appendEvent } from "../store/events.ts";
import { personForSlack } from "../store/people.ts";
import { getTeammate } from "../store/teammates.ts";
import { displayName, slack } from "./api.ts";
import { getApp } from "../ingress/apps.ts";

const SCOPES: Record<string, { decision: "approved" | "denied"; scope: "once" | "job" | "always" }> = {
  approve_once: { decision: "approved", scope: "once" }, deny: { decision: "denied", scope: "once" },
};

async function respond(url: string | undefined, body: Record<string, unknown>): Promise<void> {
  if (url) await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
}

async function feedbackNote(sessionId: string, runId: string, vote: string, by: string, what?: string): Promise<void> {
  const { getSession } = await import("../store/sessions.ts");
  const { placeOfSession, writeNote } = await import("../memory/store.ts");
  const s = await getSession(sessionId);
  const tm = s ? await getTeammate(s.teammate_id) : null;
  if (!s || !tm) return;
  const asked = (await pool.query("SELECT left(sub.text, 300) AS t FROM runs r JOIN submissions sub ON sub.id = r.submission_id WHERE r.id = $1", [runId])).rows[0]?.t ?? "";
  const answer = (await pool.query("SELECT left(data->>'text', 500) AS t FROM events WHERE run_id = $1 AND type IN ('slack.post', 'turn.finished') ORDER BY id DESC LIMIT 1", [runId])).rows[0]?.t ?? "";
  await writeNote(tm.slug, placeOfSession(s), { path: `feedback/${runId}`, title: `${by} marked a reply ${vote === "up" ? "helpful" : "not helpful"}`, body: `${what ? `What was off: ${what}\n\n` : ""}Asked: ${asked}\n\nReply: ${answer}`, source: `${by}, Slack feedback`, runId, tainted: true });
}

// Replaces a card (wherever it was posted) with its outcome line.
async function updateCard(approvalId: string, text: string | null): Promise<void> {
  if (!text) return;
  const c = (await pool.query("SELECT data FROM events WHERE type = 'approval.card' AND data->>'approval_id' = $1 LIMIT 1", [approvalId])).rows[0]?.data;
  // An inline card (inside the reply's message) is collapsed by the view on approval.resolved; redrawing it here
  // would wipe the steps around it.
  if (c && !c.inline) await slack(c.app_id, "chat.update", { channel: c.channel, ts: c.ts, text, blocks: [{ type: "context", elements: [{ type: "mrkdwn", text }] }] }).catch(() => null);
}

// Who may answer an approval, for the "only X can answer" reply.
async function namesFor(approvalId: string): Promise<string> {
  const { approverNames } = await import("../approvers.ts");
  const ids = (await pool.query("SELECT action->'approvers' AS a FROM approvals WHERE id = $1", [approvalId])).rows[0]?.a ?? [];
  return approverNames(ids);
}

export function installSlackInteractions(): void {
  onSlackInteraction(async ({ appId, payload }) => {
    // 👎's "What was off?": the choices and the line become the note the teammate learns from.
    if (payload.type === "view_submission" && payload.view?.callback_id === "feedback_down") {
      const runId = String(payload.view.private_metadata);
      const values = payload.view.state?.values ?? {};
      const picked = (values.why?.v?.selected_options ?? []).map((o: any) => o.text?.text).filter(Boolean);
      const more = String(values.more?.v?.value ?? "").trim();
      const what = [picked.join(", "), more].filter(Boolean).join(". ");
      const run = (await pool.query("SELECT session_id FROM runs WHERE id = $1", [runId])).rows[0];
      const team = payload.team?.id ?? payload.user?.team_id;
      const who = await personForSlack(team, payload.user.id);
      await appendEvent({ sessionId: run?.session_id ?? null, runId, type: "slack.feedback_detail", data: { what, by: who.id } });
      if (run) await feedbackNote(run.session_id, runId, "down", who.display_name ?? payload.user.id, what || undefined).catch(() => null);
      // "Too long" is how this person likes answers: it goes on their card for every teammate.
      if (picked.includes("Too long")) { const { addToCard } = await import("../memory/work.ts"); addToCard(who.id, "Found a reply too long; keep answers short", "their 👎"); }
      return;
    }
    // The "Not now" form: a no, with the reason if one was given (Send), or without one (Skip closes the form).
    if ((payload.type === "view_submission" || payload.type === "view_closed") && payload.view?.callback_id === "not_now") {
      const id = String(payload.view.private_metadata);
      const team = payload.team?.id ?? payload.user?.team_id;
      const who = await personForSlack(team, payload.user.id);
      const reason = payload.type === "view_submission" ? String(payload.view.state?.values?.reason?.v?.value ?? "").trim() || undefined : undefined;
      await answerApproval(id, { decision: "denied", scope: "once", personId: who.id, reason });
      return;
    }
    // The Edit form on an approval card: the approver's edited call is what runs.
    if (payload.type === "view_submission" && payload.view?.callback_id === "edit_approval") {
      const id = String(payload.view.private_metadata);
      const team = payload.team?.id ?? payload.user?.team_id;
      const who = await personForSlack(team, payload.user.id);
      const row = (await pool.query("SELECT action FROM approvals WHERE id = $1", [id])).rows[0];
      if (!row) return;
      const { editedArgs } = await import("./approval-card.ts");
      const args = editedArgs(row.action.arguments ?? {}, payload.view.state?.values ?? {});
      const r = await answerApproval(id, { decision: "approved", scope: "once", personId: who.id, arguments: args });
      await updateCard(id, r.ok ? `✓ Approved with edits by ${who.display_name ?? `<@${payload.user.id}>`}` : r.status === "not_allowed" ? null : `This request is ${r.status.replace("_", " ")}; nothing changed.`);
      return;
    }
    if (payload.type !== "block_actions") return;
    const a = payload.actions?.[0];
    if (!a) return;
    const team = payload.team?.id ?? payload.user?.team_id;
    const who = await personForSlack(team, payload.user.id, { displayName: (await displayName(appId, payload.user.id)) ?? undefined });
    // Settings (App Home, the hire card): the settings modal, for the owner or an admin.
    if (a.action_id === "open_settings") {
      const tm = await getTeammate(String(a.value));
      const { mayManageTeammate } = await import("../authority.ts");
      if (!tm || !mayManageTeammate(tm, who)) return void (await respond(payload.response_url, { response_type: "ephemeral", replace_original: false, text: `Only ${tm?.config.name ?? "its"} owner or an admin can change its settings.` }).catch(() => {}));
      const { settingsModal } = await import("./commands.ts");
      await slack(appId, "views.open", { trigger_id: payload.trigger_id, view: await settingsModal(tm) });
      return;
    }
    // Not now: the small form (only someone who may answer the card can open it).
    if (a.action_id === "not_now") {
      const row = (await pool.query("SELECT action, status FROM approvals WHERE id = $1", [a.value])).rows[0];
      if (!row || row.status !== "pending") return;
      if (!(row.action.approvers ?? []).includes(who.id) && !(await (await import("../approvers.ts")).adminIds()).includes(who.id)) return void (await respond(payload.response_url, { response_type: "ephemeral", replace_original: false, text: `Only ${await namesFor(String(a.value))} can answer this one.` }));
      const tm = await getTeammate(row.action.teammate);
      const { notNowModal } = await import("./approval-card.ts");
      await slack(appId, "views.open", { trigger_id: payload.trigger_id, view: notNowModal(row.action, String(a.value), tm?.config.name ?? "the teammate") });
      return;
    }
    // "Always allow …?" under an approved card: the teammate's owner (or an admin) adds a standing grant.
    if (a.action_id === "always_allow") {
      const row = (await pool.query("SELECT action FROM approvals WHERE id = $1", [a.value])).rows[0];
      const tm = row ? await getTeammate(row.action.teammate) : null;
      const { mayManageTeammate } = await import("../authority.ts");
      if (!row?.action?.grant_fp || !tm) return;
      if (!mayManageTeammate(tm, who)) return void (await respond(payload.response_url, { response_type: "ephemeral", replace_original: false, text: `Only ${tm.config.name}'s owner can allow this for good.` }));
      const exists = (await pool.query("SELECT 1 FROM grants WHERE teammate_id = $1 AND fingerprint = $2 AND scope = 'always' LIMIT 1", [tm.id, row.action.grant_fp])).rows.length;
      if (!exists) await pool.query("INSERT INTO grants (id, teammate_id, fingerprint, scope, run_id) VALUES ($1, $2, $3, 'always', NULL)", [`gr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, tm.id, row.action.grant_fp]);
      await appendEvent({ type: "grant.added", data: { teammate_id: tm.id, approval_id: a.value, fingerprint: row.action.grant_fp, by: who.id } });
      const { alwaysPhrase } = await import("./approval-card.ts");
      const done = `${(alwaysPhrase(row.action) ?? "This").replace(/^Always allow /, "").replace(/\?$/, "")}: always allowed now · ${String(who.display_name ?? "").split(" ")[0]}`;
      const blocks = (payload.message?.blocks ?? []).map((b: any) => (b.block_id === `always:${a.value}` ? { type: "context", elements: [{ type: "mrkdwn", text: done.charAt(0).toUpperCase() + done.slice(1) }] } : b));
      if (payload.channel?.id && payload.message?.ts) await slack(appId, "chat.update", { channel: payload.channel.id, ts: payload.message.ts, text: payload.message.text ?? "", blocks }).catch(() => null);
      return;
    }
    // The Receipt button: the receipt modal (facts, steps, one "Open full trace" link).
    if (a.action_id === "open_receipt") {
      const { receiptModal } = await import("./receipt-modal.ts");
      await slack(appId, "views.open", { trigger_id: payload.trigger_id, view: await receiptModal(String(a.value)) });
      return;
    }
    // Edit: the form with the call's arguments (only someone who may answer the card can open it).
    if (a.action_id === "edit_approval") {
      const row = (await pool.query("SELECT action, status FROM approvals WHERE id = $1", [a.value])).rows[0];
      if (!row || row.status !== "pending") return;
      if (!(row.action.approvers ?? []).includes(who.id) && !(await (await import("../approvers.ts")).adminIds()).includes(who.id)) return void (await respond(payload.response_url, { response_type: "ephemeral", replace_original: false, text: `Only ${await namesFor(String(a.value))} can answer this one.` }));
      const tm = await getTeammate(row.action.teammate);
      const { editModal } = await import("./approval-card.ts");
      await slack(appId, "views.open", { trigger_id: payload.trigger_id, view: editModal(row.action, String(a.value), tm?.config.name ?? "the teammate") });
      return;
    }
    if (a.action_id in SCOPES) {
      const { decision, scope } = SCOPES[a.action_id];
      const r = await answerApproval(String(a.value), { decision, scope, personId: who.id });
      const name = who.display_name ?? `<@${payload.user.id}>`;
      const text = r.ok ? `${decision === "approved" ? `✅ Approved (${scope === "once" ? "once" : scope === "job" ? "for this job" : "always"})` : "✋ Declined"} by ${name}`
        : r.status === "not_allowed" ? `Only ${await namesFor(String(a.value))} can answer this one. It's still waiting.`
        : `This request is ${r.status.replace("_", " ")}; nothing changed.`;
      // The card collapses in place when the run sees the decision (the view); only problems answer here, privately.
      if (!r.ok) await respond(payload.response_url, { response_type: "ephemeral", replace_original: false, text });
      return;
    }
    // App Home controls. Stop: anyone who may see the job. Schedules and pausing: the owner or an admin.
    if (["stop_run", "pause_schedule", "resume_schedule", "pause_teammate", "resume_teammate"].includes(a.action_id)) {
      const { mayManageTeammate } = await import("../authority.ts");
      let tmId: string | null = null;
      if (a.action_id === "stop_run") {
        const r = (await pool.query("SELECT r.session_id, s.teammate_id, sub.person_id FROM runs r JOIN sessions s ON s.id = r.session_id JOIN submissions sub ON sub.id = r.submission_id WHERE r.id = $1", [a.value])).rows[0];
        // The same rule as a typed "stop": the person who asked, the teammate's owner, or an admin.
        const owner = r ? await getTeammate(r.teammate_id) : null;
        if (r && !(r.person_id === who.id || (owner && mayManageTeammate(owner, who)))) return void (await respond(payload.response_url, { response_type: "ephemeral", text: "Only the person who asked for this job, its teammate's owner or an admin can stop it." }).catch(() => {}));
        if (r) { tmId = r.teammate_id; const { stopSession } = await import("../pi/supervisor.ts"); await appendEvent({ sessionId: r.session_id, type: "slack.stop", data: { user: payload.user.id, from: "home", stopped: true } }); await stopSession(r.session_id); }
      } else if (a.action_id.endsWith("_schedule")) {
        const sc = (await pool.query("SELECT teammate_id, created_by FROM schedules WHERE id = $1", [a.value])).rows[0];
        const tm = sc ? await getTeammate(sc.teammate_id) : null;
        if (!tm || !(sc.created_by === who.id || mayManageTeammate(tm, who))) return void (await respond(payload.response_url, { response_type: "ephemeral", text: "Only the person who set it up, the owner or an admin can change this schedule." }).catch(() => {}));
        await pool.query("UPDATE schedules SET enabled = $2 WHERE id = $1", [a.value, a.action_id === "resume_schedule"]);
        const { syncSchedules } = await import("../durable/schedules.ts"); await syncSchedules();
        tmId = tm.id;
      } else {
        const tm = await getTeammate(String(a.value));
        if (!tm || !mayManageTeammate(tm, who)) return;
        await pool.query("UPDATE teammates SET paused_at = $2 WHERE id = $1", [tm.id, a.action_id === "pause_teammate" ? new Date() : null]);
        await appendEvent({ type: "teammate.paused", data: { teammate_id: tm.id, paused: a.action_id === "pause_teammate", by: who.id } });
        tmId = tm.id;
      }
      if (tmId && payload.view?.type === "home") { const { publishHome } = await import("./home.ts"); await publishHome(appId, tmId, payload.user.id, await homeExtra(appId, tmId, payload.user.id)).catch(() => {}); }
      return;
    }
    // "Ask again" on an expired card: a new turn in the same conversation that makes the same call again (a new card).
    // Older expired cards carry the run id; their latest expired approval is the one to re-ask.
    if (a.action_id === "ask_again" || a.action_id === "retry_run") {
      const ap = (await pool.query(`SELECT a.id, a.action, a.run_id, r.session_id FROM approvals a JOIN runs r ON r.id = a.run_id
        WHERE (a.id = $1 OR (a.run_id = $1 AND $2)) AND (a.status = 'expired' OR (a.status = 'pending' AND a.expires_at < now())) ORDER BY a.created_at DESC LIMIT 1`, [a.value, a.action_id === "retry_run"])).rows[0];
      if (ap) {
        const act = ap.action ?? {};
        const tool = act.tool ?? "the call";
        const args = act.arguments ? JSON.stringify(act.arguments).slice(0, 1500) : "";
        const { submit } = await import("../store/sessions.ts");
        const { startRun } = await import("../durable/runs.ts");
        const text = `Ask again: I'm here now. Call ${tool} again${act.summary ? ` (${act.summary})` : ""} with the same arguments${args ? `: ${args}` : ""}, so I get a new card to approve.`;
        const { run, created } = await submit({ sessionId: ap.session_id, personId: who.id, requestId: `ask_again:${ap.id}:${payload.action_ts ?? Date.now()}`, text, source: "slack" });
        if (created) await startRun(run.id);
        return;
      }
      if (a.action_id === "ask_again") return;
    }
    // Recovering from a failed run (SLACK_UX_SPEC §3.6): retry, or ask the owner.
    if (["retry_run", "ask_owner"].includes(a.action_id)) {
      const r = (await pool.query("SELECT r.session_id, sub.text, sub.person_id, s.teammate_id, s.place FROM runs r JOIN submissions sub ON sub.id = r.submission_id JOIN sessions s ON s.id = r.session_id WHERE r.id = $1", [a.value])).rows[0];
      const tm = r ? await getTeammate(r.teammate_id) : null;
      if (!r || !tm) return;
      if (a.action_id === "ask_owner") {
        const owner = tm.owner_person ? (await pool.query("SELECT slack_user FROM people WHERE id = $1", [tm.owner_person])).rows[0]?.slack_user : null;
        if (!owner) return void (await respond(payload.response_url, { response_type: "ephemeral", replace_original: false, text: `${tm.config.name} has no owner yet; an admin can help.` }).catch(() => {}));
        const dm: any = await slack(appId, "conversations.open", { users: owner }).catch(() => null);
        const link: any = r.place?.slack ? await slack(appId, "chat.getPermalink", { channel: r.place.slack.channel, message_ts: r.place.slack.thread_ts }).catch(() => null) : null;
        if (dm?.channel?.id) await slack(appId, "chat.postMessage", { channel: dm.channel.id, text: `<@${payload.user.id}> asked you to look at a job ${tm.config.name} couldn't finish${link?.permalink ? `: ${link.permalink}` : "."}` }).catch(() => null);
        return void (await respond(payload.response_url, { response_type: "ephemeral", replace_original: false, text: `Asked <@${owner}> to take a look.` }).catch(() => {}));
      }
      const { submit } = await import("../store/sessions.ts");
      const { startRun } = await import("../durable/runs.ts");
      const { run, created } = await submit({ sessionId: r.session_id, personId: who.id, requestId: `${a.action_id}:${a.value}:${payload.action_ts ?? Date.now()}`, text: r.text, source: "slack" });
      if (created) await startRun(run.id);
      return;
    }
    // Out of budget: ask the owner for more, and the owner's raise.
    if (a.action_id.startsWith("raise_budget")) a.action_id = "raise_budget"; // one per button: Slack needs unique ids
    if (a.action_id === "ask_budget" || a.action_id === "raise_budget") {
      const [slug, amount] = String(a.value).split(":");
      const tm = await getTeammate(slug);
      if (!tm) return;
      const { mayManageTeammate } = await import("../authority.ts");
      if (a.action_id === "raise_budget") {
        if (!mayManageTeammate(tm, who)) return void (await respond(payload.response_url, { response_type: "ephemeral", replace_original: false, text: `Only ${tm.config.name}'s owner or an admin can raise its budget.` }).catch(() => {}));
        const { configProblems } = await import("../hire-rules.ts");
        const bad = await configProblems(who, { budget_usd: Number(amount) });
        if (bad) return void (await respond(payload.response_url, { response_type: "ephemeral", replace_original: false, text: bad }).catch(() => {}));
        const { updateTeammate } = await import("../store/teammates.ts");
        await updateTeammate(tm.slug, { budget: { monthly_usd: Number(amount) } } as any, { label: `${who.display_name ?? "the owner"} from Slack` }, "budget raised from the budget card");
        return void (await respond(payload.response_url, { replace_original: true, text: `✓ ${tm.config.name}'s budget is now $${amount} a month (raised by ${who.display_name ?? "the owner"}).` }).catch(() => {}));
      }
      const owner = tm.owner_person ? (await pool.query("SELECT slack_user FROM people WHERE id = $1", [tm.owner_person])).rows[0]?.slack_user : null;
      if (!owner) return void (await respond(payload.response_url, { response_type: "ephemeral", replace_original: false, text: `${tm.config.name} has no owner yet; ask an admin.` }).catch(() => {}));
      const dm: any = await slack(appId, "conversations.open", { users: owner }).catch(() => null);
      const now = tm.config.budget.monthly_usd;
      const { raiseOptions, teammateSpend } = await import("../otari/spend.ts");
      const up = raiseOptions(now, (await teammateSpend(tm).catch(() => null))?.spent ?? 0);
      if (dm?.channel?.id) await slack(appId, "chat.postMessage", { channel: dm.channel.id, text: `${tm.config.name} has used its $${now} for this month.`, blocks: [
        { type: "section", text: { type: "mrkdwn", text: `<@${payload.user.id}> asked for more budget: *${tm.config.name}* has used its $${now} for this month.` } },
        { type: "actions", elements: up.map((x, i) => ({ type: "button", ...(i === 0 ? { style: "primary" } : {}), text: { type: "plain_text", text: `Raise to $${x}` }, action_id: `raise_budget:${i}`, value: `${tm.slug}:${x}` })) },
        { type: "context", elements: [{ type: "mrkdwn", text: "Only the owner or an admin can raise it." }] },
      ] }).catch(() => null);
      return void (await respond(payload.response_url, { response_type: "ephemeral", replace_original: false, text: `Asked <@${owner}> for more budget.` }).catch(() => {}));
    }
    if (a.action_id === "verify_note") {
      const [slug, bank, ...rest] = String(a.value).split("|");
      const tm = await getTeammate(slug);
      const { mayManageTeammate } = await import("../authority.ts");
      if (!tm || !mayManageTeammate(tm, who)) return void (await respond(payload.response_url, { response_type: "ephemeral", text: "Only this teammate's owner or an admin can verify its memory." }));
      const { verifyNote } = await import("../memory/store.ts");
      verifyNote(slug, bank, rest.join("|"));
      await appendEvent({ type: "memory.verified", data: { teammate_id: tm.id, bank, path: rest.join("|"), by: who.id } });
      return;
    }
    if (String(a.action_id).startsWith("feedback:")) {
      const [vote, runId] = String(a.value).split(":");
      const run = (await pool.query("SELECT session_id FROM runs WHERE id = $1", [runId])).rows[0];
      await appendEvent({ sessionId: run?.session_id ?? null, runId, type: "slack.feedback", data: { vote, by: who.id } });
      if (vote === "down" && run) await pool.query("UPDATE sessions SET place = jsonb_set(place, '{muted}', 'true'::jsonb) WHERE id = $1", [run.session_id]);
      // 👎 asks what was off (a few choices and a line); the answer becomes a note the teammate learns from.
      if (vote === "down" && run && payload.trigger_id) {
        const opt = (v: string, t: string) => ({ value: v, text: { type: "plain_text", text: t } });
        await slack(appId, "views.open", { trigger_id: payload.trigger_id, view: {
          type: "modal", callback_id: "feedback_down", private_metadata: runId,
          title: { type: "plain_text", text: "What was off?" }, submit: { type: "plain_text", text: "Send" }, close: { type: "plain_text", text: "Skip" },
          blocks: [
            { type: "input", block_id: "why", optional: true, label: { type: "plain_text", text: "Pick any" }, element: { type: "checkboxes", action_id: "v", options: [opt("wrong", "It was wrong"), opt("long", "Too long"), opt("missed", "It missed something"), opt("acted", "It shouldn't have done that"), opt("slow", "Too slow")] } },
            { type: "input", block_id: "more", optional: true, label: { type: "plain_text", text: "Anything else" }, element: { type: "plain_text_input", action_id: "v", max_length: 500 } },
          ] } }).catch(() => null);
        return;
      }
      await feedbackNote(run?.session_id, runId, vote, who.display_name ?? payload.user.id).catch(() => null);
      await respond(payload.response_url, { response_type: "ephemeral", replace_original: false, text: "Thanks, noted." });
    }
  });

  onSlackEvent(async ({ appId, teammateId, event }) => {
    // Slack's native Stop on a working agent session: stop the run(s) in that thread, then mark it active.
    if (event.type === "agent_session_stopped" && teammateId) {
      const channel = event.channel_id ?? event.channel ?? event.session?.channel_id;
      const thread = event.thread_ts ?? event.session?.thread_ts;
      const s = (await pool.query("SELECT id FROM sessions WHERE teammate_id = $1 AND place_key = $2 ORDER BY last_active_at DESC NULLS LAST LIMIT 1", [teammateId, `${channel}:${thread}`])).rows[0];
      // Slack shows this Stop in the asker's own session view; it still follows the stop rule.
      const asker = s ? (await pool.query("SELECT sub.person_id FROM runs r JOIN submissions sub ON sub.id = r.submission_id WHERE r.session_id = $1 AND r.status IN ('queued', 'running', 'waiting') ORDER BY r.created_at DESC LIMIT 1", [s.id])).rows[0] : null;
      const who = event.user ? (await pool.query("SELECT * FROM people WHERE slack_user = $1", [event.user])).rows[0] : null;
      const tm = await getTeammate(teammateId);
      const { mayManageTeammate } = await import("../authority.ts");
      const allowed = !asker || (who && (asker.person_id === who.id || (tm && mayManageTeammate(tm, who))));
      if (s && allowed) {
        const { stopSession } = await import("../pi/supervisor.ts");
        // Recorded first, so the job's ending can say who stopped it.
        await appendEvent({ sessionId: s.id, type: "slack.stop", data: { user: event.user ?? null, from: "agent_session_stopped", stopped: true } });
        await stopSession(s.id);
      }
      await slack(appId, "agents.sessions.setStatus", { channel_id: channel, thread_ts: thread, status: "active" }).catch(() => null);
      return;
    }
    // The Messages tab: a first-time visitor gets the teammate's welcome; everyone sees its starter prompts.
    if (event.type === "app_home_opened" && event.tab === "messages" && teammateId) {
      const team = String((await getApp(appId))?.team_id ?? "");
      const { welcomeOnce, setPrompts } = await import("./welcome.ts");
      if (!(await welcomeOnce(appId, teammateId, team, event.user, "opened"))) {
        const tm = await getTeammate(teammateId);
        if (tm && event.channel) await setPrompts(tm, appId, event.channel);
      }
      return;
    }
    if (event.type !== "app_home_opened" || event.tab !== "home" || !teammateId) return;
    const { publishHome } = await import("./home.ts");
    await publishHome(appId, teammateId, event.user, await homeExtra(appId, teammateId, event.user));
  });
  void import("./home.ts").then(({ installLiveHome, homeBlocks }) => installLiveHome(async (appId, teammateId, user) => {
    const tm = await getTeammate(teammateId);
    return tm ? [...(await homeExtra(appId, teammateId, user)), ...(await homeBlocks(appId, tm, user))].slice(0, 100) : [];
  }));
}

// On Peeblo's home: the viewer's hires still waiting for "Add to Slack" (an admin sees every one).
async function homeExtra(appId: string, teammateId: string, user: string): Promise<any[]> {
  const tm = await getTeammate(teammateId);
  if (tm?.slug !== "peeblo") return [];
  const viewer = await personForSlack(String((await getApp(appId))?.team_id ?? ""), user);
  const { isOtariAdmin } = await import("../authority.ts");
  const { waitingInstalls } = await import("./install.ts");
  const w = await waitingInstalls(viewer.id, isOtariAdmin(viewer)).catch(() => []);
  return w.length ? [...w, { type: "divider" }] : [];
}

// Memory on the profile page: counts, and unverified notes the owner can verify with one click.
export async function memoryBlocks(tm: any, viewer: string): Promise<any[]> {
  const { notesIn } = await import("../memory/store.ts");
  const { readdirSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { config } = await import("../config.ts");
  const dir = join(config.dataDir, "teammates", tm.slug, "memory");
  // Only what the viewer may see: the team's notes and their own DM's (never another person's DM or a private
  // channel's, even as a title or a count).
  const banks = existsSync(dir) ? readdirSync(dir).filter((b) => b === "ws" || b === `dm-${viewer}`) : [];
  const notes = notesIn(tm.slug, banks).filter((n) => n.bank !== "company");
  const unverified = notes.filter((n) => !n.verified).slice(0, 5);
  return [
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: `*Memory*\n${notes.length} notes (${notes.length - notes.filter((n) => !n.verified).length} verified)` } },
    ...unverified.map((n) => ({ type: "section", text: { type: "mrkdwn", text: `_unverified_ · ${n.title}`.slice(0, 2900) }, accessory: { type: "button", text: { type: "plain_text", text: "Verify" }, action_id: "verify_note", value: `${tm.slug}|${n.bank}|${n.path}`.slice(0, 2000) } })),
  ];
}
