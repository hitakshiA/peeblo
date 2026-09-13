import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { cases, evidence, events, runs, wakeups, db, now } from "./store.ts";
import { runCase, activeRuns } from "./runner.ts";
import { decide, operations, interrupts } from "./executor.ts";
import { bus, replay, emit, type RunEvent } from "./bus.ts";
import { slack, env } from "./connectors.ts";

// Peeblo service: Slack assignments and approvals (Socket Mode), durable wake-ups, and the case API + live stream.
const PORT = Number(process.env.PORT ?? 8787);
const APP_URL = process.env.PEEBLO_APP_URL ?? "https://peeblo.xyz";
const log = (...m: unknown[]) => console.log(new Date().toISOString(), ...m);

function startRun(caseId: string, trigger: string) {
  if (activeRuns.has(caseId)) return false;
  runCase(caseId, trigger).then((r) => log("run", caseId, r.status, r.case.status)).catch((e) => log("run failed", caseId, e.message));
  return true;
}

// ---------------------------------------------------------------- scheduler: durable wake-ups
if (!process.env.PEEBLO_NO_SCHEDULER) setInterval(() => {
  for (const w of wakeups.due()) {
    if (activeRuns.has(w.case_id)) continue;
    wakeups.fire(w.id);
    log("wake-up", w.case_id, w.reason);
    startRun(w.case_id, `Scheduled wake-up: ${w.reason}`);
  }
}, 15_000);

// ---------------------------------------------------------------- Slack Socket Mode
async function connectSlack() {
  if (!env.SLACK_APP_TOKEN) return log("slack: no app token, skipping");
  const { url } = await slack.call("apps.connections.open", {}, env.SLACK_APP_TOKEN);
  const ws = new WebSocket(url);
  ws.addEventListener("message", async (msg) => {
    const env_ = JSON.parse(String(msg.data));
    if (env_.envelope_id) ws.send(JSON.stringify({ envelope_id: env_.envelope_id }));
    try {
      if (env_.type === "events_api" && env_.payload.event.type === "app_mention") await onMention(env_.payload.event, env_.payload.event_id);
      if (env_.type === "interactive" && env_.payload.type === "block_actions") await onAction(env_.payload);
      if (env_.type === "disconnect") ws.close();
    } catch (e) { log("slack handler error", (e as Error).message); }
  });
  ws.addEventListener("close", () => { log("slack socket closed, reconnecting"); setTimeout(() => connectSlack().catch((e) => log("slack reconnect failed", e.message)), 2000); });
  ws.addEventListener("open", () => log("slack socket connected"));
}

async function onMention(ev: any, eventId: string) {
  const eventRow = events.receive("slack", eventId, ev);
  if (!eventRow) return; // Slack retry of an event we already have
  const text = String(ev.text).replace(/<@[A-Z0-9]+>/g, "").trim();
  const thread = ev.thread_ts ?? ev.ts;
  const c = cases.create(text.slice(0, 80) || "Slack assignment", `Slack assignment from <@${ev.user}>: ${text}`, `slack:${ev.channel}:${thread}`);
  events.attach(eventRow, c.id);
  evidence.add(c.id, "slack", `Assignment received from <@${ev.user}>: ${text}`, thread);
  await slack.call("chat.postMessage", { channel: ev.channel, thread_ts: thread, text: `On it. I opened case \`${c.id}\` and I'm investigating across Stripe, QuickBooks, Salesforce, HubSpot, Dropbox and Notion. Follow along: ${APP_URL}/app/case/${c.id}` });
  startRun(c.id, `Slack assignment from <@${ev.user}>: ${text}`);
}

async function onAction(payload: any) {
  const action = payload.actions?.[0];
  if (!action || !["peeblo_approve", "peeblo_reject"].includes(action.action_id)) return;
  const decision = action.action_id === "peeblo_approve" ? "approved" : "rejected";
  const apr = db.prepare("SELECT case_id FROM approvals WHERE id = ?").get(action.value) as { case_id: string } | undefined;
  if (apr) emit(apr.case_id, undefined, "approval.decided", { approval_id: action.value, decision, user: payload.user.id });
  const res = await decide(action.value, payload.user.id, decision);
  const original = payload.message?.blocks?.[0]?.text?.text ?? "";
  await slack.call("chat.update", { channel: payload.channel.id, ts: payload.message.ts, text: res.message, blocks: [
    { type: "section", text: { type: "mrkdwn", text: original.slice(0, 2900) } },
    { type: "context", elements: [{ type: "mrkdwn", text: `${res.ok ? (decision === "approved" ? "✅" : "⛔") : "⚠️"} ${res.message} · <@${payload.user.id}>` }] },
  ] });
}

// Report back in the originating Slack thread when a run ends.
bus.on("event", async (e: RunEvent) => {
  if (e.type !== "run.finished" || !e.data?.case) return;
  const thread = (db.prepare("SELECT ref FROM evidence WHERE case_id = ? AND source = 'slack' AND fact LIKE 'Assignment received%' LIMIT 1").get(e.case_id) as { ref: string } | undefined)?.ref;
  if (!thread || e.data.status === "interrupted") return;
  const c = e.data.case;
  await slack.call("chat.postMessage", { channel: env.SLACK_ASSIGNMENTS_CHANNEL_ID, thread_ts: thread, text: `*${c.title}* · status: *${c.status}*\n${c.summary ?? ""}\n_Next:_ ${c.next_action ?? "—"}` }).catch(() => {});
});

// ---------------------------------------------------------------- HTTP API + SSE
const json = (res: ServerResponse, code: number, body: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
const body = (req: IncomingMessage) => new Promise<any>((ok) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { ok(d ? JSON.parse(d) : {}); } catch { ok({}); } }); });

function caseDetail(caseId: string) {
  const c = cases.get(caseId);
  if (!c) return undefined;
  return {
    ...c, accounts: JSON.parse(c.accounts),
    evidence: evidence.list(caseId), operations: operations.list(caseId).map((o: any) => ({ ...o, params: JSON.parse(o.params) })),
    approvals: db.prepare("SELECT id, operation_id, status, approver, expires_at, decided_at, created_at FROM approvals WHERE case_id = ? ORDER BY created_at").all(caseId),
    runs: runs.list(caseId), wakeup: wakeups.pending(caseId) ?? null, active: activeRuns.has(caseId), interrupt_armed: interrupts.armed() || null,
  };
}

createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.end();
  const url = new URL(req.url ?? "/", "http://x");
  const parts = url.pathname.split("/").filter(Boolean); // api, cases, :id, action
  try {
    if (url.pathname === "/api/health") return json(res, 200, { ok: true, time: now(), active_runs: [...activeRuns.keys()] });
    if (url.pathname === "/api/cases" && req.method === "GET") return json(res, 200, cases.list().map((c) => ({ ...c, accounts: JSON.parse(c.accounts), active: activeRuns.has(c.id), wakeup: wakeups.pending(c.id) ?? null, apps: [...new Set((db.prepare("SELECT data FROM run_events WHERE case_id = ? AND type = 'tool.finished'").all(c.id) as any[]).flatMap((r) => JSON.parse(r.data).apps))] })));
    if (url.pathname === "/api/cases" && req.method === "POST") {
      const { objective, title } = await body(req);
      if (!objective) return json(res, 400, { error: "objective required" });
      const c = cases.create(title ?? String(objective).slice(0, 80), objective);
      startRun(c.id, `Assignment from the Peeblo console: ${objective}`);
      return json(res, 201, c);
    }
    if (parts[0] === "api" && parts[1] === "stream") return sse(req, res, undefined);
    if (parts[0] === "api" && parts[1] === "cases" && parts[2]) {
      const caseId = parts[2];
      if (!cases.get(caseId)) return json(res, 404, { error: "case not found" });
      if (!parts[3] && req.method === "GET") return json(res, 200, caseDetail(caseId));
      if (parts[3] === "events") return json(res, 200, replay(caseId, Number(url.searchParams.get("after") ?? 0)));
      if (parts[3] === "stream") return sse(req, res, caseId);
      if (parts[3] === "resume" && req.method === "POST") { const { trigger } = await body(req); return json(res, 200, { started: startRun(caseId, trigger ?? "Resumed from the Peeblo console after interruption") }); }
      if (parts[3] === "interrupt" && req.method === "POST") {
        const { mode } = await body(req); // "now" aborts the active run; "after_next_write" interrupts right after the next accepted write
        if (mode === "after_next_write") { interrupts.arm("*"); emit(caseId, undefined, "interrupt.armed", {}); return json(res, 200, { armed: true }); }
        const run = activeRuns.get(caseId);
        if (!run) return json(res, 409, { error: "no active run" });
        run.abort("interrupted from console");
        return json(res, 200, { interrupted: true });
      }
    }
    if (url.pathname === "/api/demo/reset" && req.method === "POST") {
      const { scenario } = await body(req);
      const script = resolve(import.meta.dirname, "../../seed/scenarios", `${String(scenario ?? "eastbridge").replace(/[^a-z_]/g, "")}.ts`);
      const child = spawn(process.execPath, [script], { env: process.env });
      let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
      child.on("close", (code) => json(res, code === 0 ? 200 : 500, { code, output: out.slice(-4000) }));
      return;
    }
    json(res, 404, { error: "not found" });
  } catch (e) { json(res, 500, { error: (e as Error).message }); }
}).listen(PORT, () => log(`peeblo api on :${PORT}`));

function sse(req: IncomingMessage, res: ServerResponse, caseId: string | undefined) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  const send = (e: RunEvent) => res.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  if (caseId) replay(caseId, Number(req.headers["last-event-id"] ?? 0)).forEach(send);
  const listener = (e: RunEvent) => { if (!caseId || e.case_id === caseId) send(e); };
  bus.on("event", listener);
  const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
  req.on("close", () => { bus.off("event", listener); clearInterval(ping); });
}

if (!process.env.PEEBLO_NO_SLACK) connectSlack().catch((e) => log("slack connect failed", e.message));
