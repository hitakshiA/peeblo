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

type View = { place: SlackPlace; teammate: string; slug: string; streamTs: string | null; startedAt: number; posted: number; tasks: Map<string, { title: string; status: string }>; queue: Promise<unknown>; failedStream: boolean };
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
    await openStream(v);
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

async function chunks(v: View, c: any[]): Promise<void> {
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

function taskUpdate(v: View, id: string, title: string, status: "pending" | "in_progress" | "complete" | "error", output?: string) {
  v.tasks.set(id, { title, status });
  return chunks(v, [{ type: "task_update", id, title: title.slice(0, 120), status, ...(output ? { output: output.slice(0, 200) } : {}) }]);
}

async function finish(runId: string, v: View, ok: boolean, fallbackText: string | null): Promise<void> {
  await enqueue(v, async () => {
    const r = await buildReceipt(runId).catch(() => null);
    const line = r ? `${v.teammate} · ${receiptLine(r)}` : v.teammate;
    const link = r?.links?.session ? ` · <${r.links.session}|receipt>` : "";
    const blocks = [
      { type: "context", elements: [{ type: "mrkdwn", text: `${line}${link}`.slice(0, 2900) }] },
      { type: "context_actions", elements: [{ type: "feedback_buttons", action_id: `feedback:${runId}`, positive_button: { text: { type: "plain_text", text: "Good" }, value: `up:${runId}` }, negative_button: { text: { type: "plain_text", text: "Bad" }, value: `down:${runId}` } }] },
    ];
    const tail = fallbackText ? [{ type: "markdown_text", text: fallbackText }] : [];
    if (v.streamTs && !v.failedStream) {
      // Open tasks close with the run.
      const open = [...v.tasks.entries()].filter(([, t]) => t.status === "in_progress" || t.status === "pending").map(([id, t]) => ({ type: "task_update", id, title: t.title, status: ok ? "complete" : "error" }));
      await slack(v.place.app_id, "chat.stopStream", { channel: v.place.channel, ts: v.streamTs, chunks: [...open, ...tail], blocks }).catch(async () => {
        await slack(v.place.app_id, "chat.postMessage", { channel: v.place.channel, thread_ts: v.place.thread_ts, text: fallbackText ?? line, blocks: [...(fallbackText ? [{ type: "markdown", text: fallbackText }] : []), ...blocks] });
      });
    } else if (v.place.direct || v.posted || fallbackText) {
      await post(v, fallbackText ?? line, [...(fallbackText ? [{ type: "markdown", text: fallbackText }] : []), ...blocks]);
    }
    if (v.place.direct) {
      await unreact(v.place.app_id, v.place.channel, v.place.trigger_ts, "eyes");
      await react(v.place.app_id, v.place.channel, v.place.trigger_ts, ok ? "white_check_mark" : "warning");
    }
  });
  views.delete(runId);
}

// The approval card: who asked, what exactly, and the choices. Clicks come back through interactions.ts.
async function approvalCard(v: View, e: EventRow): Promise<void> {
  const a = (e.data as any).action ?? {};
  const id = (e.data as any).approval_id as string;
  const what = a.kind === "hire" ? `hire a new teammate: ${a.summary ?? ""}` : a.kind === "recipe_change" ? `change my computer's setup (${[a.diff?.packages?.apk, a.diff?.packages?.npm, a.diff?.packages?.pip].filter((x) => x && x !== "none").join("; ") || "new steps"})`
    : a.tool ? `${pretty(a.tool, a.arguments ?? {}).replace(/^./, (c: string) => c.toLowerCase())}${a.server ? ` (${a.server})` : ""}`
    : "go ahead";
  const detail = a.rule ?? (a.arguments ? "```" + JSON.stringify(a.arguments).slice(0, 600) + "```" : "");
  const price = a.price_usd ? ` · about $${Number(a.price_usd).toFixed(4)}` : "";
  const only = a.kind === "hire" ? " · only the person who asked can answer" : a.approvers?.length ? " · only the owner can answer" : "";
  const posted: any = await slack(v.place.app_id, "chat.postMessage", {
    channel: v.place.channel, thread_ts: v.place.thread_ts, text: `${v.teammate} wants to ${what}. Approve?`,
    blocks: [
      ...(a.id_card_url ? [{ type: "image", image_url: a.id_card_url, alt_text: `${a.summary ?? "teammate"} ID card`.slice(0, 2000) }] : []),
      { type: "section", text: { type: "mrkdwn", text: `*${v.teammate} wants to ${what}.*${detail && a.kind !== "hire" ? `\n${detail}` : ""}` } },
      { type: "context", elements: [{ type: "mrkdwn", text: `Waits for your answer${a.risk === "money" ? " · moves money" : a.risk === "destructive" ? " · removes something" : a.risk === "shipping" ? " · ships a change" : a.risk === "outside_thread" ? " · posts outside this thread" : ""}${price}${only}` }] },
      { type: "actions", block_id: `approval:${id}`, elements: [
        { type: "button", style: "primary", text: { type: "plain_text", text: "Approve once" }, action_id: "approve_once", value: id },
        // Money, deletions, shipping, Otari settings and hires are approved one at a time.
        ...(a.per_action || a.kind === "hire" || a.kind === "recipe_change" || String(a.tool ?? "").startsWith("otari_set") ? [] : [
          { type: "button", text: { type: "plain_text", text: "For this job" }, action_id: "approve_job", value: id },
          { type: "button", text: { type: "plain_text", text: "Always" }, action_id: "approve_always", value: id },
        ]),
        { type: "button", style: "danger", text: { type: "plain_text", text: "No" }, action_id: "deny", value: id },
      ] },
    ],
  });
  // Where the card is, so a hire can add its install button to it later.
  if (posted?.ts) await appendEvent({ sessionId: e.session_id, runId: e.run_id, type: "approval.card", data: { approval_id: id, app_id: v.place.app_id, channel: posted.channel ?? v.place.channel, ts: posted.ts, image: a.id_card_url ?? null } });
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
    } else if (e.type === "tool.call" && d.tool !== "plan" && d.tool !== "slack_post" && d.tool !== "slack_react") {
      const id = String(d.id ?? e.id);
      const st = d.status === "completed" ? "complete" : d.status === "waiting_approval" ? "in_progress" : ["failed", "refused", "denied", "expired", "invalid"].includes(d.status) ? "error" : "in_progress";
      void enqueue(v, () => taskUpdate(v!, id, pretty(d.tool, { command: d.command }), st, d.status === "waiting_approval" ? "waiting for approval" : d.status === "denied" ? "declined" : undefined));
    } else if (e.type === "slack.post") {
      v.posted++;
      void enqueue(v, () => chunks(v!, [{ type: "markdown_text", text: `${v!.posted > 1 ? "\n\n" : ""}${d.text}` }]));
    } else if (e.type === "approval.requested") {
      void enqueue(v, () => approvalCard(v!, e));
    } else if (e.type === "run.finished" || e.type === "run.failed") {
      // The reply is what the teammate posted. If a person asked it directly and it posted nothing, its final text
      // is the reply (a direct ask always gets an answer).
      let fallback: string | null = null;
      if (!v.posted && v.place.direct) {
        const { rows } = await pool.query("SELECT data FROM events WHERE run_id = $1 AND type = 'turn.finished' ORDER BY id DESC LIMIT 1", [e.run_id]);
        fallback = String(rows[0]?.data?.text ?? "").trim() || (e.type === "run.failed" ? `I hit a problem and stopped: ${String(d.error ?? "").slice(0, 300)}` : null);
      }
      await finish(e.run_id, v, e.type === "run.finished", fallback);
    }
  });
}
