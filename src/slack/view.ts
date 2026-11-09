// The Slack view of a run: a function of its events (the event log stays the source of truth). It follows the
// landing page (SLACK_UX_SPEC §5), all in one message:
//   steps in words ("Read Linear → 3 issues", with numbered source chips) under "Working on it · step 2 of 3";
//   a write's approval card inline under its step, collapsing in place to "✓ Approved by Maya · 4:31 PM";
//   the answer; the receipt chip; a Receipt button (opens the receipt modal); 👍 👎. Nothing after that.
// The message starts as a Slack stream on the first tool call (a plain reply is one message, no stream). Slack
// can't put buttons inside a live stream, so at the first approval the stream stops with the card attached and the
// message is redrawn with chat.update from then on (the stopped stream is a plan block, which chat.update accepts).
// Approval cards come from the harness, never from the model's prose (K15). The server checks who clicked.
import { config } from "../config.ts";
import { pool } from "../db.ts";
import { buildReceipt } from "../receipts.ts";
import { appendEvent, onEvent, type EventRow } from "../store/events.ts";
import { getSession } from "../store/sessions.ts";
import { getTeammate } from "../store/teammates.ts";
import { react, slack, unreact } from "./api.ts";
import type { SlackPlace } from "./inbound.ts";
import { receiptChip, stepOutput, stepTitle, summaryLine } from "./look.ts";

type Task = { title: string; status: "pending" | "in_progress" | "complete" | "error"; output?: string; sources?: { url: string; text: string }[] };
type Approval = { id: string; blocks: any[]; done?: any[] };
type View = {
  place: SlackPlace; teammate: string; slug: string; streamTs: string | null; startedAt: number; posted: number;
  tasks: Map<string, Task>; byTitle: Map<string, string>; queue: Promise<unknown>; failedStream: boolean;
  held?: string; heldTs?: string; heldText?: string; stoppedBy?: string; runId?: string; sessionId?: string | null; ready?: Promise<void>; frozen?: boolean; text: string; approvals: Approval[]; done: string[]; finished?: boolean; displays: any[]; privateOnly?: boolean;
};

// The model sometimes writes Slack's <url|text> links or code ticks around a site name; markdown blocks want neither.
const slackLinks = (t: string) => t.replace(/<(https?:[^|>\s]+)\|([^>]+)>/g, "[$2]($1)").replace(/<(https?:[^>\s]+)>/g, "$1").replace(/`([a-z0-9-]+(\.[a-z0-9-]+)+)`/gi, "$1");
const hostOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u.slice(0, 40); } };
// A source's link text names the thing, not the site: "GRO-327 · Eval check", "acme/web#212", else the page.
export const sourceText = (u: string): string => {
  try {
    const url = new URL(u);
    const issue = /\/issue\/([A-Z][A-Z0-9]*-\d+)(?:\/([^/?#]+))?/.exec(url.pathname);
    if (issue) return issue[2] ? `${issue[1]} · ${decodeURIComponent(issue[2]).replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase())}`.slice(0, 80) : issue[1];
    const gh = /^\/([^/]+)\/([^/]+)\/(?:pull|issues)\/(\d+)/.exec(url.pathname);
    if (url.hostname.endsWith("github.com") && gh) return `${gh[1]}/${gh[2]}#${gh[3]}`;
    const last = url.pathname.split("/").filter(Boolean).pop();
    return last ? `${hostOf(u)} · ${decodeURIComponent(last).replace(/[-_]/g, " ").slice(0, 50)}` : hostOf(u);
  } catch { return u.slice(0, 40); }
};

// The agent session's status (Slack's agent model): processing while it works (with the native Stop), active after.
async function sessionStatus(v: View, status: "processing" | "active" | "suspended", title?: string): Promise<void> {
  await slack(v.place.app_id, "agents.sessions.setStatus", { channel_id: v.place.channel, thread_ts: v.place.thread_ts, status, ...(title ? { title: title.slice(0, 200) } : {}) }).catch(() => null);
}
const views = new Map<string, View>();
const HANDOVER_MS = 9 * 60_000;

async function placeOf(sessionId: string | null): Promise<SlackPlace | null> {
  if (!sessionId) return null;
  const s = await getSession(sessionId);
  return ((s?.place as any)?.slack as SlackPlace) ?? null;
}

const enqueue = (v: View, f: () => Promise<unknown>) => { v.queue = v.queue.then(f).catch((e) => console.error("slack view:", (e as Error).message)); return v.queue; };
const newView = (place: SlackPlace, name: string, slug: string, failedStream: boolean): View =>
  ({ place, teammate: name, slug, streamTs: null, startedAt: Date.now(), posted: 0, tasks: new Map(), byTitle: new Map(), queue: Promise.resolve(), failedStream, text: "", approvals: [], done: [], displays: [] });

async function start(runId: string, place: SlackPlace, teammateId: string): Promise<View> {
  const tm = await getTeammate(teammateId);
  // A run nobody asked for shows nothing unless it posts.
  const quiet = !place.direct;
  const v = newView(place, tm?.config.name ?? "teammate", tm?.slug ?? "", quiet);
  views.set(runId, v); v.runId = runId;
  if (!quiet) await enqueue(v, async () => {
    await react(place.app_id, place.channel, place.trigger_ts, "eyes");
    // The session title is what the person asked; a welcome or a schedule has no person's words, so its name.
    const sub = (await pool.query("SELECT left(sub.text, 200) AS t, sub.source FROM runs r JOIN submissions sub ON sub.id = r.submission_id WHERE r.id = $1", [runId])).rows[0];
    const asked = ["slack", "api"].includes(sub?.source) ? sub.t ?? "" : sub?.source === "welcome" ? `Welcome from ${v.teammate}` : "";
    await sessionStatus(v, "processing", String(asked).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() || `${v.teammate} is working`);
  });
  return v;
}

// A plain message in the thread, from the teammate's own app.
async function post(v: View, text: string, blocks?: any[]): Promise<any> {
  return slack(v.place.app_id, "chat.postMessage", { channel: v.place.channel, thread_ts: v.place.thread_ts, text, ...(blocks ? { blocks } : {}), mrkdwn: true });
}

const planTitle = (v: View): string => {
  const list = [...v.tasks.values()];
  const n = list.length;
  const k = list.findIndex((t) => t.status !== "complete" && t.status !== "error");
  return `Working on it · step ${k === -1 ? n : k + 1} of ${Math.max(n, 1)}`;
};
const rich = (t: string) => ({ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: t }] }] });
function planBlock(v: View, title: string): any {
  return { type: "plan", title: title.slice(0, 120), tasks: [...v.tasks.entries()].map(([id, t]) => ({
    task_id: id, title: t.title.slice(0, 120), status: t.status, ...(t.output ? { output: rich(t.output.slice(0, 200)) } : {}), ...(t.sources?.length ? { sources: t.sources.map((s) => ({ type: "url", url: s.url, text: s.text })) } : {}),
  })) };
}

async function openStream(v: View): Promise<void> {
  try {
    const s = await slack(v.place.app_id, "chat.startStream", {
      channel: v.place.channel, thread_ts: v.place.thread_ts, recipient_team_id: v.place.team, recipient_user_id: v.place.user, task_display_mode: "plan",
      chunks: [{ type: "plan_update", title: "Working on it" }],
    });
    v.streamTs = s.ts; v.startedAt = Date.now();
    if (v.runId) await appendEvent({ sessionId: v.sessionId ?? null, runId: v.runId, type: "slack.stream", data: { ts: s.ts, channel: v.place.channel } }).catch(() => {});
  } catch {
    v.failedStream = true; // some channels refuse streams; post plain messages instead
  }
}

// After the first approval the message is redrawn whole: the plan, the cards, the answer, and at the end the receipt.
async function redraw(v: View, title: string, tail: any[] = []): Promise<void> {
  if (!v.streamTs) return;
  const blocks = [planBlock(v, title), ...v.approvals.flatMap((a) => a.done ?? a.blocks), ...(v.text.trim() ? [{ type: "markdown", text: v.text.slice(0, 11_000) }] : []), ...tail];
  await slack(v.place.app_id, "chat.update", { channel: v.place.channel, ts: v.streamTs, text: v.text.slice(0, 3000) || title, blocks }).catch((e) => console.error("slack view: redraw:", (e as Error).message));
}

// Text posted before any tool runs waits here, so a plain reply goes out once, with its receipt.
async function flushHeld(v: View): Promise<void> {
  if (v.heldTs) { v.held = undefined; return; } // already on screen
  if (!v.held) return;
  const text = v.held; v.held = undefined;
  await post(v, text, [{ type: "markdown", text }]);
}

async function chunks(v: View, c: any[]): Promise<void> {
  if (v.frozen) return redraw(v, planTitle(v));
  if (!v.streamTs && !v.failedStream) {
    if (c.every((x) => x.type === "markdown_text")) {
      v.held = c.map((x) => x.text).join("");
      // Shown at once; the receipt joins this message at the end (or it becomes the stream's opening text).
      const r: any = v.heldTs
        ? await slack(v.place.app_id, "chat.update", { channel: v.place.channel, ts: v.heldTs, text: v.held, blocks: [{ type: "markdown", text: v.held }] }).catch(() => null)
        : await post(v, v.held, [{ type: "markdown", text: v.held }]).catch(() => null);
      if (r?.ts && !v.heldTs) v.heldTs = r.ts;
      if (v.heldTs) v.heldText = v.held;
      return;
    }
    await openStream(v);
    // Text already shown on its own stays there; the stream carries on below it.
    if (v.heldTs) v.held = undefined;
    else if (v.held && v.streamTs && !v.failedStream) v.held = undefined; // the latest post goes in at the end
    else await flushHeld(v);
  }
  if (v.failedStream || !v.streamTs) {
    // No stream here (some channels refuse them): one plain message, edited in place, that the receipt joins at the end.
    const text = c.filter((x) => x.type === "markdown_text").map((x) => x.text).join("");
    if (!text.trim()) return;
    v.held = text;
    if (v.heldTs) await slack(v.place.app_id, "chat.update", { channel: v.place.channel, ts: v.heldTs, text, blocks: [{ type: "markdown", text }] }).catch(() => null);
    else { const r: any = await post(v, text, [{ type: "markdown", text }]).catch(() => null); if (r?.ts) v.heldTs = r.ts; }
    v.heldText = text;
    return;
  }
  if (Date.now() - v.startedAt > HANDOVER_MS) {
    await slack(v.place.app_id, "chat.stopStream", { channel: v.place.channel, ts: v.streamTs, chunks: [{ type: "markdown_text", text: "\n_(continued below)_" }] }).catch(() => null);
    v.tasks.clear(); v.byTitle.clear();
    await openStream(v);
  }
  await slack(v.place.app_id, "chat.appendStream", { channel: v.place.channel, ts: v.streamTs, chunks: c }).catch(async () => {
    v.failedStream = true;
    await chunks(v, c);
  });
}

// A step: one task in the plan. Repeated reads of the same service are one step (its latest result shows).
function step(v: View, callId: string, title: string, status: Task["status"], output: string | undefined, sources: string[], group: boolean) {
  const id = (group && v.byTitle.get(title)) || callId;
  if (group) v.byTitle.set(title, id);
  const prev = v.tasks.get(id);
  const src = [...(prev?.sources ?? []), ...sources.slice(0, 10).map((u) => ({ url: u, text: sourceText(u) }))].filter((s, i, a) => a.findIndex((x) => x.url === s.url) === i).slice(0, 10);
  // A step keeps its first result; a grouped repeat adds only its new sources (Slack appends a task's output and
  // sources within a stream rather than replacing them).
  const t: Task = { title, status, output: prev?.output ?? output, sources: src };
  v.tasks.set(id, t);
  if (status === "complete" && output !== "not now") v.done.push(title);
  const fresh = src.filter((s) => !(prev?.sources ?? []).some((x) => x.url === s.url));
  const newOutput = !prev?.output && output ? output : undefined;
  return chunks(v, [
    { type: "task_update", id, title: title.slice(0, 120), status, ...(newOutput ? { output: newOutput.slice(0, 200) } : {}), ...(fresh.length ? { sources: fresh.map((s) => ({ type: "url", text: s.text, url: s.url })) } : {}) },
    { type: "plan_update", title: planTitle(v) },
  ]);
}

// The end of the message: the receipt chip, the Receipt button, then 👍 👎 (Slack's icon_button takes only a trash
// icon, so the Receipt button is a small button on its own row, just above the feedback row).
async function ending(runId: string, ok: boolean): Promise<any[]> {
  const r = await buildReceipt(runId, { links: false }).catch(() => null);
  return [
    ...(ok ? [] : [{ type: "actions", block_id: `recover:${runId}`, elements: [
      { type: "button", style: "primary", text: { type: "plain_text", text: "Try again" }, action_id: "retry_run", value: runId },
      { type: "button", text: { type: "plain_text", text: "Ask the owner" }, action_id: "ask_owner", value: runId },
    ] }]),
    receiptChip(r),
    ...(r && r.calls ? [{ type: "actions", block_id: `receipt:${runId}`, elements: [{ type: "button", text: { type: "plain_text", text: "Receipt" }, action_id: "open_receipt", value: runId }] }] : []),
    { type: "context_actions", elements: [{ type: "feedback_buttons", action_id: `feedback:${runId}`, positive_button: { text: { type: "plain_text", text: "Good" }, value: `up:${runId}` }, negative_button: { text: { type: "plain_text", text: "Bad" }, value: `down:${runId}` } }] },
  ];
}

async function finish(runId: string, v: View, ok: boolean, fallbackText: string | null): Promise<void> {
  await enqueue(v, async () => {
    v.finished = true;
    // Tables, charts and KPI strips (show_data) sit under the answer, before the receipt; at most 2 charts.
    let charts = 0;
    const shown = v.displays.filter((b) => b.type !== "data_visualization" || ++charts <= 2);
    const blocks = [...shown, ...(await ending(runId, ok)).filter((b: any) => !v.stoppedBy || (b.type !== "context_actions" && !String(b.block_id ?? "").startsWith("recover:")))];
    // A card still waiting when the answer is done isn't needed any more: it collapses and the approval expires.
    for (const a of v.approvals.filter((x) => !x.done)) {
      a.done = [{ type: "context", elements: [{ type: "mrkdwn", text: "Not needed" }] }];
      const { expireApproval } = await import("../durable/approvals.ts");
      await expireApproval(a.id).catch(() => null);
    }
    // Open steps close with the run; the plan folds into one line made from the step verbs.
    // A run that answered shows no warning: a step that failed on the way was retried or worked around.
    for (const t of v.tasks.values()) if (t.status === "in_progress" || t.status === "pending" || (ok && t.status === "error")) t.status = ok ? "complete" : "error";
    const declined = v.approvals.some((x) => x.done && JSON.stringify(x.done).includes("Not now"));
    const summary = v.stoppedBy ? `Stopped by ${v.stoppedBy}` : summaryLine(v.done) || (declined ? "Not now · nothing changed" : ok ? "Done" : "Stopped");
    if (v.stoppedBy) fallbackText = `${fallbackText ? `${fallbackText}\n\n` : v.heldText ? `${v.heldText}\n\n` : ""}_Stopped by ${v.stoppedBy}._`;
    if (v.held) { fallbackText = `${v.held}${fallbackText ? `\n\n${fallbackText}` : ""}`; v.held = undefined; }
    // The message already on screen keeps its text when the receipt joins it (an alert from a trigger, a schedule).
    else if (v.heldTs && v.heldText && !fallbackText) fallbackText = v.heldText;
    // The reply is already on screen: add the receipt to that message instead of posting a second one.
    if (v.heldTs && !v.frozen && !(v.streamTs && !v.failedStream)) { // the answer is on screen: the receipt joins it
      await slack(v.place.app_id, "chat.update", { channel: v.place.channel, ts: v.heldTs, text: fallbackText ?? summary, blocks: [...(fallbackText ? [{ type: "markdown", text: fallbackText }] : []), ...blocks] }).catch(() => null);
      if (v.place.direct) { await unreact(v.place.app_id, v.place.channel, v.place.trigger_ts, "eyes"); await react(v.place.app_id, v.place.channel, v.place.trigger_ts, ok ? "white_check_mark" : "warning"); await sessionStatus(v, "active"); }
      return;
    }
    if (v.frozen) {
      if (fallbackText) v.text = `${v.text}${v.text ? "\n\n" : ""}${fallbackText}`;
      await redraw(v, summary, blocks);
    } else if (v.streamTs && !v.failedStream) {
      const open = [...v.tasks.entries()].map(([id, t]) => ({ type: "task_update", id, title: t.title.slice(0, 120), status: t.status }));
      const finalText = v.text || fallbackText || "";
      const tail = finalText ? [{ type: "markdown_text", text: finalText }] : [];
      await slack(v.place.app_id, "chat.stopStream", { channel: v.place.channel, ts: v.streamTs, chunks: [{ type: "plan_update", title: summary.slice(0, 120) }, ...open, ...tail], blocks }).catch(async (e) => {
        // The stream couldn't be closed: the answer goes out as its own message, with its text, never just "Done".
        console.error("slack view: stopStream:", (e as Error).message);
        await post(v, finalText || summary, [...(finalText ? [{ type: "markdown", text: finalText.slice(0, 11_000) }] : []), ...blocks]);
      });
    } else if (v.privateOnly && !v.posted) {
      // Answered privately: the receipt goes to the asker privately too.
      await slack(v.place.app_id, "chat.postEphemeral", { channel: v.place.channel, user: v.place.user, thread_ts: v.place.channel_type === "im" ? undefined : v.place.thread_ts, text: "Receipt", blocks: blocks.filter((b) => b.type !== "context_actions") }).catch(() => null);
    } else if (v.place.direct || v.posted || fallbackText) {
      // What it posted is the message's text; the status line is only for a run that said nothing.
      const said = fallbackText ?? (v.text.trim() ? v.text : null);
      await post(v, said ?? summary, [...(said ? [{ type: "markdown", text: said.slice(0, 11_000) }] : []), ...blocks]);
    }
    if (v.place.direct) {
      await unreact(v.place.app_id, v.place.channel, v.place.trigger_ts, "eyes");
      await react(v.place.app_id, v.place.channel, v.place.trigger_ts, ok ? "white_check_mark" : "warning");
      await sessionStatus(v, "active");
    }
  });
  views.delete(runId);
}

// The teammate's monthly budget is used up (SLACK_UX_SPEC §3.6): a card with a way to ask its owner for more.
async function budgetCard(v: View, d: any): Promise<void> {
  await flushHeld(v);
  const tm = await getTeammate(v.slug);
  if (!tm) return;
  const owner = tm.owner_person ? (await pool.query("SELECT slack_user, display_name FROM people WHERE id = $1", [tm.owner_person])).rows[0] : null;
  const { teammateSpend, usd } = await import("../otari/spend.ts");
  const s = await teammateSpend(tm).catch(() => null);
  const spent = s?.spent ?? Number(d.spent ?? 0);
  const first = (owner?.display_name ?? "the owner").split(" ")[0];
  const ownerName = first === "the" ? "the owner" : first.charAt(0).toUpperCase() + first.slice(1);
  await slack(v.place.app_id, "chat.postMessage", { channel: v.place.channel, thread_ts: v.place.thread_ts, text: `${tm.config.name} has used its budget for this month.`, blocks: [
    { type: "section", text: { type: "mrkdwn", text: `*${tm.config.name} has used ${usd(spent)} of ${usd(tm.config.budget.monthly_usd)} this month*, so it stopped before going over.` } },
    { type: "actions", elements: [{ type: "button", style: "primary", text: { type: "plain_text", text: `Ask ${ownerName} for more` }, action_id: "ask_budget", value: tm.slug }] },
  ] }).catch(() => null);
}

// The approval card, inline under its step: icon, "Okay to write to Linear?", one quiet line, Approve / Not now.
async function approvalCard(v: View, e: EventRow): Promise<void> {
  const a = (e.data as any).action ?? {};
  const id = (e.data as any).approval_id as string;
  const { cardBlocks, question } = await import("./approval-card.ts");
  const askedBy = (await pool.query("SELECT sub.person_id FROM runs r JOIN submissions sub ON sub.id = r.submission_id WHERE r.id = $1", [e.run_id])).rows[0]?.person_id;
  const blocks = await cardBlocks(a, id, v.teammate, askedBy);
  let where: { channel: string; ts: string; inline: boolean } | null = null;
  if (v.streamTs && !v.failedStream) {
    // The first card stops the stream with the card attached; later redraws keep it in the same message.
    v.approvals.push({ id, blocks });
    if (!v.frozen) {
      v.frozen = true;
      await slack(v.place.app_id, "chat.stopStream", { channel: v.place.channel, ts: v.streamTs, chunks: [{ type: "plan_update", title: planTitle(v) }], blocks }).catch(() => null);
    }
    await redraw(v, planTitle(v)); // a stopped stream marks running steps as failed; redraw them as still running
    where = { channel: v.place.channel, ts: v.streamTs, inline: true };
  } else {
    await flushHeld(v);
    const posted: any = await post(v, question(a, v.teammate), blocks).catch(() => null);
    if (posted?.ts) where = { channel: posted.channel ?? v.place.channel, ts: posted.ts, inline: false };
  }
  // Where the card is, so a hire can add its install button and the outcome can collapse it.
  if (where) await appendEvent({ sessionId: e.session_id, runId: e.run_id, type: "approval.card", data: { approval_id: id, app_id: v.place.app_id, channel: where.channel, ts: where.ts, inline: where.inline, image: a.id_card_url ?? null, hero: a.id_card_hero ?? null } });
  // Waiting on a person: the session is suspended. An approver who isn't the asker gets the card in a DM too.
  await sessionStatus(v, "suspended");
  const others = (a.approvers ?? []).filter((p: string) => p !== askedBy);
  if (others.length) {
    const link: any = where ? await slack(v.place.app_id, "chat.getPermalink", { channel: where.channel, message_ts: where.ts }).catch(() => null) : null;
    for (const p of (await pool.query("SELECT slack_user FROM people WHERE id = ANY($1) AND slack_user IS NOT NULL", [others])).rows) {
      const dm: any = await slack(v.place.app_id, "conversations.open", { users: p.slack_user }).catch(() => null);
      if (dm?.channel?.id) await slack(v.place.app_id, "chat.postMessage", { channel: dm.channel.id, text: question(a, v.teammate), blocks: [
        { type: "context", elements: [{ type: "mrkdwn", text: `You're asked to decide${link?.permalink ? ` (<${link.permalink}|the thread>)` : ""}.` }] }, ...blocks] }).catch(() => null);
    }
  }
}

// The outcome, in place of the card: "✓ Approved by Maya · 4:31 PM", "Not now · Maya", or "Expired" with Ask again.
async function outcomeBlocks(d: any, runId: string | null): Promise<any[]> {
  const who = d.by ? (await pool.query("SELECT display_name FROM people WHERE id = $1", [d.by])).rows[0]?.display_name : null;
  const name = who ? String(who).split(" ")[0] : "someone";
  const now = Math.floor(Date.now() / 1000);
  const at = `<!date^${now}^{time}|just now>`;
  if (d.status === "approved") {
    const approved = { type: "context", elements: [{ type: "mrkdwn", text: `✓ Approved by ${name}${d.edited ? " (edited)" : ""} · ${at}` }] };
    // One quiet offer to make it standing, only when the approver is the teammate's owner (or an admin).
    const row = (await pool.query("SELECT action FROM approvals WHERE id = $1", [d.approval_id])).rows[0];
    const { alwaysPhrase } = await import("./approval-card.ts");
    const phrase = row ? alwaysPhrase(row.action) : null;
    const tm = row ? await getTeammate(row.action.teammate) : null;
    const person = d.by ? (await pool.query("SELECT * FROM people WHERE id = $1", [d.by])).rows[0] : null;
    const { mayManageTeammate } = await import("../authority.ts");
    if (!phrase || !tm || !person || !mayManageTeammate(tm, person)) return [approved];
    return [approved, { type: "actions", block_id: `always:${d.approval_id}`, elements: [{ type: "button", text: { type: "plain_text", text: phrase.replace(/\?$/, "") }, action_id: "always_allow", value: d.approval_id }] }];
  }
  if (d.status === "denied" && d.superseded) return [{ type: "context", elements: [{ type: "mrkdwn", text: `Replaced by an updated draft · ${name}'s note` }] }];
  if (d.status === "denied") return [{ type: "context", elements: [{ type: "mrkdwn", text: `Not now · ${name}${d.reason ? `: “${String(d.reason).slice(0, 200)}”` : ""}` }] }];
  return [{ type: "section", text: { type: "mrkdwn", text: "*Expired.* Nobody answered in time, so nothing ran." } },
    ...(runId ? [{ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Ask again" }, action_id: "ask_again", value: d.approval_id ?? runId }] }] : [])];
}

async function approvalResolved(v: View | undefined, e: EventRow): Promise<void> {
  const d = e.data as any;
  const done = await outcomeBlocks(d, e.run_id);
  const inline = v?.approvals.find((a) => a.id === d.approval_id);
  if (v && inline) {
    inline.done = done;
    await redraw(v, v.finished ? summaryLine(v.done) || "Done" : planTitle(v));
  } else {
    const c = (await pool.query("SELECT data FROM events WHERE type = 'approval.card' AND data->>'approval_id' = $1 LIMIT 1", [d.approval_id])).rows[0]?.data;
    const words = d.status === "approved" ? "Approved" : d.status === "denied" ? (d.superseded ? "Replaced by an updated draft" : "Not now") : "Expired. Nothing ran.";
    if (c && !c.inline) await slack(c.app_id, "chat.update", { channel: c.channel, ts: c.ts, text: words, blocks: done }).catch(() => null);
  }
  if (v && d.status !== "expired") await sessionStatus(v, "processing");
}

// After a core restart the in-memory view is gone. If the run's message already holds an inline approval card, the
// view is rebuilt from the event log (steps, cards and their outcomes, posted text, displays) so the rest of the run
// keeps redrawing that one message instead of starting a second one.
const plain = new Set<string>(); // runs checked after a restart that have no inline card to rebuild

// A view made after a restart (or late) takes over the stream the run already opened, so the answer lands in
// that message and no "Working on it" placeholder is left open beside it.
async function adoptStream(v: View, runId: string): Promise<void> {
  const row = (await pool.query("SELECT data->>'ts' AS ts FROM events WHERE run_id = $1 AND type = 'slack.stream' ORDER BY id DESC LIMIT 1", [runId])).rows[0];
  if (!row?.ts) return;
  await slack(v.place.app_id, "chat.stopStream", { channel: v.place.channel, ts: row.ts }).catch(() => null);
  v.streamTs = row.ts; v.frozen = true; v.failedStream = false;
}
async function revive(runId: string, sessionId: string | null): Promise<View | undefined> {
  const cards = (await pool.query("SELECT data FROM events WHERE run_id = $1 AND type = 'approval.card' AND (data->>'inline')::boolean ORDER BY id", [runId])).rows.map((r) => r.data);
  if (!cards.length) return undefined;
  const place = await placeOf(sessionId);
  if (!place) return undefined;
  const s = await getSession(sessionId!);
  const tm = await getTeammate(s!.teammate_id);
  const v = newView(place, tm?.config.name ?? "teammate", tm?.slug ?? "", false);
  v.streamTs = cards[0].ts; v.frozen = true;
  const { cardBlocks } = await import("./approval-card.ts");
  const askedBy = (await pool.query("SELECT sub.person_id FROM runs r JOIN submissions sub ON sub.id = r.submission_id WHERE r.id = $1", [runId])).rows[0]?.person_id;
  for (const e of (await pool.query("SELECT id, type, data FROM events WHERE run_id = $1 AND type IN ('tool.call', 'slack.post', 'slack.display', 'approval.requested', 'approval.resolved') ORDER BY id", [runId])).rows) {
    const d = e.data as any;
    if (e.type === "tool.call") {
      const title = stepTitle(d.tool, { command: d.command, kind: d.kind, callee: d.callee });
      if (!title) continue;
      const st: Task["status"] = d.status === "completed" || d.status === "denied" ? "complete" : ["failed", "refused", "expired", "invalid"].includes(d.status) ? "error" : "in_progress";
      const id = (d.kind === "read" && v.byTitle.get(title)) || String(d.id ?? e.id);
      if (d.kind === "read") v.byTitle.set(title, id);
      const prev = v.tasks.get(id);
      v.tasks.set(id, { title, status: st, output: prev?.output ?? (d.status === "waiting_approval" ? "waiting for approval" : st === "complete" ? stepOutput(d.tool, d.summary, Number(d.lines ?? 0)) : undefined), sources: prev?.sources ?? [] });
      if (st === "complete") v.done.push(title);
    } else if (e.type === "slack.post") { v.posted++; v.text += `${v.posted > 1 ? "\n\n" : ""}${d.text}`; }
    else if (e.type === "slack.display") v.displays.push(...(d.blocks ?? []));
    else if (e.type === "approval.requested" && cards.some((c) => c.approval_id === d.approval_id)) v.approvals.push({ id: d.approval_id, blocks: await cardBlocks(d.action ?? {}, d.approval_id, v.teammate, askedBy) });
    else if (e.type === "approval.resolved") { const a = v.approvals.find((x) => x.id === d.approval_id); if (a) a.done = await outcomeBlocks(d, runId); }
  }
  views.set(runId, v); v.runId = runId;
  return v;
}

export function installSlackView(): void {
  onEvent(async (e) => {
    if (!e.run_id) return;
    let v = views.get(e.run_id);
    if (v?.ready) await v.ready;
    if (e.type === "run.started") {
      const place = await placeOf(e.session_id);
      if (!place) return;
      const s = await getSession(e.session_id!);
      await start(e.run_id, place, s!.teammate_id);
      return;
    }
    // After a restart: a message with an inline card is rebuilt and keeps being redrawn in place.
    if (!v && e.type !== "run.started" && !plain.has(e.run_id)) { v = await revive(e.run_id, e.session_id); if (!v) plain.add(e.run_id); }
    if (!v && e.type === "approval.resolved") return void approvalResolved(undefined, e);
    // A run that began before a restart and now needs an approval: the card goes out as its own message.
    if (!v && e.type === "approval.requested") {
      const place = await placeOf(e.session_id);
      const s = place ? await getSession(e.session_id!) : null;
      const tm = s ? await getTeammate(s.teammate_id) : null;
      if (place) { v = newView(place, tm?.config.name ?? "teammate", tm?.slug ?? "", true); views.set(e.run_id, v); v.runId = e.run_id; v.sessionId = e.session_id; }
    }
    if (!v && (e.type === "run.finished" || e.type === "run.failed")) {
      // Core restarted mid-run: the stream is gone, so the reply and receipt go out as a plain message.
      const place = await placeOf(e.session_id);
      if (!place) return;
      const s = await getSession(e.session_id!);
      const tm = await getTeammate(s!.teammate_id);
      v = newView(place, tm?.config.name ?? "teammate", tm?.slug ?? "", true);
      views.set(e.run_id, v); v.runId = e.run_id; v.sessionId = e.session_id;
      v.ready = adoptStream(v, e.run_id); await v.ready;
      v.posted = Number((await pool.query("SELECT count(*)::int AS n FROM events WHERE run_id = $1 AND type = 'slack.post'", [e.run_id])).rows[0].n);
      // The reply it posted is the message's text (never just the status line): the latest public post.
      const last = (await pool.query("SELECT data->>'text' AS t FROM events WHERE run_id = $1 AND type = 'slack.post' AND coalesce((data->>'private')::boolean, false) = false ORDER BY id DESC LIMIT 1", [e.run_id])).rows[0]?.t;
      if (last) { v.text = slackLinks(String(last)); v.held = v.text; }
    }
    // No view yet when the run posts (a trigger or schedule run whose place was bound after it started, or a run
    // checked after a restart): make one now, so the post shows when it's made.
    if (!v && e.type === "slack.post" && !(e.data as any)?.private) {
      const place = await placeOf(e.session_id);
      if (place) {
        const s = await getSession(e.session_id!);
        const tm = s ? await getTeammate(s.teammate_id) : null;
        v = newView(place, tm?.config.name ?? "teammate", tm?.slug ?? "", true);
        views.set(e.run_id, v); v.runId = e.run_id; v.sessionId = e.session_id;
        plain.delete(e.run_id);
        v.ready = adoptStream(v, e.run_id); await v.ready;
      }
    }
    if (!v) return;
    const d = e.data as any;
    if (e.type === "plan.updated") {
      // The agent's own plan (3+ steps): its steps become the tasks.
      for (const [i, s] of (d.steps ?? []).entries()) {
        const st = s.status === "done" ? "complete" : s.status === "doing" ? "in_progress" : s.status === "dropped" ? "error" : "pending";
        void enqueue(v, () => step(v!, `plan-${i}`, String(s.step), st, undefined, [], false));
      }
    } else if (e.type === "tool.call") {
      const title = stepTitle(d.tool, { command: d.command, kind: d.kind, callee: d.callee });
      if (!title) return;
      const st = d.status === "completed" || d.status === "denied" ? "complete" : ["failed", "refused", "expired", "invalid"].includes(d.status) ? "error" : "in_progress";
      // A failed attempt that a later call fixes isn't news; it shows only as the step's state.
      const output = d.status === "waiting_approval" ? "waiting for approval" : d.status === "denied" ? "not now" : st === "complete" ? stepOutput(d.tool, d.summary, Number(d.lines ?? 0)) : undefined;
      const sources = [...(d.sources ?? []), ...(d.url ? [d.url] : [])].filter((u: any) => typeof u === "string" && /^https?:/.test(u));
      void enqueue(v, () => step(v!, String(d.id ?? e.id), title, st, output, sources, d.kind === "read"));
    } else if (e.type === "slack.post" && d.private) {
      v.privateOnly = true; // the reply went to the asker alone; nothing public follows for it
    } else if (e.type === "slack.post") {
      // One answer per message: a later post replaces the earlier one (a progress note, or a first try).
      v.posted++;
      v.text = slackLinks(String(d.text ?? ""));
      if (v.frozen) void enqueue(v, () => redraw(v!, planTitle(v!)));
      else if (!v.streamTs && !v.failedStream) void enqueue(v, () => chunks(v!, [{ type: "markdown_text", text: v!.text }]));
      // In a live stream the text can't be replaced, so it goes in when the run ends.
    } else if (e.type === "slack.display") {
      v.displays.push(...(d.blocks ?? []));
    } else if (e.type === "budget.blocked" && (d.scope === "teammate" || d.scope === "api_token" || d.scope === "key")) {
      void enqueue(v, () => budgetCard(v!, d));
    } else if (e.type === "approval.requested") {
      void enqueue(v, () => approvalCard(v!, e));
    } else if (e.type === "approval.resolved") {
      void enqueue(v, () => approvalResolved(v, e));
    } else if (e.type === "run.finished" || e.type === "run.failed") {
      // The reply is what the teammate posted. If a person asked it directly and it posted nothing, its final text
      // is the reply (a direct ask always gets an answer).
      let fallback: string | null = null;
      if (!v.posted && !v.privateOnly && v.place.direct) {
        const { rows } = await pool.query("SELECT data FROM events WHERE run_id = $1 AND type = 'turn.finished' ORDER BY id DESC LIMIT 1", [e.run_id]);
        // Clean final text: no thinking tags, and no "Peeblo:" style name prefix.
        const name = v.teammate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        fallback = String(rows[0]?.data?.text ?? "").replace(/<think(ing)?>[\s\S]*?<\/think(ing)?>/g, "").trim().replace(new RegExp(`^\\**${name}\\**\\s*:\\s*`, "i"), "").trim() || (e.type === "run.failed" ? `I hit a problem and stopped: ${String(d.error ?? "").slice(0, 300)}` : null);
      }
      // A run that ended on a typed stop (budget, a stuck loop, the guard, a model error) gets the recovery buttons.
      const stop = (await pool.query("SELECT data->>'stop_reason' AS r FROM events WHERE run_id = $1 AND type = 'turn.finished' ORDER BY id DESC LIMIT 1", [e.run_id])).rows[0]?.r;
      // A message folded into the work already waiting on a card: that work answers; this run shows nothing.
      if (stop === "merged") {
        views.delete(e.run_id);
        await unreact(v.place.app_id, v.place.channel, v.place.trigger_ts, "eyes").catch(() => null);
        return;
      }
      // Stopped by a person ("stop" in the thread): say who, and no feedback buttons on a job someone ended.
      const st = (await pool.query(`SELECT p.display_name FROM events x JOIN runs r ON r.id = $1 LEFT JOIN people p ON p.slack_user = x.data->>'user'
        WHERE x.session_id = r.session_id AND x.type = 'slack.stop' AND (x.data->>'stopped')::boolean AND x.at >= r.created_at ORDER BY x.id DESC LIMIT 1`, [e.run_id]).catch(() => ({ rows: [] as any[] }))).rows[0];
      if (st) v.stoppedBy = String(st.display_name ?? "someone").split(" ")[0];
      await finish(e.run_id, v, e.type === "run.finished" && !["budget_blocked", "stuck", "guard_unavailable", "error"].includes(stop ?? "") && !st, st ? null : fallback);
    }
  });
}

void config;
