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
import { ALWAYS_REFUSES, catalogFor, classify, executeTool, forgetServer, githubLimit, markUnavailable, needsApproval, outOfScope, type ConnectorTool } from "../connectors/mcp.ts";
import { pool } from "../db.ts";
import { askApproval, fingerprint } from "../durable/approvals.ts";
import { argClass, modeRule, NEVER_WITHOUT_ASKING, review, riskOf } from "../rules/reviewer.ts";
import { screen, wrapUntrusted } from "../rules/guard.ts";
import { newId } from "../ids.ts";
import { appendEvent } from "../store/events.ts";
import { getPerson } from "../store/people.ts";
import { getSession } from "../store/sessions.ts";
import { getTeammate, teammateAt, type Teammate } from "../store/teammates.ts";
import { isOtariAdmin } from "../rules/authority.ts";
import { countRepeat, forgetOld, identical, isLoop, LOOP_NUDGE, POLL_GAP_MS, POLL_STOP, readCache } from "./loops.ts";
import { capResult, firewallHint, githubVisible, hintFor, mcpText, OUTSIDE, summarize, urlsIn } from "./results.ts";

// A session keeps its config, but a lower mode applies at once: the gate uses the stricter of the
// session's mode and the teammate's current one. The tool list never changes within a session.
const STRICTNESS = ["ask", "auto", "trusted", "yolo"] as const;
export async function effectiveMode(pinned: Teammate): Promise<Teammate["config"]["mode"]> {
  const now = await getTeammate(pinned.id);
  const a = STRICTNESS.indexOf(pinned.config.mode);
  const b = now ? STRICTNESS.indexOf(now.config.mode) : a;
  return STRICTNESS[Math.min(a, b)];
}
import type { Binding } from "./relay.ts";

const json = (res: ServerResponse, status: number, body: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

// An approval waits 30 minutes while someone is in the conversation, 12 hours for an unattended run (a schedule,
// a trigger, or a teammate it called).
async function approvalTtl(runId: string): Promise<number> {
  const { isUnattended } = await import("../rules/approvers.ts");
  return (await isUnattended(runId)) ? 12 * 3600 : config.approvalTtlSeconds;
}

// A plan a person approved in this job (plan_approval) covers the tools its steps named.
async function planCovers(runId: string | null, tool: string): Promise<boolean> {
  if (!runId) return false;
  return Boolean((await pool.query("SELECT 1 FROM events WHERE run_id = $1 AND type = 'plan.approved' AND data->'tools' ? $2 LIMIT 1", [runId, tool])).rowCount);
}

async function granted(teammateId: string, runId: string | null, fp: string): Promise<boolean> {
  const { rows } = await pool.query(
    "SELECT 1 FROM grants WHERE teammate_id = $1 AND fingerprint = $2 AND revoked_at IS NULL AND (scope = 'always' OR (scope = 'job' AND run_id = $3)) LIMIT 1",
    [teammateId, fp, runId],
  );
  return rows.length > 0;
}

// Writes in a session run one at a time, whatever the model sends in parallel.
const writeLocks = new Map<string, Promise<unknown>>();
async function oneAtATime<T>(sessionId: string, f: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(sessionId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(f);
  writeLocks.set(sessionId, next.catch(() => {}));
  return next;
}

// Invalid arguments get one retry with the reason; a second failure in a row stops the tool for the turn.
const invalidStreak = new Map<string, number>();

type Listed = { name: string; description: string; input_schema: unknown; asks: boolean; direct: boolean };

// a session starts with Peeblo's own tools and only the few connector tools this teammate uses most
// (from its own history; for a new teammate, the first reads). The rest are found with find_tools.
// Connector tools all start deferred (the small start set); find_tools finds what a job needs, use_tool calls it.
const DIRECT_CONNECTOR_TOOLS = 0;
async function mostUsed(teammateId: string, names: string[]): Promise<Set<string>> {
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

  if (req.method === "POST" && path === "/compacted") {
    const { summary } = JSON.parse(body?.toString("utf8") || "{}");
    const s = await getSession(b.sessionId);
    if (s && typeof summary === "string") {
      const { placeOfSession, writeNote } = await import("../memory/store.ts");
      const day = new Date().toISOString().slice(0, 10);
      await writeNote(tm.slug, placeOfSession(s), { path: `jobs/${day}-${(b.runId ?? b.sessionId).replace(/^[a-z]+_/, "")}-notes`, title: `${day} · notes from a long job`, body: summary.slice(0, 7_500), source: "compaction summary", runId: b.runId, tainted: false }).catch(() => {});
      await appendEvent({ sessionId: b.sessionId, runId: b.runId, type: "pi.compacted", data: { chars: summary.length } }).catch(() => {});
    }
    return json(res, 200, { ok: true });
  }

  if (req.method === "GET" && path === "/tools") {
    const cat = await catalogFor(tm.config);
    const direct = await mostUsed(tm.id, cat.tools.map((t) => t.name));
    // A scoped GitHub connector names its repos, so the model never guesses an owner.
    const ownRepos = tm.config.connector_scopes?.github ?? [];
    const scoped = ownRepos.length ? ownRepos : config.githubRepos;
    const visible = scoped.length ? "" : await githubVisible(cat.tools);
    const repos = scoped.length ? `This teammate's GitHub repos (owner/repo): ${scoped.join(", ")}. Use these names exactly.`
      : visible ? `Repos this GitHub connection can see (owner/repo, most recently updated first): ${visible}. Use these names exactly; never guess an owner.`
      : "Never guess a repo's owner: unless you know the exact owner/repo, find it first with search_repositories (user:<login> from get_me, or org:<org>).";
    const tools: Listed[] = [
      ...own.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema, asks: t.kind === "write", direct: !t.deferred })),
      ...cat.tools.filter((t) => !subagent || classify(t, {}) === "read").map((t) => ({ name: t.name, description: t.server === "github" && repos ? `${t.description}\n${repos}` : hintFor(t.server, t.tool) ? `${t.description}\n${hintFor(t.server, t.tool)}` : t.description, input_schema: t.inputSchema, asks: needsApproval(tm.config.mode, classify(t, {})), direct: direct.has(t.name) })),
    ];
    return json(res, 200, { tools, missing: cat.missing, failed: cat.failed });
  }
  if (req.method !== "POST" || path !== "/tools/call") return json(res, 404, { detail: "no such tool route" });
  // A call can wait on a person's card for up to 30 minutes; the agent's HTTP client gives up on a request with no
  // response after 5. Send the headers now and a space every minute until the answer (leading spaces are valid JSON).
  res.writeHead(200, { "content-type": "application/json" });
  const keep = setInterval(() => { try { res.write(" "); } catch { /* closed */ } }, 60_000);
  const end = res.end.bind(res);
  res.writeHead = (() => res) as any;
  res.end = ((chunk?: any, ...rest: any[]) => { clearInterval(keep); return (end as any)(chunk, ...rest); }) as any;
  req.on("close", () => clearInterval(keep));

  const { name, arguments: args = {}, tool_call_id: toolCallId = newId("tc") } = JSON.parse(body?.toString("utf8") || "{}");
  const person = b.personId ? await getPerson(b.personId) : null;
  const ctx: ToolContext = { teammate: tm, person, sessionId: b.sessionId, runId: b.runId, endUser: b.endUser, toolCallId, otariKey: b.otariKey && b.keyId ? { keyId: b.keyId, secret: b.otariKey } : null, subagent };
  const ownTool = own.find((t) => t.name === name);
  const connector = ownTool ? undefined : (await catalogFor(tm.config)).tools.find((x) => x.name === name);
  if (!ownTool && !connector) return json(res, 200, { text: `There is no tool called ${name} in this session. Use one of the tools you were given.`, isError: true });

  const base: Record<string, unknown> & { by: "peeblo"; id: string; tool: string } = { turn: b.turn, by: "peeblo", id: toolCallId, tool: name, args_fingerprint: fingerprint(args), args_preview: JSON.stringify(args ?? {}).slice(0, 300), asked_by: person?.id ?? null, end_user: b.endUser };
  const event = (data: Record<string, unknown> & { status: string }) => appendEvent({ sessionId: b.sessionId, runId: b.runId, type: "tool.call", data: { ...base, ...data } }).catch(() => {});
  // A call that already ran (Pi resent it after a restart): anything that changes something runs once; the agent
  // gets what it did back.
  if (!(ownTool?.kind === "read") && b.runId) {
    const done = (await pool.query("SELECT data->>'summary' AS summary FROM events WHERE run_id = $1 AND type = 'tool.call' AND data->>'id' = $2 AND data->>'status' = 'completed' LIMIT 1", [b.runId, toolCallId]).catch(() => ({ rows: [] as any[] }))).rows[0];
    if (done) return json(res, 200, { text: `[peeblo: this exact call already ran before Peeblo restarted; it isn't run twice.] ${done.summary ?? "It completed."}` });
  }
  // Loop limits, the same on every model: the 3rd identical call in a run gets a factual note, the 6th
  // stops the run.
  // Free-text fields some servers ask for (Resend's "context", "conversation_id", "llm_model") change every call,
  // so they don't count when deciding whether a call is a repeat.
  const NOTE_KEYS = new Set(["context", "conversation_id", "llm_model", "reason_for_call", "intent_note"]);
  const loopArgs = Object.fromEntries(Object.entries((args ?? {}) as Record<string, unknown>).filter(([k]) => !NOTE_KEYS.has(k)));
  const repeatKey = `${b.runId}:${name}:${fingerprint(loopArgs)}`;
  const now = Date.now();
  forgetOld(now);
  const rep = countRepeat(identical.get(repeatKey), now);
  identical.set(repeatKey, rep);
  const repeats = rep.rapid;
  if (isLoop(rep)) {
    b.stuck = { runId: b.runId, reason: `the same ${name} call ${rep.total >= POLL_STOP ? rep.total : repeats} times` };
    await event({ status: "refused", reason: "loop limit" });
    await appendEvent({ sessionId: b.sessionId, runId: b.runId, type: "run.stuck", data: { reason: b.stuck.reason } });
    return json(res, 200, { text: `Stopped: this exact ${name} call has been made ${repeats} times in this run. Tell the person what you were trying and what kept happening.`, isError: true });
  }
  // The final status turn after a stop: only the status post.
  if (b.finalStatus?.runId === b.runId && name !== "slack_post") return json(res, 200, { text: "This job has stopped. Post your status with slack_post now; nothing else.", isError: true });
  const hit = repeats >= 2 ? readCache.get(repeatKey) : undefined;
  const cached = hit && now - hit.at < POLL_GAP_MS ? hit.text : undefined;
  if (cached !== undefined) {
    await event({ status: "completed", reused: true });
    return json(res, 200, { text: `[peeblo: you made this exact call seconds ago in this job; here is the same result again.]\n${cached}` });
  }
  const note = repeats >= LOOP_NUDGE ? `\n[peeblo: this is the ${repeats}${repeats === 3 ? "rd" : "th"} identical ${name} call in this run; the result will not change.]` : "";
  const reply = (r: ToolResult) => json(res, 200, { text: r.text + note, isError: Boolean(r.isError), ...(r.endTurn && !r.isError ? { terminate: true } : {}) });

  // Untrusted results are labelled with their source and screened; a flag is appended as a warning.
  const finish = async (r: ToolResult, source: string | null, extra: Record<string, unknown>) => {
    let text = r.text;
    let screened = null;
    if (source && !r.isError) {
      // Only text from outside the company is screened (customer tickets and chats, web pages and scrapers, other
      // people's files, other bots): internal tools stay labelled as untrusted but cost no guard call.
      screened = OUTSIDE.test(source) ? await screen(text, b.endUser).catch(async () => (await import("../rules/guard.ts")).unchecked()) : null;
      // On the receipt: which guard checked this outside text, and what it said.
      if (screened?.checked_by) await appendEvent({ sessionId: b.sessionId, runId: b.runId, type: "guard.checked", data: { checked_by: screened.checked_by, safe: !screened.flagged, source, score: screened.score, request_id: screened.requestId ?? null, ...(screened.disputed ? { disputed: screened.disputed } : {}) } }).catch(() => {});
      text = wrapUntrusted(text, source, screened);
    }
    if (!r.isError && (extra.kind ?? base.kind) === "read") {
      if (readCache.size > 2000) readCache.clear();
      readCache.set(repeatKey, { text, at: Date.now() });
    } else if (!r.isError && name !== "slack_post") {
      // Anything that changed something makes this job's earlier reads stale: the next read asks again.
      for (const k of readCache.keys()) if (k.startsWith(`${b.runId}:`)) readCache.delete(k);
      for (const k of identical.keys()) if (k.startsWith(`${b.runId}:`) && !k.startsWith(`${b.runId}:${name}:`)) identical.delete(k);
    }
    await event({ status: r.isError ? "failed" : "completed", ...extra, ...(r.isError ? { error: r.text.slice(0, 500) } : { summary: summarize(r.text), lines: r.text.split("\n").filter((l) => /^\s*(- |• |\d+\. )/.test(l)).length, sources: urlsIn(r.text) }), untrusted: source, guard: screened ? { checked_by: screened.checked_by, flagged: screened.flagged, score: screened.score, request_id: screened.requestId } : null });
    return reply({ ...r, text });
  };

  if (ownTool) return runOwn(ownTool, ctx, args, base, event, reply, finish, b);
  return runConnector(connector!, ctx, args, base, event, reply, finish, b);
}

async function runOwn(t: AgentTool, ctx: ToolContext, args: any, base: Record<string, unknown>, event: (d: Record<string, unknown> & { status: string }) => Promise<unknown>, reply: (r: ToolResult) => void, finish: (r: ToolResult, source: string | null, extra: Record<string, unknown>) => Promise<void>, b: Binding): Promise<void> {
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
    if ((t.kind === "write" || rule?.ask) && t.name !== "plan_approval" && !(outward && NEVER_WITHOUT_ASKING.includes(outward)) && await planCovers(ctx.runId, t.name)) { base.plan = true; rule = null; }
    else if (t.kind === "write" || rule?.ask) {
      // Otari settings always, and anything the rules say to ask about: a person's yes for this one call.
      if (!ctx.runId) return reply({ text: "This needs a person's approval, and there is no run to ask in.", isError: true });
      if (rule?.ask) base.rule = rule.ask;
      await event({ status: "waiting_approval" });
      const action = { kind: "peeblo_tool", teammate: ctx.teammate.slug, tool: t.name, arguments: args, ...(t.describe ? await t.describe(ctx, args) : {}), asked_by: ctx.person?.id ?? null, ...(outward ? { risk: outward, per_action: NEVER_WITHOUT_ASKING.includes(outward) } : {}) };
      // Own tools ask like connector calls: unattended runs wait 12 h for the owner (approvers: src/rules/approvers.ts).
      const a = await askApproval(ctx.runId, ctx.sessionId, action, await approvalTtl(ctx.runId));
      if (a.status !== "approved") {
        await event({ status: a.status === "expired" ? "expired" : "denied", approval_id: a.approvalId });
        if (a.superseded) return reply({ text: `${a.reason} Nothing ran yet; the old card is closed.`, isError: true });
        return reply({ text: a.status === "expired" ? `Nobody answered the card in time, so ${t.name} did not run and there is no card now. Say so in one line. If they ask again (or say go, approve, do it), call ${t.name} again with the same arguments: that makes a new card. Never say a card is waiting unless you just made one.` : (a.reason ? `They said not now, and why: ${a.reason}. Nothing ran. Reply in one short line, like a colleague who heard them, in your own words (don't quote theirs back; e.g. "Okay, I'll hold off until that's checked."), and don't retry.` : "They said not now, so nothing ran. Say so in one short line and don't retry."), isError: true });
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

async function runConnector(t: ConnectorTool, ctx: ToolContext, args: any, base: Record<string, unknown>, event: (d: Record<string, unknown> & { status: string }) => Promise<unknown>, reply: (r: ToolResult) => void, finish: (r: ToolResult, source: string | null, extra: Record<string, unknown>) => Promise<void>, b: Binding): Promise<void> {
  const tm = ctx.teammate;
  const mode = await effectiveMode(tm);
  base.mode = mode;
  Object.assign(base, { via: "otari_mcp", server: t.server, server_id: t.serverId, server_revision: t.revision });
  const kind = classify(t, args);
  base.kind = kind;
  // A workspace anyone can join (PEEBLO_MEMBER_WRITES=off): only admins' requests change connected tools.
  if (kind !== "read" && !config.memberWrites && !isOtariAdmin(ctx.person)) {
    await event({ status: "refused", reason: "member writes are off" });
    return reply({ text: `Not run: in this workspace only an admin's request can change ${t.server}; anyone can read it. Nothing changed. Tell the person plainly, and show exactly what you would have done (the ${t.tool} call in words, with its values), so they see how it would go.`, isError: true });
  }
  // Internal pages go through their own connector, never a web scraper (that dodges access rules and fails anyway).
  if (["apify", "exa", "context7", "deepwiki"].includes(t.server)) {
    const internal = JSON.stringify(args).match(/https?:\/\/[^"\s]*(notion\.so|notion\.site|atlassian\.net|linear\.app|slack\.com|docs\.google\.com|drive\.google\.com|sanity\.io|hubspot\.com|airtable\.com|monday\.com)[^"\s]*/i);
    if (internal) {
      await event({ status: "refused", reason: "internal page through a web scraper" });
      return reply({ text: `That's an internal page (${internal[1]}); open it with its own connector (find_tools), or say which page and who can share it with Peeblo. Web scrapers aren't for internal docs.`, isError: true });
    }
  }
  const limit = githubLimit(t, args, config.githubRepos);
  if ("refuse" in limit) {
    await event({ status: "refused", reason: limit.refuse });
    return reply({ text: `Not allowed: ${limit.refuse}.`, isError: true });
  }
  args = limit.args;
  const scope = outOfScope(t, args, tm.config.connector_scopes);
  if (scope) {
    await event({ status: "refused", reason: scope });
    return reply({ text: `Not allowed: ${scope}. Ask the teammate's owner to add it.`, isError: true });
  }
  // Read-only connectors (config.read_only, set at hire or by talking): no writes there, whoever asks.
  const readOnly: string[] = kind === "read" ? [] : (((await (await import("../store/teammates.ts")).getTeammate(tm.id))?.config as any)?.read_only ?? (tm.config as any).read_only ?? []);
  if (kind !== "read" && readOnly.includes(t.server)) {
    await event({ status: "refused", reason: `${t.server} is read-only for this teammate` });
    return reply({ text: `Not allowed: ${t.server} is read-only for ${tm.config.name}. Don't try another way; write up what should change for a person (or a teammate with write access) to do.`, isError: true });
  }
  const run = async () => {
    // The gate (src/rules/reviewer.ts): risk class → mode rule → grant → the reviewer in Auto → a card.
    const risk = riskOf(t, args, kind);
    base.risk = risk;
    const blocks = Number((await pool.query("SELECT count(*)::int AS n FROM events WHERE run_id = $1 AND type = 'review.decided' AND data->>'decision' <> 'allow'", [b.runId])).rows[0]?.n ?? 0);
    let rule = kind === "read" ? "allow" : modeRule(blocks >= 3 ? "ask" : mode, risk);
    const toolFp = fingerprint({ teammate: tm.id, server: t.serverId, tool: t.tool, class: argClass(t, args) });
    // Money, deletions, shipping and posts outside the thread are per action: a grant never covers them.
    const perAction = NEVER_WITHOUT_ASKING.includes(risk);
    if (rule !== "allow" && !perAction && b.runId && (await granted(tm.id, b.runId, toolFp))) rule = "allow";
    // An approved plan covers its ordinary steps, never money, deletes, shipping or posts outside the thread.
    if (rule !== "allow" && !perAction && b.runId && (await planCovers(b.runId, t.name))) { rule = "allow"; base.plan = true; }
    // The approvals map (company memory): some writes are a named person's to approve, whatever the reviewer thinks.
    let mapped: { who: string[]; why: string } | null = null;
    if (kind !== "read" && b.runId && !base.plan) {
      const { policyApprovers } = await import("../rules/approvers.ts");
      mapped = await policyApprovers(b.runId, { server: t.server, tool: t.tool, risk, arguments: args }).catch(() => null);
      if (mapped) { rule = "card"; base.rule = `${mapped.why}`; }
    }
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
      // Only a retry: the approved attempt failed and nothing identical has gone through (never a second refund).
      const prior = (await pool.query("SELECT bool_or(data->>'status' = 'failed' AND data->>'approval_id' IS NOT NULL) AS failed, bool_or(data->>'status' = 'completed') AS done FROM events WHERE run_id = $1 AND type = 'tool.call' AND data->>'exact' = $2", [b.runId, exactFp])).rows[0];
      if (prior?.failed && !prior?.done) { rule = "allow"; base.repeat_of_approved = true; }
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
        const action = { kind: "connector_call", teammate: tm.slug, server: t.server, tool: t.tool, arguments: args, server_revision: t.revision, end_user: b.endUser, risk, per_action: perAction, grant_fp: perAction ? null : toolFp, ...(base.reviewer ? { rule: `The reviewer wants a person to decide: ${base.reviewer}` } : {}), ...(mapped ? { approvers: mapped.who, rule: `Why I'm asking: ${mapped.why}` } : {}) };
        // Unattended (a schedule or trigger): only the teammate's owner can answer, and silence means no.
        const ttl = await approvalTtl(b.runId);
        // Who may answer: src/rules/approvers.ts (the owner when unattended, else the person who asked).
        const a = await askApproval(b.runId, b.sessionId, action, ttl);
        if (a.status !== "approved") {
          await event({ status: a.status === "expired" ? "expired" : "denied", approval_id: a.approvalId });
          if (a.superseded) return reply({ text: `${a.reason} Nothing ran yet; the old card is closed.`, isError: true });
          return reply({ text: a.status === "expired" ? `Nobody answered the card in time, so ${t.tool} did not run and there is no card now. Say so in one line. If they ask again (or say go, approve, do it), call ${t.tool} again with the same arguments: that makes a new card. Never say a card is waiting unless you just made one.` : (a.reason ? `They said not now, and why: ${a.reason}. Nothing ran. Reply in one short line, like a colleague who heard them, in your own words (don't quote theirs back; e.g. "Okay, I'll hold off until that's checked."), and don't retry.` : "They said not now, so nothing ran. Say so in one short line and don't retry."), isError: true });
        }
        if (!perAction && (a.scope === "always" || a.scope === "job")) {
          await pool.query("INSERT INTO grants (id, teammate_id, fingerprint, scope, run_id) VALUES ($1, $2, $3, $4, $5)", [newId("gr"), tm.id, toolFp, a.scope, a.scope === "job" ? b.runId : null]);
        }
        base.approval_id = a.approvalId;
        if (a.arguments) { args = a.arguments; base.edited = true; base.args_preview = JSON.stringify(args ?? {}).slice(0, 300); }
      }
    }
    const t0 = Date.now();
    // On the teammate's own key where Otari holds its access (so Otari sees who called), else the core key.
    const { ownKeyServers } = await import("../otari/mcp-access.ts");
    const own = b.otariKey && ownKeyServers(tm.id, b.keyId).has(t.server) ? { authorization: `Bearer ${b.otariKey}` } : undefined;
    base.otari_key = own ? "teammate" : "core";
    try {
      const { data, requestId } = await executeTool(t, args, own);
      const r = await capResult(ctx, t, mcpText(data), toolCallIdOf(base));
      // The person changed the call on its card: the model hears what actually ran, so a retry keeps their edits.
      if (base.edited) r.text = `[The approver edited this call before it ran; it ran with: ${JSON.stringify(args).slice(0, 600)}. Keep their values in anything you redo.]\n${r.text}`;
      if (r.isError && ALWAYS_REFUSES.test(r.text)) markUnavailable(t.server, t.tool); // the server refuses this tool for good
      return finish(r, `mcp:${t.server}.${t.tool}`, { request_id: requestId, ms: Date.now() - t0, result_chars: r.chars, ...(r.saved ? { saved_to: r.saved } : {}) });
    } catch (error) {
      const e = error as Error & { status?: number; requestId?: string | null; code?: string | null };
      if (e.status === 409 || /revision/i.test(e.message)) forgetServer(t.serverId);
      await event({ status: "failed", request_id: e.requestId ?? null, ms: Date.now() - t0, error: e.message.slice(0, 500), error_code: e.code ?? null });
      if (/403/.test(e.message) && /<html|nginx|403 Forbidden/i.test(e.message)) return reply({ text: firewallHint(t), isError: true });
      // Otari's own access rule for this teammate's key (set from its connectors and read-only list).
      if (own && /not allowed for this MCP server/i.test(e.message)) return reply({ text: `Otari doesn't let you use ${t.tool} on ${t.server}: your access there is read-only, set by your owner. Nothing ran. Say so plainly; if they want the write, they can ask Peeblo to change your access.`, isError: true });
      return reply({ text: `The ${t.server} call failed: ${e.message.slice(0, 400)}${base.edited ? ` (It had the approver's edits: ${JSON.stringify(args).slice(0, 400)}. Keep their values if you try another way.)` : ""}`, isError: true });
    }
  };
  return kind === "read" ? run() : oneAtATime(b.sessionId, run);
}

const toolCallIdOf = (base: Record<string, unknown>) => String(base.id ?? newId("tc"));

