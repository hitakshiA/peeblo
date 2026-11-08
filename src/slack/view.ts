// The Slack view of a run: a function of its events (the event log stays the source of truth).
// - 👀 on the message when work starts, ✅ (or ⚠️) when it ends;
// - a streamed reply in the thread: a plan whose task cards tick as tools run, the text the teammate chose to post
//   (slack_post), and at the end a signed receipt with 👍/👎 buttons;
// - approval cards come from the harness, never from the model's prose (K15): approve once / for this job / always,
//   or no. The server checks who clicked.
// A stream lasts at most ~10 minutes in Slack, so a long run hands over to a fresh message.
import { config } from "../config.ts";
import { pool } from "../db.ts";
import { buildReceipt, receiptLine } from "../receipts.ts";
import { appendEvent, onEvent, type EventRow } from "../store/events.ts";
import { getSession } from "../store/sessions.ts";
import { getTeammate } from "../store/teammates.ts";
import { react, slack, unreact } from "./api.ts";
import type { SlackPlace } from "./inbound.ts";

type View = { place: SlackPlace; teammate: string; slug: string; streamTs: string | null; startedAt: number; posted: number; tasks: Map<string, { title: string; status: string }>; queue: Promise<unknown>; failedStream: boolean; sources?: Map<string, string>; done?: string[]; held?: string };

// The connector's logo on its task card (SLACK_UX_SPEC §3.3), by its service's domain.
const DOMAINS: Record<string, string> = { linear: "linear.app", github: "github.com", posthog: "posthog.com", stripe: "stripe.com", hubspot: "hubspot.com", notion: "notion.so", sheets: "google.com", intercom: "intercom.com", freshdesk: "freshdesk.com", sentry: "sentry.io", supabase: "supabase.com", airtable: "airtable.com", atlassian: "atlassian.com", cloudflare: "cloudflare.com", pagerduty: "pagerduty.com", grafana: "grafana.com", web_search: "duckduckgo.com", web_fetch: "duckduckgo.com" };
const iconFor = (tool: string): any => {
  const d = DOMAINS[tool.split("__")[0]];
  return d ? { type: "icon", name: `https://www.google.com/s2/favicons?domain=${d}&sz=64` } : undefined;
};
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

const TOOL_TITLES: Record<string, (d: any) => string> = {
  computer_bash: (d) => `Ran \`${String(d.command ?? "a command").slice(0, 60)}\``,
  computer_read: () => "Read a file", computer_write: () => "Wrote a file", computer_edit: () => "Edited a file",
  browser_read: () => "Read a web page", browser_act: () => "Used a web page", web_fetch: () => "Read a web page",
  web_search: () => "Searched the web", code_execution: () => "Ran code", repo_open: () => "Opened the repo", repo_publish: () => "Published a branch",
  plan: () => "Updated the plan", subagent: () => "Asked a helper", ask_teammate: () => "Asked a teammate", delegate: () => "Handed off the job", teammate_hire: () => "Hired a teammate", recipe_propose: () => "Proposed a setup change",
  budget_status: () => "Checked the budget", models_list: () => "Looked up models", price_estimate: () => "Estimated a price", routing_recommend: () => "Picked a model",
};
const pretty = (tool: string, d: any) => {
  const f = TOOL_TITLES[tool];
  if (f) return f(d);
  const [server, action] = tool.split("__");
  return action ? `${action.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())} in ${server[0].toUpperCase()}${server.slice(1)}` : tool.replace(/_/g, " ");
};

async function placeOf(sessionId: string | null): Promise<SlackPlace | null> {
  if (!sessionId) return null;
  const s = await getSession(sessionId);
  return ((s?.place as any)?.slack as SlackPlace) ?? null;
}

const enqueue = (v: View, f: () => Promise<unknown>) => { v.queue = v.queue.then(f).catch((e) => console.error("slack view:", (e as Error).message)); return v.queue; };

async function start(runId: string, place: SlackPlace, teammateId: string): Promise<View> {
  const tm = await getTeammate(teammateId);
  // A teammate always speaks through its own app (the install rail stops one without it). A run nobody asked for
  // (Peeblo reading along) shows nothing unless it posts.
  const quiet = !place.direct;
  const v: View = { place, teammate: tm?.config.name ?? "teammate", slug: tm?.slug ?? "", streamTs: null, startedAt: Date.now(), posted: 0, tasks: new Map(), queue: Promise.resolve(), failedStream: quiet };
  views.set(runId, v);
  if (!quiet) await enqueue(v, async () => {
    await react(place.app_id, place.channel, place.trigger_ts, "eyes");
    // The session title is what the person asked; a welcome or a schedule has no person's words, so its name.
    const sub = (await pool.query("SELECT left(sub.text, 200) AS t, sub.source FROM runs r JOIN submissions sub ON sub.id = r.submission_id WHERE r.id = $1", [runId])).rows[0];
    const asked = ["slack", "api"].includes(sub?.source) ? sub.t ?? "" : sub?.source === "welcome" ? `Welcome from ${v.teammate}` : "";
    await sessionStatus(v, "processing", String(asked).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() || `${v.teammate} is working`);
    // The stream opens on the first tool call (NIGHT_PLAN_NOV9 §1): a reply with no tools is one plain message.
  });
  return v;
}
// A plain message in the thread, from the teammate's own app.
async function post(v: View, text: string, blocks?: any[]): Promise<void> {
  await slack(v.place.app_id, "chat.postMessage", { channel: v.place.channel, thread_ts: v.place.thread_ts, text, ...(blocks ? { blocks } : {}), mrkdwn: true });
}

async function openStream(v: View): Promise<void> {
  try {
    const s = await slack(v.place.app_id, "chat.startStream", {
      channel: v.place.channel, thread_ts: v.place.thread_ts, recipient_team_id: v.place.team, recipient_user_id: v.place.user, task_display_mode: "plan",
      chunks: [{ type: "plan_update", title: "Working on it" }],
    });
    v.streamTs = s.ts; v.startedAt = Date.now();
  } catch {
    v.failedStream = true; // some channels refuse streams; post plain messages instead
  }
}

// Text posted before any tool runs waits here, so a plain reply goes out once, with its receipt.
async function flushHeld(v: View): Promise<void> {
  if (!v.held) return;
  const text = v.held; v.held = undefined;
  await post(v, text, [{ type: "markdown", text }]);
}

async function chunks(v: View, c: any[]): Promise<void> {
  if (!v.streamTs && !v.failedStream) {
    if (c.every((x) => x.type === "markdown_text")) { v.held = `${v.held ?? ""}${c.map((x) => x.text).join("")}`; return; }
    await openStream(v);
    if (v.held && v.streamTs && !v.failedStream) { const text = v.held; v.held = undefined; c = [{ type: "markdown_text", text }, ...c]; }
    else await flushHeld(v);
  }
  if (v.failedStream || !v.streamTs) {
    const text = c.filter((x) => x.type === "markdown_text").map((x) => x.text).join("");
    if (text.trim()) await post(v, text);
    return;
  }
  if (Date.now() - v.startedAt > HANDOVER_MS) {
    await slack(v.place.app_id, "chat.stopStream", { channel: v.place.channel, ts: v.streamTs, chunks: [{ type: "markdown_text", text: "\n_(continued below)_" }] }).catch(() => null);
    await openStream(v);
  }
  await slack(v.place.app_id, "chat.appendStream", { channel: v.place.channel, ts: v.streamTs, chunks: c }).catch(async () => {
    v.failedStream = true;
    await chunks(v, c);
  });
}

function taskUpdate(v: View, id: string, title: string, status: "pending" | "in_progress" | "complete" | "error", output?: string, extra: { icon?: any; sources?: string[] } = {}) {
  v.tasks.set(id, { title, status });
  const sources = (extra.sources ?? []).slice(0, 10).map((u) => ({ type: "url", text: sourceText(u), url: u }));
  for (const x of sources) (v.sources ??= new Map()).set(x.url, x.text);
  // (Slack refuses an icon on task updates in every documented shape for now, so the service is in the title.)
  return chunks(v, [{ type: "task_update", id, title: title.slice(0, 120), status, ...(output ? { output: output.slice(0, 200) } : {}), ...(sources.length ? { sources } : {}) }]);
}
// The plan's title is the current step, in plain words (the status line under the composer can't carry text).
const planTitle = (v: View, title: string) => chunks(v, [{ type: "plan_update", title: title.slice(0, 120) }]);

async function finish(runId: string, v: View, ok: boolean, fallbackText: string | null): Promise<void> {
  await enqueue(v, async () => {
    const r = await buildReceipt(runId).catch(() => null);
    const budget = await personBudget(runId).catch(() => null);
    const line = r ? `${v.teammate} · ${receiptLine(r)}${budget ? ` · ${budget}` : ""}` : v.teammate;
    const link = r?.links?.session ? ` · <${r.links.session}|receipt>` : "";
    const srcs = [...(v.sources ?? new Map()).entries()].slice(0, 8);
    const blocks = [
      ...(srcs.length ? [{ type: "context", elements: [{ type: "mrkdwn", text: `Sources: ${srcs.map(([u, t]) => `<${u}|${t}>`).join(" · ")}`.slice(0, 2900) }] }] : []),
      // A failed run: what to try next, as buttons (the explanation is the teammate's own words above).
      ...(ok ? [] : [{ type: "actions", block_id: `recover:${runId}`, elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: "Retry" }, action_id: "retry_run", value: runId },
        { type: "button", text: { type: "plain_text", text: "Retry on fallback model" }, action_id: "retry_fallback", value: runId },
        { type: "button", text: { type: "plain_text", text: "Ask the owner" }, action_id: "ask_owner", value: runId },
      ] }]),
      { type: "context", elements: [{ type: "mrkdwn", text: `${line}${link}`.slice(0, 2900) }] },
      { type: "context_actions", elements: [{ type: "feedback_buttons", action_id: `feedback:${runId}`, positive_button: { text: { type: "plain_text", text: "Good" }, value: `up:${runId}` }, negative_button: { text: { type: "plain_text", text: "Bad" }, value: `down:${runId}` } }] },
    ];
    const tail = fallbackText ? [{ type: "markdown_text", text: fallbackText }] : [];
    if (v.held) { fallbackText = `${v.held}${fallbackText ? `\n\n${fallbackText}` : ""}`; v.held = undefined; }
    if (v.streamTs && !v.failedStream) {
      // Open tasks close with the run.
      const open = [...v.tasks.entries()].filter(([, t]) => t.status === "in_progress" || t.status === "pending").map(([id, t]) => ({ type: "task_update", id, title: t.title, status: ok ? "complete" : "error" }));
      // The plan folds into a one-line summary of what was done.
      const summary = [...new Set(v.done ?? [])].slice(0, 4).join(" · ") || (ok ? "Done" : "Stopped");
      await slack(v.place.app_id, "chat.stopStream", { channel: v.place.channel, ts: v.streamTs, chunks: [{ type: "plan_update", title: summary.slice(0, 120) }, ...open, ...tail], blocks }).catch(async () => {
        await slack(v.place.app_id, "chat.postMessage", { channel: v.place.channel, thread_ts: v.place.thread_ts, text: fallbackText ?? line, blocks: [...(fallbackText ? [{ type: "markdown", text: fallbackText }] : []), ...blocks] });
      });
    } else if (v.place.direct || v.posted || fallbackText) {
      await post(v, fallbackText ?? line, [...(fallbackText ? [{ type: "markdown", text: fallbackText }] : []), ...blocks]);
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

// "Maya · $3.10/$40": the asker's spend this month against their own Otari limit, for the receipt.
async function personBudget(runId: string): Promise<string | null> {
  const p = (await pool.query("SELECT p.display_name, p.end_user_id FROM runs r JOIN submissions sub ON sub.id = r.submission_id JOIN people p ON p.id = sub.person_id WHERE r.id = $1", [runId])).rows[0];
  if (!p?.end_user_id) return null;
  const { endUser, tiers } = await import("../otari/people.ts");
  const [u, t] = await Promise.all([endUser(p.end_user_id), tiers()]);
  const tier = t.find((x) => x.budget_id === u?.budget_id) ?? t.find((x) => x.is_default);
  if (!u || !tier?.max_budget) return null;
  const m = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;
  return `${(p.display_name ?? "you").split(" ")[0]} · ${m(Number(u.spend))}/${m(tier.max_budget)}`;
}

// The approval card: who asked, what exactly, and the choices. Clicks come back through interactions.ts.
async function approvalCard(v: View, e: EventRow): Promise<void> {
  const a = (e.data as any).action ?? {};
  const id = (e.data as any).approval_id as string;
  await flushHeld(v);
  const { cardBlocks, question } = await import("./approval-card.ts");
  const blocks = await cardBlocks(a, id, v.teammate);
  const posted: any = await slack(v.place.app_id, "chat.postMessage", { channel: v.place.channel, thread_ts: v.place.thread_ts, text: question(a, v.teammate), blocks });
  // Where the card is, so a hire can add its install button and an expired card can say so.
  if (posted?.ts) await appendEvent({ sessionId: e.session_id, runId: e.run_id, type: "approval.card", data: { approval_id: id, app_id: v.place.app_id, channel: posted.channel ?? v.place.channel, ts: posted.ts, image: a.id_card_url ?? null, hero: a.id_card_hero ?? null } });
  // Waiting on a person: the session is suspended. An approver who isn't the asker gets the card in a DM too.
  await sessionStatus(v, "suspended");
  const askedBy = (await pool.query("SELECT sub.person_id FROM runs r JOIN submissions sub ON sub.id = r.submission_id WHERE r.id = $1", [e.run_id])).rows[0]?.person_id;
  const others = (a.approvers ?? []).filter((p: string) => p !== askedBy);
  if (others.length) {
    const link: any = posted?.ts ? await slack(v.place.app_id, "chat.getPermalink", { channel: posted.channel ?? v.place.channel, message_ts: posted.ts }).catch(() => null) : null;
    for (const p of (await pool.query("SELECT slack_user FROM people WHERE id = ANY($1) AND slack_user IS NOT NULL", [others])).rows) {
      const dm: any = await slack(v.place.app_id, "conversations.open", { users: p.slack_user }).catch(() => null);
      if (dm?.channel?.id) await slack(v.place.app_id, "chat.postMessage", { channel: dm.channel.id, text: question(a, v.teammate), blocks: [
        { type: "context", elements: [{ type: "mrkdwn", text: `You're asked to decide${link?.permalink ? ` (<${link.permalink}|the thread>)` : ""}.` }] }, ...blocks] }).catch(() => null);
    }
  }
}

// An expired card says so, with a way to ask again; a decided one is back to work.
async function approvalResolved(v: View, e: EventRow): Promise<void> {
  const d = e.data as any;
  if (d.status !== "expired") { await sessionStatus(v, "processing"); return; }
  const c = (await pool.query("SELECT data FROM events WHERE type = 'approval.card' AND data->>'approval_id' = $1 LIMIT 1", [d.approval_id])).rows[0]?.data;
  if (c) await slack(c.app_id, "chat.update", { channel: c.channel, ts: c.ts, text: "Expired. Ask again?", blocks: [
    { type: "section", text: { type: "mrkdwn", text: "*Expired.* Nobody answered in time, so nothing ran." } },
    { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Ask again" }, action_id: "retry_run", value: e.run_id }] },
  ] }).catch(() => null);
}

export function installSlackView(): void {
  onEvent(async (e) => {
    if (!e.run_id) {
      // slack_post outside a run is not possible (tools always have a run); ignore session-level events.
      return;
    }
    let v = views.get(e.run_id);
    if (e.type === "run.started") {
      const place = await placeOf(e.session_id);
      if (!place) return;
      const s = await getSession(e.session_id!);
      await start(e.run_id, place, s!.teammate_id);
      return;
    }
    if (!v && (e.type === "run.finished" || e.type === "run.failed")) {
      // Core restarted mid-run: the stream is gone, so the reply and receipt go out as a plain message.
      const place = await placeOf(e.session_id);
      if (!place) return;
      const s = await getSession(e.session_id!);
      const tm = await getTeammate(s!.teammate_id);
      v = { place, teammate: tm?.config.name ?? "teammate", slug: tm?.slug ?? "", streamTs: null, startedAt: Date.now(), posted: 0, tasks: new Map(), queue: Promise.resolve(), failedStream: true };
      views.set(e.run_id, v);
      v.posted = Number((await pool.query("SELECT count(*)::int AS n FROM events WHERE run_id = $1 AND type = 'slack.post'", [e.run_id])).rows[0].n);
    }
    if (!v) return;
    const d = e.data as any;
    if (e.type === "plan.updated") {
      for (const [i, s] of (d.steps ?? []).entries()) {
        const st = s.status === "done" ? "complete" : s.status === "doing" ? "in_progress" : s.status === "dropped" ? "error" : "pending";
        void enqueue(v, () => taskUpdate(v!, `plan-${i}`, s.step, st));
      }
      const now = (d.steps ?? []).find((x: any) => x.status === "doing")?.step;
      if (now) void enqueue(v, () => planTitle(v!, now));
    } else if (e.type === "tool.call" && !["plan", "slack_post", "slack_react", "read_skill"].includes(d.tool)) {
      const id = String(d.id ?? e.id);
      const st = d.status === "completed" ? "complete" : d.status === "waiting_approval" ? "in_progress" : ["failed", "refused", "denied", "expired", "invalid"].includes(d.status) ? "error" : "in_progress";
      const title = pretty(d.tool, { command: d.command });
      if (st === "complete") (v.done ??= []).push(title);
      const output = d.status === "waiting_approval" ? "waiting for approval" : d.status === "denied" ? "declined" : st === "complete" ? (d.summary || undefined) : st === "error" ? String(d.reason ?? d.error ?? "").slice(0, 120) || undefined : undefined;
      const sources = [...(d.sources ?? []), ...(d.url ? [d.url] : [])].filter((u: any) => typeof u === "string" && /^https?:/.test(u));
      // A hand-off's card wears the callee's face.
      const icon = d.callee && config.publicUrl ? { type: "icon", name: `${config.publicUrl}/faces/${d.callee}.png` } : iconFor(d.tool);
      void enqueue(v, () => taskUpdate(v!, id, d.callee ? `${title} (${d.callee})` : title, st, output, { icon, sources }));
      // The plan's title follows the work: the step running now, or the one that just finished.
      if (d.status !== "waiting_approval" && st !== "error") void enqueue(v, () => planTitle(v!, st === "complete" ? `${title}${output ? `: ${output}` : ""}` : title));
    } else if (e.type === "slack.post") {
      v.posted++;
      void enqueue(v, () => chunks(v!, [{ type: "markdown_text", text: `${v!.posted > 1 ? "\n\n" : ""}${d.text}` }]));
    } else if (e.type === "budget.blocked" && (d.scope === "teammate" || d.scope === "api_token" || d.scope === "key")) {
      void enqueue(v, () => budgetCard(v!, d));
    } else if (e.type === "approval.requested") {
      void enqueue(v, () => approvalCard(v!, e));
    } else if (e.type === "approval.resolved") {
      void enqueue(v, () => approvalResolved(v!, e));
    } else if (e.type === "run.finished" || e.type === "run.failed") {
      // The reply is what the teammate posted. If a person asked it directly and it posted nothing, its final text
      // is the reply (a direct ask always gets an answer).
      let fallback: string | null = null;
      if (!v.posted && v.place.direct) {
        const { rows } = await pool.query("SELECT data FROM events WHERE run_id = $1 AND type = 'turn.finished' ORDER BY id DESC LIMIT 1", [e.run_id]);
        // Clean final text: no thinking tags, and no "Peeblo:" style name prefix.
        const name = v.teammate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        fallback = String(rows[0]?.data?.text ?? "").replace(/<think(ing)?>[\s\S]*?<\/think(ing)?>/g, "").trim().replace(new RegExp(`^\\**${name}\\**\\s*:\\s*`, "i"), "").trim() || (e.type === "run.failed" ? `I hit a problem and stopped: ${String(d.error ?? "").slice(0, 300)}` : null);
      }
      // A run that ended on a typed stop (budget, a stuck loop, the guard, a model error) gets the recovery buttons.
      const stop = (await pool.query("SELECT data->>'stop_reason' AS r FROM events WHERE run_id = $1 AND type = 'turn.finished' ORDER BY id DESC LIMIT 1", [e.run_id])).rows[0]?.r;
      await finish(e.run_id, v, e.type === "run.finished" && !["budget_blocked", "stuck", "guard_unavailable", "error"].includes(stop ?? ""), fallback);
    }
  });
}
