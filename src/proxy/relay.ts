// The model proxy. Pi (with pi-otari) never holds Otari's key: it gets a per-session token and talks to this
// loopback relay. The relay swaps in the real key, names the paying person (Otari end user), tags the call
// with teammate/session/run, sets the conversation id and an idempotency key, retries once on the teammate's
// fallback model when the first one fails before any output, and writes one model.call event per attempt
// from Otari's own headers and inline cost. Receipts are built from those events.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { config } from "../config.ts";
import { pool } from "../db.ts";
import { appendEvent } from "../store/events.ts";
import { handleTools } from "./tools.ts";
import { freshLakeraState, guardrailRefusal } from "../guard.ts";
import { budgetRefusal } from "../otari/people.ts";
import { estimateCost, roughTokens } from "../otari/catalog.ts";
import { modelFor, ROLES } from "../otari/routing.ts";
import { capCheck, noteSpend, type CapRefusal } from "../otari/spend.ts";
import { teammateAt } from "../store/teammates.ts";

export type WebPolicy = { allowed_domains: string[]; blocked_domains: string[] };
export type Binding = { teammateId: string; teammateVersion: number; personId: string | null; teammateSlug: string; sessionId: string; runId: string | null; endUser: string | null; fallbackModel: string | null; turn: number; web: WebPolicy | null; code: boolean; otariKey: string | null; keyId: string | null; finalStatus?: { runId: string | null; calls: number }; stuck?: { runId: string | null; reason: string }; blocked?: { runId: string | null; turn: number; status: number; body: string } };
const tokens = new Map<string, Binding>();

export function issueToken(b: Omit<Binding, "runId" | "endUser" | "turn" | "personId">): string {
  const token = `peeblo_${randomBytes(24).toString("base64url")}`;
  tokens.set(token, { ...b, runId: null, endUser: null, personId: null, turn: 0 });
  return token;
}
export function bindRun(token: string, runId: string, endUser: string | null, turn: number, personId: string | null): void {
  const b = tokens.get(token);
  if (b) Object.assign(b, { runId, endUser, turn, personId });
}
// After a job stops on a limit: one short turn to write where it is (only slack_post, at most 3 model calls).
export function allowFinalStatus(token: string, runId: string): void {
  const b = tokens.get(token);
  if (b) b.finalStatus = { runId, calls: 0 };
}
export function revokeToken(token: string): void {
  tokens.delete(token);
}
export const proxyBaseUrl = () => `http://127.0.0.1:${config.proxyPort}/api/v1`;
export const toolsBaseUrl = () => `http://127.0.0.1:${config.proxyPort}/peeblo`;

const INFERENCE = new Set(["/chat/completions", "/messages", "/responses"]);
const DROP = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);
const RETRYABLE_CODES = new Set(["invalid_model", "pricing_required", "provider_not_configured", "provider_unavailable", "provider_credential_rejected"]);

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function prepare(path: string, raw: Buffer, b: Binding, model?: string, sandbox?: string, label?: string): { buf: Buffer; model: string | null; stream: boolean; tools: number } {
  const j = JSON.parse(raw.toString("utf8"));
  if (model) j.model = model;
  if (typeof j.model === "string") j.model = modelFor(j.model);
  // Otari's Sessions view names the job the way people know it ("Rivet · #incidents · checkout timeouts").
  if (label && (path === "/chat/completions" || path === "/messages" || path === "/responses")) j.session_label = label;
  // Name the paying person the way each API shape expects; drop any user the agent tried to set itself.
  if (path === "/messages") {
    j.metadata = { ...(j.metadata ?? {}) };
    if (b.endUser && config.otariKeyKind === "service") j.metadata.user_id = b.endUser; else delete j.metadata.user_id;
  } else if (b.endUser && config.otariKeyKind === "service") j.user = b.endUser; else delete j.user;
  if (Array.isArray(j.tools)) j.tools = gatewayTools(j.tools, b.web);
  // Code runs in Otari's sandbox, inside the model call. One sandbox per session, held between calls.
  if (path === "/chat/completions" && b.code && sandbox) j.tools = [...(j.tools ?? []), { type: "otari_code_execution", container: sandbox }];
  if (path === "/chat/completions" && j.stream) j.stream_options = { ...(j.stream_options ?? {}), include_usage: true };
  return { buf: Buffer.from(JSON.stringify(j)), model: typeof j.model === "string" ? j.model : null, stream: Boolean(j.stream), tools: Array.isArray(j.tools) ? j.tools.length : 0 };
}

// The session's Otari sandbox: reuse it while Otari still holds it (its idle timer restarts on each use),
// otherwise ask for a new one. Known sandboxes are kept in the event log, so a restart can pick them up.
const sandboxes = new Map<string, { id: string; expiresAt: number }>();
async function sandboxFor(sessionId: string): Promise<string> {
  let s = sandboxes.get(sessionId);
  if (!s) {
    const { rows } = await pool.query("SELECT data FROM events WHERE session_id = $1 AND type = 'code.sandbox' ORDER BY id DESC LIMIT 1", [sessionId]);
    if (rows[0]) s = { id: rows[0].data.id, expiresAt: Date.parse(rows[0].data.expires_at) };
  }
  return s && s.expiresAt - Date.now() > 15_000 ? s.id : "auto";
}
async function noteSandbox(b: Binding, h: Headers): Promise<void> {
  const id = h.get("otari-container-id");
  const expires = h.get("otari-container-expires-at");
  if (!id || !expires) return;
  const prev = sandboxes.get(b.sessionId);
  sandboxes.set(b.sessionId, { id, expiresAt: Date.parse(expires) });
  if (prev?.id !== id) await appendEvent({ sessionId: b.sessionId, runId: b.runId, type: "code.sandbox", data: { id, expires_at: expires } }).catch(() => {});
}

// Otari runs web search and fetch itself. A teammate without the web tool gets neither, whatever Pi declares;
// one with it gets its own domain lists on the search declaration, which Otari also applies to fetches.
function gatewayTools(tools: any[], web: WebPolicy | null): any[] {
  return tools.flatMap((t) => {
    if (t?.type === "otari_code_execution") return []; // only Peeblo declares it, for teammates allowed to run code
    // Pages are read with Peeblo's web_fetch (through Otari's /fetch), so their text can be labelled and
    // screened before the model sees it; Otari's in-loop fetch would hand it to the model unseen.
    if (t?.type === "otari_web_fetch") return [];
    if (t?.type !== "otari_web_search") return [t];
    if (!web) return [];
    const d: any = { ...t };
    if (web.allowed_domains.length) d.allowed_domains = web.allowed_domains; else delete d.allowed_domains;
    if (web.blocked_domains.length) d.blocked_domains = web.blocked_domains; else delete d.blocked_domains;
    return [d];
  });
}

// The estimate of a model call before it runs: its prompt (about 4 characters a token) plus the most it may
// write (max_tokens, else 1,000), at catalog prices. Role policies are priced as their default model.
async function budgetGate(b: Binding, raw: Buffer): Promise<CapRefusal | null> {
  const j = JSON.parse(raw.toString("utf8"));
  // Budgets are read fresh (a raise applies to running work); the rest of the setup stays pinned to the session.
  const { getTeammate } = await import("../store/teammates.ts");
  const tm = (await getTeammate(b.teammateId)) ?? (await teammateAt(b.teammateId, b.teammateVersion));
  if (!tm) return unchecked("its teammate's setup couldn't be found");
  const sent = typeof j.model === "string" ? j.model : tm.config.model.default;
  const model = sent in ROLES ? ROLES[sent].default : sent;
  const promptChars = JSON.stringify(j.messages ?? j.input ?? "").length + JSON.stringify(j.tools ?? []).length + String(j.system ?? "").length;
  // Agents send the model's whole output limit as max_tokens; a turn rarely writes more than 8k, so the estimate
  // uses the smaller of the two (Otari's own caps still count the full allowance).
  const out = Math.min(Number(j.max_tokens ?? j.max_completion_tokens ?? j.max_output_tokens ?? 1000), 8192);
  const est = await estimateCost(model, roughTokens(" ".repeat(Math.min(promptChars, 4_000_000))), out);
  // No price, no call: money fails closed (K16).
  if (est === null) return unchecked(`${model} has no price in Otari's catalog`);
  let cap = await capCheck(tm, b.endUser, model, est);
  // A role that steps down near its budget is served by the cheaper model there (Otari's policy decides), so price
  // that before refusing: otherwise this check would stop the very calls the step-down exists for.
  const step = sent in ROLES ? ROLES[sent].step_down : undefined;
  if (cap && step) {
    const cheaper = await estimateCost(step.model, roughTokens(" ".repeat(Math.min(promptChars, 4_000_000))), out);
    if (cheaper !== null) cap = await capCheck(tm, b.endUser, step.model, cheaper);
  }
  if (cap) return cap;
  return runBudget(b.runId, est);
}

// A call whose cost can't be checked doesn't run.
const unchecked = (why: string): CapRefusal => ({ scope: "unchecked", spent: 0, cap: 0, estimate: 0, message: `Peeblo couldn't check this call against the budget (${why}), so it didn't run.` });

// A scheduled or triggered run has its own budget (K11); a run a person started has only the teammate's and theirs.
async function runBudget(runId: string | null, est: number): Promise<CapRefusal | null> {
  if (!runId) return null;
  const { rows } = await pool.query(
    `SELECT sc.budget_usd FROM runs r JOIN submissions s ON s.id = r.submission_id JOIN schedules sc ON sc.id = split_part(s.request_id, ':', 2)
      WHERE r.id = $1 AND s.source IN ('schedule', 'webhook')`, [runId]);
  if (!rows[0]) return null;
  const budget = Number(rows[0].budget_usd);
  const spent = Number((await pool.query("SELECT coalesce(sum((data->>'cost_usd')::numeric), 0) AS c FROM events WHERE run_id = $1 AND type = 'model.call'", [runId])).rows[0].c);
  if (spent + est <= budget) return null;
  return { scope: "teammate", spent, cap: budget, estimate: est, message: `This scheduled run has a budget of $${budget.toFixed(2)} and has spent $${spent.toFixed(4)}; the next call (about $${est.toFixed(4)}) would go over.` };
}

// Reads the response as it passes: the usage block (last chunk) and Otari's own tool calls (web, code).
function usageWatcher(stream: boolean) {
  let tail = "";
  let line = "";
  const toolCalls = new Map<string, any>();
  const takeTools = (j: any) => {
    for (const c of j?.otari_tool_calls ?? j?.choices?.[0]?.delta?.otari_tool_calls ?? []) if (c?.id) toolCalls.set(c.id, { ...toolCalls.get(c.id), ...c });
  };
  return {
    push(chunk: Uint8Array) {
      const text = Buffer.from(chunk).toString("utf8");
      tail = (tail + text).slice(-16_000);
      if (!stream) return;
      const parts = (line + text).split("\n");
      line = parts.pop()!;
      for (const l of parts) if (l.startsWith("data:") && l.includes("otari_tool_calls")) { try { takeTools(JSON.parse(l.slice(5))); } catch { /* not JSON */ } }
    },
    toolCalls(): any[] {
      if (!stream) { try { takeTools(JSON.parse(tail)); } catch { /* larger than the tail */ } }
      return [...toolCalls.values()];
    },
    usage(): any {
      const lines = stream ? tail.split("\n").filter((l) => l.startsWith("data:") && l.includes('"usage"')).map((l) => l.slice(5).trim()) : [tail];
      for (const l of lines.reverse()) {
        try { const j = JSON.parse(l); const u = j.usage ?? j.response?.usage ?? j.message?.usage; if (u) return u; } catch { /* partial */ }
      }
      return null;
    },
  };
}

export function startProxy(): Promise<Server> {
  const server = createServer(async (req, res) => {
    const auth = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const b = tokens.get(auth);
    if (!b) return void res.writeHead(401, { "content-type": "application/json" }).end('{"detail":"unknown token"}');
    const url = req.url ?? "/";
    if (url.startsWith("/peeblo/")) {
      const raw = req.method === "POST" ? await body(req) : undefined;
      return handleTools(req, res, b, url.slice("/peeblo".length).split("?")[0], raw).catch((e) => {
        console.error("tools:", (e as Error).message);
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: "Peeblo could not run that tool.", isError: true }));
      });
    }
    if (!url.startsWith("/api/v1/")) return void res.writeHead(404).end();
    const path = url.slice("/api/v1".length).split("?")[0];
    const isInference = req.method === "POST" && INFERENCE.has(path);
    const raw = req.method === "GET" || req.method === "HEAD" ? undefined : await body(req);

    const headers: Record<string, string> = { authorization: `Bearer ${b.otariKey ?? config.otariKey}`, "user-agent": "peeblo/0.1 (pi)" };
    for (const h of ["content-type", "accept"]) if (typeof req.headers[h] === "string") headers[h] = req.headers[h] as string;
    if (isInference) {
      headers["otari-conversation-id"] = b.sessionId;
      headers["otari-tags"] = `teammate=${b.teammateSlug},session=${b.sessionId}${b.runId ? `,run=${b.runId}` : ""}`;
      if (config.traceContent) headers["otari-trace-content"] = "keep";
    }

    // After the guardrail refused this turn's input, Pi's retries would only be refused again (and spend guard
    // checks): answer them here with Otari's own refusal.
    // Loop rail (K14): a stuck run gets no more model calls.
    if (isInference) {
      // A tool that runs inside the agent (find_tools) never reaches core: a request that ends on a tool result means
      // the last turn did something, so it isn't a silent one.
      if (b.runId && raw) {
        try {
          const msgs = (JSON.parse(raw.toString()) as any).messages ?? [];
          const lastCalls = ([...msgs].reverse().find((m: any) => m.role === "assistant")?.tool_calls ?? []) as any[];
          if (msgs.at(-1)?.role === "tool" && lastCalls.some((c) => c.function?.name === "find_tools")) await appendEvent({ sessionId: b.sessionId, runId: b.runId, type: "tool.local", data: {} }).catch(() => {});
        } catch { /* not JSON */ }
      }
      // K14: three model turns in a row with nothing visible in between (no tool ran, nothing posted) stop the run.
      const silent = b.runId ? Number((await pool.query(
        `SELECT count(*)::int AS n FROM events WHERE run_id = $1 AND type = 'model.call' AND coalesce(data->>'role', '') NOT IN ('guard', 'vision', 'judge')
           AND id > coalesce((SELECT max(id) FROM events WHERE run_id = $1 AND type IN ('tool.call', 'slack.post', 'tool.local')), 0)`, [b.runId]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n) : 0;
      // No count or per-job spend limit: a job runs on its budget. Only a stuck run (the same call over and over, or
      // turns with nothing to show) is stopped.
      const finalTurn = b.finalStatus?.runId === b.runId && b.finalStatus.calls < 3;
      if (finalTurn) b.finalStatus!.calls++;
      const why = finalTurn ? null : b.stuck?.runId === b.runId ? b.stuck.reason : silent >= 3 ? "3 turns in a row with no visible output" : null;
      if (why) {
        if (b.stuck?.runId !== b.runId) { b.stuck = { runId: b.runId, reason: why }; await appendEvent({ sessionId: b.sessionId, runId: b.runId, type: "run.stuck", data: { reason: why } }).catch(() => {}); }
        return void res.writeHead(429, { "content-type": "application/json", "otari-error-code": "loop_limit", "peeblo-refused": "loop_limit" }).end(JSON.stringify({ detail: `Peeblo stopped this run: ${why}.`, code: "loop_limit" }));
      }
    }
    if (isInference && b.blocked && b.blocked.runId === b.runId && b.blocked.turn === b.turn) return void res.writeHead(b.blocked.status, { "content-type": "application/json" }).end(b.blocked.body);

    // Money is code (K16): a call whose estimate would take the teammate or the person over their budget is
    // refused here, before it reaches Otari, in Otari's own refusal shape.
    if (isInference && raw) {
      // A budget check that fails refuses the call (fail closed).
      const t1 = Date.now();
      const refusal = await budgetGate(b, raw).finally(() => { if (Date.now() - t1 > 1000) console.error(`slow: budget gate ${Date.now() - t1} ms`); }).catch((e) => { console.error("proxy: budget check failed:", (e as Error).message); return unchecked(`the check failed: ${(e as Error).message.slice(0, 120)}`); });
      if (refusal) {
        const text = JSON.stringify({ detail: refusal.message, code: "budget_exceeded" });
        b.blocked = { runId: b.runId, turn: b.turn, status: 403, body: text };
        await appendEvent({ sessionId: b.sessionId, runId: b.runId, type: "budget.blocked", data: { by: "peeblo", scope: refusal.scope, spent: refusal.spent, cap: refusal.cap, estimate: refusal.estimate, message: refusal.message, end_user: b.endUser, turn: b.turn } }).catch(() => {});
        return void res.writeHead(403, { "content-type": "application/json", "otari-error-code": "budget_exceeded", "otari-budget-scope": refusal.scope, "peeblo-refused": "budget" }).end(text);
      }
    }

    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const attempt = async (model?: string, sandbox?: string) => {
      sandbox ??= isInference && b.code ? await sandboxFor(b.sessionId) : undefined;
      const p = isInference && raw ? prepare(path, raw, b, model, sandbox, await sessionLabel(b).catch(() => undefined)) : { buf: raw, model: null, stream: false };
      const t0 = Date.now();
      const upstream = await fetch(config.otariBaseUrl + url.slice("/api/v1".length), {
        method: req.method, headers: { ...headers, ...(isInference ? { "idempotency-key": randomUUID() } : {}) },
        body: p.buf ? new Uint8Array(p.buf) : undefined, signal: abort.signal, redirect: "error",
      });
      return { upstream, model: p.model, stream: p.stream, t0, sandbox, tools: "tools" in p ? p.tools : 0 };
    };

    let a;
    try {
      a = await attempt();
      // A sandbox Otari let go of early answers 400; start a fresh one once.
      if (a.upstream.status === 400 && a.sandbox && a.sandbox !== "auto") {
        const detail = await a.upstream.clone().text();
        if (/expired or does not exist/i.test(detail)) {
          await record(b, path, a, null, { failed: true, error: detail.slice(0, 300) });
          sandboxes.delete(b.sessionId);
          a = await attempt(undefined, "auto");
        }
      }
      // Otari refuses the whole call while its code sandbox is down (503, any model); the turn goes on without code.
      if (a.upstream.status === 503 && a.sandbox) {
        const detail = await a.upstream.clone().text();
        if (/sandbox temporarily unavailable/i.test(detail)) {
          await record(b, path, a, null, { failed: true, error: detail.slice(0, 300) });
          await appendEvent({ sessionId: b.sessionId, runId: b.runId, type: "code.unavailable", data: { request_id: a.upstream.headers.get("otari-request-id") } }).catch(() => {});
          a = await attempt(undefined, "");
        }
      }
      // Peeblo's own cross-model fallback, before any output reached Pi: on a failure a different model can fix.
      const code = a.upstream.headers.get("otari-error-code");
      const retryable = a.upstream.status === 429 || a.upstream.status >= 500 || a.upstream.status === 424 || (code !== null && RETRYABLE_CODES.has(code));
      if (isInference && retryable && b.fallbackModel && a.model !== b.fallbackModel) {
        const detail = (await a.upstream.text()).slice(0, 300);
        await record(b, path, a, null, { failed: true, error: detail });
        a = await attempt(b.fallbackModel);
        (a as any).peebloFallback = true;
      }
    } catch (error) {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ detail: `Otari unreachable: ${(error as Error).message}` }));
    }

    // Written as soon as Otari answers, so a call cut off by a crash still shows on the receipt (and is reconciled).
    if (isInference && b.code) await noteSandbox(b, a.upstream.headers);
    // A refusal that a retry can't fix (guardrail, budget): record it once and answer Pi's retries locally.
    if (isInference && [402, 403, 429].includes(a.upstream.status)) {
      const text = await a.upstream.clone().text();
      const money = budgetRefusal(a.upstream.status, a.upstream.headers, text);
      if (money) {
        b.blocked = { runId: b.runId, turn: b.turn, status: a.upstream.status, body: text };
        await appendEvent({ sessionId: b.sessionId, runId: b.runId, type: "budget.blocked", data: { by: "otari", ...money, request_id: a.upstream.headers.get("otari-request-id"), key: b.keyId ?? "core", end_user: b.endUser, turn: b.turn } }).catch(() => {});
      }
      const refusal = guardrailRefusal(a.upstream.status, text);
      if (refusal) b.blocked = { runId: b.runId, turn: b.turn, status: a.upstream.status, body: text };
      if (refusal) await appendEvent({ sessionId: b.sessionId, runId: b.runId, type: "guard.blocked", data: { checked_by: "lakera", via: "otari_org_guardrail", ...refusal, request_id: a.upstream.headers.get("otari-request-id"), turn: b.turn } }).catch(() => {});
    }
    if (isInference) await appendEvent({ sessionId: b.sessionId, runId: b.runId, type: "model.call.opened", data: { turn: b.turn, request_id: a.upstream.headers.get("otari-request-id"), status: a.upstream.status, requested_model: a.model } }).catch(() => {});
    const out: Record<string, string> = {};
    a.upstream.headers.forEach((v, k) => { if (!DROP.has(k)) out[k] = v; });
    res.writeHead(a.upstream.status, out);
    const watch = usageWatcher(a.stream);
    let firstChunkMs: number | null = null;
    try {
      if (a.upstream.body) for await (const chunk of a.upstream.body) { firstChunkMs ??= Date.now() - a.t0; if (isInference) watch.push(chunk); res.write(chunk); }
    } catch { /* client went away; we still record what we know */ }
    res.end();
    if (isInference) {
      const requestId = a.upstream.headers.get("otari-request-id");
      for (const c of watch.toolCalls()) {
        await appendEvent({ sessionId: b.sessionId, runId: b.runId, type: "tool.call", data: { turn: b.turn, by: "otari", request_id: requestId, id: c.id, tool: c.type, status: c.status, query: c.query ?? null, url: c.url ?? null, sources: (c.sources ?? []).map((s: any) => s.url).slice(0, 10), error: c.error ?? null,
          ...(c.type === "code_execution" ? { code: String(c.code ?? "").slice(0, 4000), exit_code: c.exit_code ?? null, stdout: String(c.stdout ?? "").slice(-2000), stderr: String(c.stderr ?? "").slice(-1000), files: c.file_ids ?? c.files ?? [], sandbox: a.upstream.headers.get("otari-container-id") } : {}) } }).catch(() => {});
      }
      const usage = watch.usage();
      await record(b, path, a, usage, { firstChunkMs, peebloFallback: Boolean((a as any).peebloFallback) });
      if (usage?.cost_usd !== undefined) {
        noteSpend(b.teammateId, b.endUser, Number(usage.cost_usd) || 0);
      }
    }
  });
  return new Promise((resolve) => server.listen(config.proxyPort, "127.0.0.1", () => resolve(server)));
}

async function record(b: Binding, path: string, a: { upstream: Response; model: string | null; t0: number }, usage: any, extra: Record<string, unknown>): Promise<void> {
  const h = a.upstream.headers;
  const n = (v: unknown) => (v === undefined || v === null || v === "" ? null : Number(v));
  await appendEvent({
    sessionId: b.sessionId, runId: b.runId, type: "model.call",
    data: {
      turn: b.turn, path, status: a.upstream.status, request_id: h.get("otari-request-id"), requested_model: a.model,
      served_model: h.get("otari-model"), provider: h.get("otari-provider"), attempts: n(h.get("otari-attempt-count")),
      otari_fallback: h.get("otari-fallback") === "true", error_code: h.get("otari-error-code"), guardrails: h.get("otari-guardrails"),
      cost_usd: n(usage?.cost_usd), prompt_tokens: n(usage?.prompt_tokens ?? usage?.input_tokens), cached_tokens: n(usage?.prompt_tokens_details?.cached_tokens ?? usage?.cache_read_input_tokens),
      completion_tokens: n(usage?.completion_tokens ?? usage?.output_tokens), end_user: b.endUser, key: b.keyId ?? "core", guard_mandate: await freshLakeraState(), tools_declared: (a as { tools?: number }).tools ?? null, ms: Date.now() - a.t0, ...extra,
    },
  }).catch((e) => console.error("proxy: could not record model call:", (e as Error).message));
}

// The session's label in Otari: teammate, where the work lives, and what was asked first. Cached per session.
const labels = new Map<string, string>();
async function sessionLabel(b: Binding): Promise<string | undefined> {
  const hit = labels.get(b.sessionId);
  if (hit) return hit;
  const { rows } = await pool.query(
    `SELECT t.config->>'name' AS name, s.kind, s.place->'slack'->>'channel' AS channel,
            (SELECT left(data->>'text', 120) FROM events WHERE session_id = s.id AND type = 'submission.received' ORDER BY id LIMIT 1) AS ask
       FROM sessions s JOIN teammate_versions t ON t.teammate_id = s.teammate_id AND t.version = (SELECT max(version) FROM teammate_versions WHERE teammate_id = s.teammate_id)
      WHERE s.id = $1`, [b.sessionId]).catch(() => ({ rows: [] as any[] }));
  const r = rows[0];
  if (!r) return undefined;
  const where = r.kind === "dm" ? "DM" : r.channel ? await channelName(r.channel) : r.kind;
  const ask = String(r.ask ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  const label = [r.name ?? b.teammateSlug, where, ask].filter(Boolean).join(" · ").slice(0, 255);
  labels.set(b.sessionId, label);
  return label;
}
const channelNames = new Map<string, string>();
async function channelName(id: string): Promise<string> {
  if (channelNames.has(id)) return channelNames.get(id)!;
  const { slack } = await import("../slack/api.ts");
  const app = (await pool.query("SELECT app_id FROM slack_apps a JOIN teammates t ON t.id = a.teammate_id WHERE t.slug = 'peeblo' LIMIT 1")).rows[0]?.app_id;
  const info: any = app ? await slack(app, "conversations.info", { channel: id }).catch(() => null) : null;
  const name = info?.channel?.name ? `#${info.channel.name}` : id;
  channelNames.set(id, name);
  return name;
}
