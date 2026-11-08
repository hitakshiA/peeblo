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
  approve_once: { decision: "approved", scope: "once" }, approve_job: { decision: "approved", scope: "job" },
  approve_always: { decision: "approved", scope: "always" }, deny: { decision: "denied", scope: "once" },
};

async function respond(url: string | undefined, body: Record<string, unknown>): Promise<void> {
  if (url) await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
}

async function feedbackNote(sessionId: string, runId: string, vote: string, by: string): Promise<void> {
  const { getSession } = await import("../store/sessions.ts");
  const { placeOfSession, writeNote } = await import("../memory/store.ts");
  const s = await getSession(sessionId);
  const tm = s ? await getTeammate(s.teammate_id) : null;
  if (!s || !tm) return;
  const asked = (await pool.query("SELECT left(sub.text, 300) AS t FROM runs r JOIN submissions sub ON sub.id = r.submission_id WHERE r.id = $1", [runId])).rows[0]?.t ?? "";
  const answer = (await pool.query("SELECT left(data->>'text', 500) AS t FROM events WHERE run_id = $1 AND type IN ('slack.post', 'turn.finished') ORDER BY id DESC LIMIT 1", [runId])).rows[0]?.t ?? "";
  await writeNote(tm.slug, placeOfSession(s), { path: `feedback/${runId}`, title: `${by} marked a reply ${vote === "up" ? "helpful" : "not helpful"}`, body: `Asked: ${asked}\n\nReply: ${answer}`, source: `${by}, Slack feedback`, runId, tainted: true });
}

export function installSlackInteractions(): void {
  onSlackInteraction(async ({ appId, payload }) => {
    if (payload.type !== "block_actions") return;
    const a = payload.actions?.[0];
    if (!a) return;
    const team = payload.team?.id ?? payload.user?.team_id;
    const who = await personForSlack(team, payload.user.id, { displayName: (await displayName(appId, payload.user.id)) ?? undefined });
    if (a.action_id in SCOPES) {
      const { decision, scope } = SCOPES[a.action_id];
      const r = await answerApproval(String(a.value), { decision, scope, personId: who.id });
      const name = who.display_name ?? `<@${payload.user.id}>`;
      const text = r.ok ? `${decision === "approved" ? `✅ Approved (${scope === "once" ? "once" : scope === "job" ? "for this job" : "always"})` : "✋ Declined"} by ${name}`
        : r.status === "not_allowed" ? `Only the teammate's owner can answer this one, ${name}. It's still waiting.`
        : `This request is ${r.status.replace("_", " ")}; nothing changed.`;
      if (r.ok || r.status !== "not_allowed") {
        const header = payload.message?.blocks?.[0];
        await respond(payload.response_url, { replace_original: true, text, blocks: [...(header ? [header] : []), { type: "context", elements: [{ type: "mrkdwn", text }] }] });
      } else await respond(payload.response_url, { response_type: "ephemeral", replace_original: false, text });
      return;
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
      // 👍/👎 become memory candidates (unverified until the owner verifies them).
      if (run) await feedbackNote(run.session_id, runId, vote, who.display_name ?? payload.user.id).catch(() => null);
      await respond(payload.response_url, { response_type: "ephemeral", replace_original: false, text: vote === "up" ? "Thanks, noted." : "Thanks, noted. I'll stay quiet in this thread unless someone asks me." });
    }
  });

  onSlackEvent(async ({ appId, teammateId, event }) => {
    if (event.type !== "app_home_opened" || event.tab !== "home" || !teammateId) return;
    const tm = await getTeammate(teammateId);
    if (!tm) return;
    const spend = await teammateSpend(tm).catch(() => null);
    const jobs = (await pool.query(
      `SELECT r.id, r.status, r.created_at, left(s2.text, 80) AS asked FROM runs r JOIN sessions s ON s.id = r.session_id JOIN submissions s2 ON s2.id = r.submission_id
        WHERE s.teammate_id = $1 ORDER BY r.created_at DESC LIMIT 5`, [tm.id])).rows;
    const c = tm.config;
    // On Peeblo's home: the viewer's hires still waiting for "Add to Slack" (an admin sees every one).
    let waiting: any[] = [];
    if (tm.slug === "peeblo") {
      const viewer = await personForSlack(String((await getApp(appId))?.team_id ?? ""), event.user);
      const { isOtariAdmin } = await import("../authority.ts");
      const { waitingInstalls } = await import("./install.ts");
      waiting = await waitingInstalls(viewer.id, isOtariAdmin(viewer)).catch(() => []);
    }
    const blocks: any[] = [
      ...waiting, ...(waiting.length ? [{ type: "divider" }] : []),
      { type: "header", text: { type: "plain_text", text: `${c.name} · ${c.role}`.slice(0, 150) } },
      { type: "section", fields: [
        { type: "mrkdwn", text: `*Model*\n${c.model.default}${c.model.fallback ? `\nfallback ${c.model.fallback}` : ""}` },
        { type: "mrkdwn", text: `*Budget*\n${spend ? `${usd(spend.spent)} of ${usd(spend.cap)} this month` : `${usd(c.budget.monthly_usd)} a month`}` },
        { type: "mrkdwn", text: `*Approvals*\n${c.mode} mode` },
        { type: "mrkdwn", text: `*Tools*\n${[...c.tools, ...c.connectors].join(", ") || "none"}` },
        { type: "mrkdwn", text: `*Computer*\n${c.computer?.size ?? "small"}` },
        { type: "mrkdwn", text: `*Owner*\n${tm.owner_person ? "set" : "none yet"}` },
      ] },
      ...(c.instructions ? [{ type: "section", text: { type: "mrkdwn", text: `*Standing instructions*\n${c.instructions.slice(0, 1500)}` } }] : []),
      { type: "divider" },
      { type: "section", text: { type: "mrkdwn", text: `*Recent jobs*\n${jobs.map((j) => `• ${j.status === "done" ? "✅" : j.status === "failed" ? "⚠️" : "⏳"} ${String(j.asked).replace(/\n/g, " ")}`).join("\n") || "none yet"}` } },
      ...(await memoryBlocks(tm, event.user)),
      { type: "context", elements: [{ type: "mrkdwn", text: `Version ${tm.version} · every reply is signed with its model, cost and receipt` }] },
    ];
    await slack(appId, "views.publish", { user_id: event.user, view: { type: "home", blocks } });
  });
}

// Memory on the profile page: counts, and unverified notes the owner can verify with one click.
async function memoryBlocks(tm: any, viewer: string): Promise<any[]> {
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
