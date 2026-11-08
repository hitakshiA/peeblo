// Peeblo's tool endpoints for Pi, on the same loopback proxy and per-session token as model calls. This is the
// gate: the model chooses a tool, the harness decides whether and how it runs.
// GET  /peeblo/tools       → the session's fixed tool list: Peeblo's own tools and the connector tools
// POST /peeblo/tools/call  → {name, arguments, tool_call_id}
// For every call: arguments checked against the strict schema (one retry, then a typed stop), authority
// checked, writes one at a time per session and approved by a person when the tool or the mode says so,
// untrusted results labelled with their source and screened, and a tool.call event.
import type { IncomingMessage, ServerResponse } from "node:http";
import { peebloTools } from "../agent-tools/index.ts";
import { computerTools } from "../agent-tools/computer.ts";
import { validate, type Schema } from "../agent-tools/schema.ts";
import type { AgentTool, ToolContext, ToolResult } from "../agent-tools/types.ts";
import { config } from "../config.ts";
import { ALWAYS_REFUSES, catalogFor, classify, executeTool, forgetServer, markUnavailable, needsApproval, outOfScope, type ConnectorTool } from "../connectors/mcp.ts";
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
// What a task card shows under a finished tool (SLACK_UX_SPEC §3.3): a short result, from the tool's own output.
export function summarize(text: string): string {
  const t = text.trim();
  try {
    const j = JSON.parse(t);
    const list = Array.isArray(j) ? j : Array.isArray(j?.results) ? j.results : Array.isArray(j?.items) ? j.items : Array.isArray(j?.issues) ? j.issues : Array.isArray(j?.data) ? j.data : Array.isArray(j?.nodes) ? j.nodes : null;
    if (list) return `${list.length} result${list.length === 1 ? "" : "s"}`;
    // One record: its id and title, the way a person would name it ("GRO-331 · Pricing page footer…").
    if (j && typeof j === "object") {
      const name = [j.identifier ?? j.id ?? j.number ?? j.key, j.title ?? j.name ?? j.subject ?? j.summary].filter((x) => typeof x === "string" || typeof x === "number").join(" · ");
      if (name) return name.length > 80 ? `${name.slice(0, 79)}…` : name;
    }
  } catch { /* not JSON */ }
  const first = t.split(/\n/).find((l) => l.trim()) ?? "";
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}
// Web addresses in a result, for the card's sources (at most 5).
export function urlsIn(text: string): string[] {
  return [...new Set((text.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? []).map((u) => u.replace(/[.,;]+$/, "")))].slice(0, 5);
}

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
// A repeat of a read in the same run gets the earlier result back without calling the service again.
const readCache = new Map<string, string>();
// At most this many tool calls in one turn; after that only slack_post runs (NIGHT_PLAN_NOV9 §1).
const TURN_CALLS = 16;
const turnCalls = new Map<string, number>();
// A connector result longer than this is saved on the agent's computer; the model gets the start, a count and the path.
const RESULT_CAP = 16_000;

// Invalid arguments get one retry with the reason; a second failure in a row stops the tool for the turn.
const invalidStreak = new Map<string, number>();

type Listed = { name: string; description: string; input_schema: unknown; asks: boolean; direct: boolean };

// K7b: a session starts with Peeblo's own tools and only the few connector tools this teammate uses most
// (from its own history; for a new teammate, the first reads). The rest are found with find_tools.
// Connector tools all start deferred (the small start set, NIGHT_PLAN_NOV9 §1); find_tools loads what a job needs.
const DIRECT_CONNECTOR_TOOLS = 0;
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
    const tt = Date.now();
    res.on("finish", () => { if (process.env.PEEBLO_TIMING) console.error(`timing: GET /tools ${Date.now() - tt} ms`); });
    const cat = await catalogFor(tm.config);
    const direct = await mostUsed(tm.id, cat.tools.map((t) => t.name));
    // A scoped GitHub connector names its repos, so the model never guesses an owner.
    const scoped = tm.config.connector_scopes?.github ?? [];
    const visible = scoped.length ? "" : await githubVisible(cat.tools);
    const repos = scoped.length ? `This teammate's GitHub repos (owner/repo): ${scoped.join(", ")}. Use these names exactly.`
      : visible ? `Repos this GitHub connection can see (owner/repo, most recently updated first): ${visible}. Use these names exactly; never guess an owner.`
      : "Never guess a repo's owner: unless you know the exact owner/repo, find it first with search_repositories (user:<login> from get_me, or org:<org>).";
    const tools: Listed[] = [
      ...own.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, asks: t.kind === "write", direct: !t.deferred })),
      ...cat.tools.filter((t) => !subagent || classify(t, {}) === "read").map((t) => ({ name: t.name, description: t.server === "github" && repos ? `${t.description}\n${repos}` : t.description, input_schema: t.inputSchema, asks: needsApproval(tm.config.mode, classify(t, {})), direct: direct.has(t.name) })),
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
  const turnKey = `${b.runId}:${b.turn}`;
  const used = (turnCalls.get(turnKey) ?? 0) + 1;
  turnCalls.set(turnKey, used);
  if (used > TURN_CALLS && name !== "slack_post") {
    await event({ status: "refused", reason: "turn call limit" });
    return json(res, 200, { text: `That is ${TURN_CALLS} tool calls this turn. Stop looking things up: post what you have with slack_post, and say what you couldn't check.`, isError: true });
  }
  // A heads-up near the limit, so the agent answers with what it has instead of being cut off.
  const left = TURN_CALLS - used;
  const limitNote = left === 3 && name !== "slack_post" ? `\n[peeblo: 3 tool calls left this turn. Answer with what you have; say plainly what you couldn't check.]` : "";
  const cached = repeats >= 2 ? readCache.get(repeatKey) : undefined;
  if (cached !== undefined) {
    await event({ status: "completed", reused: true });
    return json(res, 200, { text: `[peeblo: you made this exact call earlier in this job; here is the same result again.]\n${cached}` });
  }
  const note = repeats >= LOOP_NUDGE ? `\n[peeblo: this is the ${repeats}${repeats === 3 ? "rd" : "th"} identical ${name} call in this run; the result will not change.]` : "";
  const reply = (r: ToolResult) => json(res, 200, { text: r.text + note + limitNote, isError: Boolean(r.isError), ...(r.endTurn && !r.isError ? { terminate: true } : {}) });

  // Untrusted results are labelled with their source and screened; a flag is appended as a warning.
  const finish = async (r: ToolResult, source: string | null, extra: Record<string, unknown>) => {
    let text = r.text;
    let screened = null;
    if (source && !r.isError) {
      screened = await screen(text, b.endUser).catch(() => null);
      text = wrapUntrusted(text, source, screened);
    }
    if (!r.isError && (extra.kind ?? base.kind) === "read") {
      if (readCache.size > 2000) readCache.clear();
      readCache.set(repeatKey, text);
    }
    await event({ status: r.isError ? "failed" : "completed", ...extra, ...(r.isError ? { error: r.text.slice(0, 500) } : { summary: summarize(r.text), lines: r.text.split("\n").filter((l) => /^\s*(- |• |\d+\. )/.test(l)).length, sources: urlsIn(r.text) }), untrusted: source, guard: screened ? { checked_by: screened.checked_by, flagged: screened.flagged, score: screened.score, request_id: screened.requestId } : null });
    return reply({ ...r, text });
  };

  if (ownTool) return runOwn(ownTool, ctx, args, base, event, reply, finish, b);
  return runConnector(connector!, ctx, args, base, event, reply, finish, b);
}

async function runOwn(t: AgentTool, ctx: ToolContext, args: any, base: Record<string, unknown>, event: (d: Record<string, unknown>) => Promise<unknown>, reply: (r: ToolResult) => void, finish: (r: ToolResult, source: string | null, extra: Record<string, unknown>) => Promise<void>, b: Binding): Promise<void> {
  base.via = "peeblo";
  base.kind = t.kind;
  if (t.name === "computer_bash") base.command = String(args.command ?? "").slice(0, 500); // the audit keeps what ran
  if (t.name === "delegate" || t.name === "ask_teammate") base.callee = String(args.teammate ?? "").toLowerCase(); // its face on the caller's task card
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
        return reply({ text: a.status === "expired" ? "No one approved this in time, so nothing changed." : (a.reason ? `They said not now: "${a.reason}". Nothing ran. Answer them in one short line like a colleague who heard them (e.g. "Okay, leaving GRO-329 alone."), and don't retry.` : "They said not now, so nothing ran. Say so in one short line and don't retry."), isError: true });
      }
      base.approval_id = a.approvalId;
      if (a.arguments) { args = a.arguments; base.edited = true; }
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
  // Internal pages go through their own connector, never a web scraper (that dodges access rules and fails anyway).
  if (["apify", "exa", "context7", "deepwiki"].includes(t.server)) {
    const internal = JSON.stringify(args).match(/https?:\/\/[^"\s]*(notion\.so|notion\.site|atlassian\.net|linear\.app|slack\.com|docs\.google\.com|drive\.google\.com|sanity\.io|hubspot\.com|airtable\.com|monday\.com)[^"\s]*/i);
    if (internal) {
      await event({ status: "refused", reason: "internal page through a web scraper" });
      return reply({ text: `That's an internal page (${internal[1]}); open it with its own connector (find_tools), or say which page and who can share it with Peeblo. Web scrapers aren't for internal docs.`, isError: true });
    }
  }
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
    let rule = kind === "read" ? "allow" : modeRule(blocks >= 3 ? "ask" : mode, risk);
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
        const action = { kind: "connector_call", teammate: tm.slug, server: t.server, tool: t.tool, arguments: args, server_revision: t.revision, end_user: b.endUser, risk, per_action: perAction, grant_fp: perAction ? null : toolFp, ...(base.reviewer ? { rule: `The reviewer wants a person to decide: ${base.reviewer}` } : {}) };
        // Unattended (a schedule or trigger): only the teammate's owner can answer, and silence means no (K11).
        const ttl = await approvalTtl(b.runId);
        // Who may answer: src/approvers.ts (the owner when unattended, else the person who asked).
        const a = await askApproval(b.runId, b.sessionId, action, ttl);
        if (a.status !== "approved") {
          await event({ status: a.status === "expired" ? "expired" : "denied", approval_id: a.approvalId });
          return reply({ text: a.status === "expired" ? "No one approved this in time, so it did not run. Say so, and offer to try again." : (a.reason ? `They said not now: "${a.reason}". Nothing ran. Answer them in one short line like a colleague who heard them (e.g. "Okay, leaving GRO-329 alone."), and don't retry.` : "They said not now, so nothing ran. Say so in one short line and don't retry."), isError: true });
        }
        if (!perAction && (a.scope === "always" || a.scope === "job")) {
          await pool.query("INSERT INTO grants (id, teammate_id, fingerprint, scope, run_id) VALUES ($1, $2, $3, $4, $5)", [newId("gr"), tm.id, toolFp, a.scope, a.scope === "job" ? b.runId : null]);
        }
        base.approval_id = a.approvalId;
        if (a.arguments) { args = a.arguments; base.edited = true; }
      }
    }
    const t0 = Date.now();
    try {
      const { data, requestId } = await executeTool(t, args);
      const r = await capResult(ctx, t, mcpText(data), toolCallIdOf(base));
      if (r.isError && ALWAYS_REFUSES.test(r.text)) markUnavailable(t.server, t.tool); // the server refuses this tool for good
      return finish(r, `mcp:${t.server}.${t.tool}`, { request_id: requestId, ms: Date.now() - t0, result_chars: r.chars, ...(r.saved ? { saved_to: r.saved } : {}) });
    } catch (error) {
      const e = error as Error & { status?: number; requestId?: string | null; code?: string | null };
      if (e.status === 409 || /revision/i.test(e.message)) forgetServer(t.serverId);
      await event({ status: "failed", request_id: e.requestId ?? null, ms: Date.now() - t0, error: e.message.slice(0, 500), error_code: e.code ?? null });
      return reply({ text: `The ${t.server} call failed: ${e.message.slice(0, 400)}`, isError: true });
    }
  };
  return kind === "read" ? run() : oneAtATime(b.sessionId, run);
}

const toolCallIdOf = (base: Record<string, unknown>) => String(base.id ?? newId("tc"));

// How many records a JSON result holds: the longest array at the top or one level down.
function recordCount(text: string): number | null {
  try {
    const v = JSON.parse(text);
    const arrays = Array.isArray(v) ? [v] : v && typeof v === "object" ? Object.values(v).filter(Array.isArray) : [];
    return arrays.length ? Math.max(...arrays.map((a) => (a as unknown[]).length)) : null;
  } catch { return null; }
}

// The key fields of each record, one line each (up to 40), so the summary is usually enough to answer from.
const KEY_FIELDS = ["identifier", "key", "number", "id", "full_name", "name", "title", "subject", "state", "status", "email", "amount", "currency", "created_at", "createdAt", "updated_at", "html_url", "url"];
function compactList(text: string): string | null {
  let v: any;
  try { v = JSON.parse(text); } catch { return null; }
  const arr: any[] | undefined = Array.isArray(v) ? v : v && typeof v === "object" ? (Object.values(v).filter(Array.isArray) as any[][]).sort((a, b) => b.length - a.length)[0] : undefined;
  if (!arr?.length || typeof arr[0] !== "object") return null;
  const meta = v && !Array.isArray(v) ? Object.entries(v).filter(([, x]) => typeof x !== "object").map(([k, x]) => `${k}: ${x}`).join(", ") : "";
  const line = (o: any) => KEY_FIELDS.filter((f) => o?.[f] !== undefined && o[f] !== null && typeof o[f] !== "object").map((f) => `${f}=${String(o[f]).slice(0, 90)}`).join(" · ").slice(0, 260);
  const lines = arr.slice(0, 40).map((o, i) => `${i + 1}. ${line(o)}`);
  return `${meta ? `${meta}\n` : ""}${lines.join("\n")}${arr.length > 40 ? `\n… and ${arr.length - 40} more` : ""}`;
}

// A long connector result goes to a file on the agent's own computer (NIGHT_PLAN_NOV9 §1). The model reads the
// start, the record count and the path, and works on the file there with computer_bash when it needs the rest.
async function capResult(ctx: ToolContext, t: ConnectorTool, r: ToolResult, callId: string): Promise<ToolResult & { chars: number; saved?: string }> {
  const chars = r.text.length;
  if (r.isError || chars <= RESULT_CAP) return { ...r, chars };
  const n = recordCount(r.text);
  const head = compactList(r.text) ?? r.text.slice(0, 3000);
  const path = `/work/${ctx.sessionId}/results/${t.server}-${t.tool}-${callId.slice(-8)}.${n === null ? "txt" : "json"}`;
  const write = computerTools.find((x) => x.name === "computer_write");
  try {
    const w = write ? await write.run(ctx, { path, content: r.text }) : { text: "no computer", isError: true };
    if (w.isError) throw new Error(w.text);
    return { ...r, chars, saved: path, text: `${head}\n…\n[peeblo: the full result is ${chars.toLocaleString("en-US")} characters${n !== null ? `, ${n} records` : ""}, saved on your computer at ${path}. The lines above are every record's key fields; answer from them when they're enough, and open the file (computer_bash with jq) only for a field they don't show.]` };
  } catch {
    return { ...r, chars, text: `${r.text.slice(0, RESULT_CAP)}\n…\n[peeblo: cut at ${RESULT_CAP.toLocaleString("en-US")} of ${chars.toLocaleString("en-US")} characters${n !== null ? ` (${n} records)` : ""}. Ask for fewer fields or a smaller page.]` };
  }
}

// The repos an unscoped GitHub connection can see, read once every 30 minutes (get_me, then one search), so agents
// use exact owner/repo names instead of guessing. It never blocks a session start: until the first read lands (it's
// warmed when core starts), the tools carry the "find the owner first" line instead.
let ghSeen: { at: number; text: string } | null = null;
let ghLoading: Promise<string> | null = null;
async function githubVisible(tools: ConnectorTool[]): Promise<string> {
  const me = tools.find((t) => t.server === "github" && t.tool === "get_me");
  const search = tools.find((t) => t.server === "github" && t.tool === "search_repositories");
  if (!me || !search) return "";
  if (ghSeen && Date.now() - ghSeen.at < 30 * 60_000) return ghSeen.text;
  ghLoading ??= (async () => {
    const who = JSON.parse(mcpText((await executeTool(me, {})).data).text);
    const login = String(who.login ?? who.user?.login ?? "");
    if (!login) return "";
    const found = JSON.parse(mcpText((await executeTool(search, { query: `user:${login} fork:true`, sort: "updated", perPage: 30 })).data).text);
    const names = (found.items ?? found.repositories ?? found ?? []).map((x: any) => x.full_name ?? x.fullName ?? (x.owner?.login && x.name ? `${x.owner.login}/${x.name}` : null)).filter(Boolean);
    ghSeen = { at: Date.now(), text: names.slice(0, 30).join(", ") };
    return ghSeen.text;
  })().catch(() => ghSeen?.text ?? "").finally(() => { ghLoading = null; });
  return ghSeen?.text ?? "";
}
export async function warmGithubVisible(): Promise<void> {
  const peeblo = await getTeammate("peeblo");
  if (peeblo) await githubVisible((await catalogFor(peeblo.config)).tools).catch(() => "");
}
