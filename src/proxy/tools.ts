// Peeblo's tool endpoints for Pi, on the same loopback proxy and per-session token as model calls. This is the
// gate: the model chooses a tool, the harness decides whether and how it runs.
// GET  /peeblo/tools       → the session's fixed tool list: Peeblo's own tools and the connector tools
// POST /peeblo/tools/call  → {name, arguments, tool_call_id}
// For every call: arguments checked against the strict schema (one retry, then a typed stop), authority
// checked, writes one at a time per session and approved by a person when the tool or the mode says so,
// untrusted results labelled with their source and screened, and a tool.call event.
import type { IncomingMessage, ServerResponse } from "node:http";
import { peebloTools } from "../agent-tools/index.ts";
import { validate, type Schema } from "../agent-tools/schema.ts";
import type { AgentTool, ToolContext, ToolResult } from "../agent-tools/types.ts";
import { config } from "../config.ts";
import { catalogFor, classify, executeTool, forgetServer, needsApproval, outOfScope, type ConnectorTool } from "../connectors/mcp.ts";
import { pool } from "../db.ts";
import { askApproval, fingerprint } from "../durable/approvals.ts";
import { argClass, modeRule, NEVER_WITHOUT_ASKING, review, riskOf } from "../reviewer.ts";
import { screen, wrapUntrusted } from "../guard.ts";
import { newId } from "../ids.ts";
import { appendEvent } from "../store/events.ts";
import { getPerson } from "../store/people.ts";
import { getSession } from "../store/sessions.ts";
import { getTeammate, teammateAt, type Teammate } from "../store/teammates.ts";

// A session keeps its config, but a lower mode applies at once (K5): the gate uses the stricter of the
// session's mode and the teammate's current one. The tool list never changes within a session (K7a).
const STRICTNESS = ["ask", "auto", "trusted", "yolo"] as const;
export async function effectiveMode(pinned: Teammate): Promise<Teammate["config"]["mode"]> {
  const now = await getTeammate(pinned.id);
  const a = STRICTNESS.indexOf(pinned.config.mode);
  const b = now ? STRICTNESS.indexOf(now.config.mode) : a;
  return STRICTNESS[Math.min(a, b)];
}
import type { Binding } from "./relay.ts";

const json = (res: ServerResponse, status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

// An approval waits 30 minutes while someone is in the conversation, 12 hours for an unattended run (a schedule).
export async function approvalTtl(runId: string): Promise<number> {
  // Unattended (a schedule or trigger, or a teammate it called): 12 hours, then no.
  const { isUnattended } = await import("../approvers.ts");
  return (await isUnattended(runId)) ? 12 * 3600 : config.approvalTtlSeconds;
}

async function granted(teammateId: string, runId: string | null, fp: string): Promise<boolean> {
  const { rows } = await pool.query(
    "SELECT 1 FROM grants WHERE teammate_id = $1 AND fingerprint = $2 AND revoked_at IS NULL AND (scope = 'always' OR (scope = 'job' AND run_id = $3)) LIMIT 1",
    [teammateId, fp, runId],
  );
  return rows.length > 0;
}

function mcpText(data: any): { text: string; isError: boolean } {
  // /mcp/execute answers with the MCP tool result; keep its text blocks, else the JSON.
  const r = data?.result ?? data;
  const blocks = Array.isArray(r?.content) ? r.content : null;
  const text = blocks ? blocks.map((b: any) => (b?.type === "text" ? b.text : JSON.stringify(b))).join("\n") : JSON.stringify(r);
  return { text: text.slice(0, 50_000), isError: r?.isError === true || data?.is_error === true };
}

// Writes in a session run one at a time (K7h), whatever the model sends in parallel.
const writeLocks = new Map<string, Promise<unknown>>();
async function oneAtATime<T>(sessionId: string, f: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(sessionId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(f);
  writeLocks.set(sessionId, next.catch(() => {}));
  return next;
}

const LOOP_NUDGE = 3;
const LOOP_STOP = 6;
const identical = new Map<string, number>();

// Invalid arguments get one retry with the reason; a second failure in a row stops the tool for the turn.
const invalidStreak = new Map<string, number>();

type Listed = { name: string; description: string; input_schema: unknown; asks: boolean; direct: boolean };

// K7b: a session starts with Peeblo's own tools and only the few connector tools this teammate uses most
// (from its own history; for a new teammate, the first reads). The rest are found with find_tools.
const DIRECT_CONNECTOR_TOOLS = 3;
export async function mostUsed(teammateId: string, names: string[]): Promise<Set<string>> {
  const { rows } = await pool.query(
    `SELECT e.data->>'tool' AS tool, count(*) AS n FROM events e JOIN sessions s ON s.id = e.session_id
      WHERE s.teammate_id = $1 AND e.type = 'tool.call' AND e.data->>'via' = 'otari_mcp' AND e.data->>'status' = 'completed'
      GROUP BY 1 ORDER BY 2 DESC`, [teammateId]);
  const picked = rows.map((r) => r.tool as string).filter((t) => names.includes(t)).slice(0, DIRECT_CONNECTOR_TOOLS);
  for (const n of names) {
    if (picked.length >= DIRECT_CONNECTOR_TOOLS) break;
    if (!picked.includes(n) && /__(list|get|search|read)/.test(n)) picked.push(n);
  }
  return new Set(picked);
}

export async function handleTools(req: IncomingMessage, res: ServerResponse, b: Binding, path: string, body: Buffer | undefined): Promise<void> {
  const tm = await teammateAt(b.teammateId, b.teammateVersion);
  if (!tm) return json(res, 404, { detail: "teammate is gone" });
  const subagent = Boolean(((await getSession(b.sessionId))?.place as { subagent_of?: string } | undefined)?.subagent_of);
  const own = peebloTools(tm, { subagent });

  if (req.method === "GET" && path === "/tools") {
    const cat = await catalogFor(tm.config);
    const direct = await mostUsed(tm.id, cat.tools.map((t) => t.name));
    const tools: Listed[] = [
      ...own.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, asks: t.kind === "write", direct: !t.deferred })),
      ...cat.tools.filter((t) => !subagent || classify(t, {}) === "read").map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema, asks: needsApproval(tm.config.mode, classify(t, {})), direct: direct.has(t.name) })),
    ];
    return json(res, 200, { tools, missing: cat.missing, failed: cat.failed });
  }
  if (req.method !== "POST" || path !== "/tools/call") return json(res, 404, { detail: "no such tool route" });

  const { name, arguments: args = {}, tool_call_id: toolCallId = newId("tc") } = JSON.parse(body?.toString("utf8") || "{}");
  const person = b.personId ? await getPerson(b.personId) : null;
  const ctx: ToolContext = { teammate: tm, person, sessionId: b.sessionId, runId: b.runId, endUser: b.endUser, toolCallId, otariKey: b.otariKey && b.keyId ? { keyId: b.keyId, secret: b.otariKey } : null, subagent };
  const ownTool = own.find((t) => t.name === name);
  const connector = ownTool ? undefined : (await catalogFor(tm.config)).tools.find((x) => x.name === name);
  if (!ownTool && !connector) return json(res, 200, { text: `There is no tool called ${name} in this session. Use one of the tools you were given.`, isError: true });

  const base: Record<string, unknown> = { turn: b.turn, by: "peeblo", id: toolCallId, tool: name, args_fingerprint: fingerprint(args), asked_by: person?.id ?? null, end_user: b.endUser };
  const event = (data: Record<string, unknown>) => appendEvent({ sessionId: b.sessionId, runId: b.runId, type: "tool.call", data: { ...base, ...data } }).catch(() => {});
  // Loop limits (K14), the same on every model: the 3rd identical call in a run gets a factual note, the 6th
  // stops the run.
  const repeatKey = `${b.runId}:${name}:${base.args_fingerprint}`;
  const repeats = (identical.get(repeatKey) ?? 0) + 1;
  identical.set(repeatKey, repeats);
  if (repeats >= LOOP_STOP) {
    b.stuck = { runId: b.runId, reason: `the same ${name} call ${repeats} times` };
    await event({ status: "refused", reason: "loop limit" });
    await appendEvent({ sessionId: b.sessionId, runId: b.runId, type: "run.stuck", data: { reason: b.stuck.reason } });
    return json(res, 200, { text: `Stopped: this exact ${name} call has been made ${repeats} times in this run. Tell the person what you were trying and what kept happening.`, isError: true });
  }
  const note = repeats >= LOOP_NUDGE ? `\n[peeblo: this is the ${repeats}${repeats === 3 ? "rd" : "th"} identical ${name} call in this run; the result will not change.]` : "";
  const reply = (r: ToolResult) => json(res, 200, { text: r.text + note, isError: Boolean(r.isError) });

  // Untrusted results are labelled with their source and screened; a flag is appended as a warning.
  const finish = async (r: ToolResult, source: string | null, extra: Record<string, unknown>) => {
    let text = r.text;
    let screened = null;
    if (source && !r.isError) {
      screened = await screen(text, b.endUser).catch(() => null);
      text = wrapUntrusted(text, source, screened);
    }
    await event({ status: r.isError ? "failed" : "completed", ...extra, ...(r.isError ? { error: r.text.slice(0, 500) } : {}), untrusted: source, guard: screened ? { checked_by: screened.checked_by, flagged: screened.flagged, score: screened.score, request_id: screened.requestId } : null });
    return reply({ ...r, text });
  };

  if (ownTool) return runOwn(ownTool, ctx, args, base, event, reply, finish, b);
  return runConnector(connector!, ctx, args, base, event, reply, finish, b);
}

async function runOwn(t: AgentTool, ctx: ToolContext, args: any, base: Record<string, unknown>, event: (d: Record<string, unknown>) => Promise<unknown>, reply: (r: ToolResult) => void, finish: (r: ToolResult, source: string | null, extra: Record<string, unknown>) => Promise<void>, b: Binding): Promise<void> {
  base.via = "peeblo";
  base.kind = t.kind;
  if (t.name === "computer_bash") base.command = String(args.command ?? "").slice(0, 500); // the audit keeps what ran
  if (t.name === "read_skill") base.skill = String(args.skill ?? ""); // which skill was read (the skills eval reads it)
  const streakKey = `${ctx.sessionId}:${t.name}`;
  const problem = validate(t.input_schema as Schema, args);
  if (problem) {
    const n = (invalidStreak.get(streakKey) ?? 0) + 1;
    invalidStreak.set(streakKey, n);
    await event({ status: "invalid", reason: problem, attempt: n });
    return reply({ text: n < 2 ? `Invalid arguments: ${problem}. Fix that and call ${t.name} once more.` : `Invalid arguments again (${problem}). Stop calling ${t.name} and tell the person what you were trying to do.`, isError: true });
  }
  invalidStreak.delete(streakKey);
  const refusal = t.authorize ? await t.authorize(ctx, args) : null;
  if (refusal) { await event({ status: "refused", reason: refusal }); return reply({ text: refusal, isError: true }); }
  // The rule engine for this exact call (computer tools): required gates refuse, advisory gates ask.
  let rule = t.gate ? await t.gate(ctx, args) : null;
  if (rule?.deny) { await event({ status: "refused", reason: rule.deny }); return reply({ text: rule.deny, isError: true }); }
  // Outward own tools go through the same gate as connector writes: mode rule → reviewer in Auto → a card.
  const outward = t.outward ? await t.outward(ctx, args) : null;
  if (outward && !rule?.ask) {
    const mode = await effectiveMode(ctx.teammate);
    Object.assign(base, { mode, risk: outward });
    let r = modeRule(mode, outward);
    if (r === "review" && ctx.runId) {
      const rv = await review(ctx.runId, ctx.sessionId, { teammate: ctx.teammate.slug, server: "peeblo", tool: t.name, arguments: args }, b.endUser ?? undefined).catch(() => ({ decision: "card" as const, reason: "the reviewer didn't answer", reviewed: false }));
      await appendEvent({ sessionId: ctx.sessionId, runId: ctx.runId, type: "review.decided", data: { tool: t.name, server: "peeblo", risk: outward, decision: rv.decision, reason: rv.reason, request_ids: (rv as any).requestIds ?? [] } });
      if (rv.decision === "revise") { await event({ status: "refused", reason: `reviewer: ${rv.reason}` }); return reply({ text: `Not yet: ${rv.reason}. Change that and try again, or ask the person.`, isError: true }); }
      r = rv.decision === "allow" ? "allow" : "card";
      base.reviewer = rv.reason;
    }
    if (r === "card") rule = { ask: base.reviewer ? `The reviewer wants a person to decide: ${base.reviewer}` : `${ctx.teammate.config.name} wants to ${t.name.replace(/_/g, " ")}${outward === "shipping" ? " (this ships work outside the team)" : outward === "outside_thread" ? " (this posts outside this conversation)" : ""}.` };
  }

  const run = async () => {
    if (t.kind === "write" || rule?.ask) {
      // Otari settings always, and anything the rules say to ask about: a person's yes for this one call.
      if (!ctx.runId) return reply({ text: "This needs a person's approval, and there is no run to ask in.", isError: true });
      if (rule?.ask) base.rule = rule.ask;
      await event({ status: "waiting_approval" });
      const action = { kind: "peeblo_tool", teammate: ctx.teammate.slug, tool: t.name, arguments: args, ...(t.describe ? await t.describe(ctx, args) : {}), asked_by: ctx.person?.id ?? null, ...(outward ? { risk: outward, per_action: NEVER_WITHOUT_ASKING.includes(outward) } : {}) };
      // Own tools ask like connector calls: unattended runs wait 12 h for the owner (approvers: src/approvers.ts).
      const a = await askApproval(ctx.runId, ctx.sessionId, action, await approvalTtl(ctx.runId));
      if (a.status !== "approved") {
        await event({ status: a.status === "expired" ? "expired" : "denied", approval_id: a.approvalId });
        return reply({ text: a.status === "expired" ? "No one approved this in time, so nothing changed." : "A person said no, so nothing changed. Don't ask again in this conversation.", isError: true });
      }
      base.approval_id = a.approvalId;
    }
    const t0 = Date.now();
    try {
      const r = await t.run(ctx, args);
      return finish(r, r.untrusted ?? null, { ms: Date.now() - t0, ...(r.data && typeof r.data === "object" ? { result: r.data } : {}) });
    } catch (e) {
      await event({ status: "failed", ms: Date.now() - t0, error: (e as Error).message.slice(0, 500) });
      return reply({ text: `${t.name} failed: ${(e as Error).message.slice(0, 300)}`, isError: true });
    }
  };
  return t.kind === "read" ? run() : oneAtATime(b.sessionId, run);
}

async function runConnector(t: ConnectorTool, ctx: ToolContext, args: any, base: Record<string, unknown>, event: (d: Record<string, unknown>) => Promise<unknown>, reply: (r: ToolResult) => void, finish: (r: ToolResult, source: string | null, extra: Record<string, unknown>) => Promise<void>, b: Binding): Promise<void> {
  const tm = ctx.teammate;
  const mode = await effectiveMode(tm);
  base.mode = mode;
  Object.assign(base, { via: "otari_mcp", server: t.server, server_id: t.serverId, server_revision: t.revision });
  const kind = classify(t, args);
  base.kind = kind;
  const scope = outOfScope(t, args, tm.config.connector_scopes);
  if (scope) {
    await event({ status: "refused", reason: scope });
    return reply({ text: `Not allowed: ${scope}. Ask the teammate's owner to add it.`, isError: true });
  }
  const run = async () => {
    // The gate (src/reviewer.ts): risk class → mode rule → grant → the reviewer in Auto → a card.
    const risk = riskOf(t, args, kind);
    base.risk = risk;
    const blocks = Number((await pool.query("SELECT count(*)::int AS n FROM events WHERE run_id = $1 AND type = 'review.decided' AND data->>'decision' <> 'allow'", [b.runId])).rows[0]?.n ?? 0);
    let rule = modeRule(blocks >= 3 ? "ask" : mode, risk);
    const toolFp = fingerprint({ teammate: tm.id, server: t.serverId, tool: t.tool, class: argClass(t, args) });
    // Money, deletions, shipping and posts outside the thread are per action: a grant never covers them.
    const perAction = NEVER_WITHOUT_ASKING.includes(risk);
    if (rule !== "allow" && !perAction && b.runId && (await granted(tm.id, b.runId, toolFp))) rule = "allow";
    // An exact repeat of a call a person already approved in this job (e.g. a retry after the service failed)
    // doesn't ask again. Confirmation tokens a service adds don't make it a different call.
    const { human_confirmation: _hc, approval_token: _at, ...core } = args;
    // For a Stripe write, the same action is the same operation on the same object for the same amount (a retry that
    // adds an optional field like `reason` is still that refund).
    const p = (core as any).parameters ?? {};
    const identity = t.server === "stripe" ? { op: (core as any).stripe_api_operation_id, target: p.charge ?? p.payment_intent ?? p.id ?? p.customer ?? null, amount: p.amount ?? null } : core;
    const exactFp = fingerprint({ server: t.server, tool: t.tool, args: JSON.stringify(identity) });
    base.exact = exactFp;
    if (rule !== "allow" && b.runId) {
      const prior = (await pool.query("SELECT 1 FROM events WHERE run_id = $1 AND type = 'tool.call' AND data->>'exact' = $2 AND data->>'approval_id' IS NOT NULL LIMIT 1", [b.runId, exactFp])).rows[0];
      if (prior) { rule = "allow"; base.repeat_of_approved = true; }
    }
    if (rule === "review" && b.runId) {
      const r = await review(b.runId, b.sessionId, { teammate: tm.slug, server: t.server, tool: t.tool, arguments: args }, b.endUser ?? undefined).catch(() => ({ decision: "card" as const, reason: "the reviewer didn't answer", reviewed: false }));
      await appendEvent({ sessionId: b.sessionId, runId: b.runId, type: "review.decided", data: { tool: t.tool, server: t.server, risk, decision: r.decision, reason: r.reason, request_ids: (r as any).requestIds ?? [] } });
      if (r.decision === "revise") {
        await event({ status: "refused", reason: `reviewer: ${r.reason}` });
        return reply({ text: `Not yet: ${r.reason}. Change that and try again, or ask the person.`, isError: true });
      }
      rule = r.decision === "allow" ? "allow" : "card";
      base.reviewer = r.reason;
    }
    if (rule === "card") {
      if (!b.runId) return reply({ text: "This call needs a person's approval, and there is no run to ask in.", isError: true });
      {
        await event({ status: "waiting_approval" });
        const action = { kind: "connector_call", teammate: tm.slug, server: t.server, tool: t.tool, arguments: args, server_revision: t.revision, end_user: b.endUser, risk, per_action: perAction, ...(base.reviewer ? { rule: `The reviewer wants a person to decide: ${base.reviewer}` } : {}) };
        // Unattended (a schedule or trigger): only the teammate's owner can answer, and silence means no (K11).
        const ttl = await approvalTtl(b.runId);
        // Who may answer: src/approvers.ts (the owner when unattended, else the person who asked).
        const a = await askApproval(b.runId, b.sessionId, action, ttl);
        if (a.status !== "approved") {
          await event({ status: a.status === "expired" ? "expired" : "denied", approval_id: a.approvalId });
          return reply({ text: a.status === "expired" ? "No one approved this in time, so it did not run. Say so, and offer to try again." : "A person said no to this call, so it did not run. Do not retry it.", isError: true });
        }
        if (!perAction && (a.scope === "always" || a.scope === "job")) {
          await pool.query("INSERT INTO grants (id, teammate_id, fingerprint, scope, run_id) VALUES ($1, $2, $3, $4, $5)", [newId("gr"), tm.id, toolFp, a.scope, a.scope === "job" ? b.runId : null]);
        }
        base.approval_id = a.approvalId;
      }
    }
    const t0 = Date.now();
    try {
      const { data, requestId } = await executeTool(t, args);
      const r = mcpText(data);
      return finish(r, `mcp:${t.server}.${t.tool}`, { request_id: requestId, ms: Date.now() - t0, result_chars: r.text.length });
    } catch (error) {
      const e = error as Error & { status?: number; requestId?: string | null; code?: string | null };
      if (e.status === 409 || /revision/i.test(e.message)) forgetServer(t.serverId);
      await event({ status: "failed", request_id: e.requestId ?? null, ms: Date.now() - t0, error: e.message.slice(0, 500), error_code: e.code ?? null });
      return reply({ text: `The ${t.server} call failed: ${e.message.slice(0, 400)}`, isError: true });
    }
  };
  return kind === "read" ? run() : oneAtATime(b.sessionId, run);
}
