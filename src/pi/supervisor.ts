// The turn loop: each job's turns on its session's Pi (src/pi/sessions.ts), with the facts of the moment
// (src/pi/notes.ts), the model for the job, steering, resuming after a restart, limits, and the Stop check
// (src/pi/stop-check.ts). Every person's text is wrapped, so text starting with "/" can never run a Pi command.
import { DBOS } from "@dbos-inc/dbos-sdk";
import { config } from "../config.ts";
import { pool } from "../db.ts";
import { setRunExecutor, type RunContext } from "../durable/runs.ts";
import { budgetReply } from "../otari/people.ts";
import { ensureEndUser } from "../otari/people.ts";
import { teammateKey } from "../otari/spend.ts";
import { bindRun } from "../proxy/relay.ts";
import { appendEvent } from "../store/events.ts";
import { getPerson } from "../store/people.ts";
import { getTeammate, teammateAt, type Teammate } from "../store/teammates.ts";
import { TurnTimeout } from "./rpc.ts";
import { live, personSteers, piFor, touch, type Live } from "./sessions.ts";
import { feedbackNote, liveThreadsNote, otariToolNote, personNote, rosterNote } from "./notes.ts";
import { stopCheck } from "./stop-check.ts";
import { blockedReply, freshLakeraState, guardMode, screenOpen } from "../guard.ts";

// A session keeps the config version it started with: instructions, model and tools don't change under a
// running conversation. A person can move a session onto a newer version now (a takeover); the next turn
// then starts with a note saying what changed.
async function sessionConfig(sessionId: string, runId: string, current: Teammate): Promise<{ tm: Teammate; note: string }> {
  const { rows } = await pool.query("SELECT id, data FROM events WHERE session_id = $1 AND type = 'session.config' ORDER BY id DESC LIMIT 1", [sessionId]);
  if (!rows[0]) {
    await appendEvent({ sessionId, runId, type: "session.config", data: { version: current.version, model: current.config.model.default, reason: "start" } });
    return { tm: current, note: "" };
  }
  let pinned = (await teammateAt(current.id, rows[0].data.version)) ?? current;
  let note = "";
  // Tools and connectors granted since the session started reach it now (a grant is meant for the work in hand);
  // instructions and model stay pinned until a takeover.
  if (current.version > pinned.version) {
    const set = (c: any) => new Set<string>([...(c.tools ?? []), ...(c.connectors ?? [])]);
    const before = set(pinned.config), after = set(current.config);
    const added = [...after].filter((x) => !before.has(x)), removed = [...before].filter((x) => !after.has(x));
    if (added.length || removed.length) {
      pinned = { ...current, config: { ...current.config, instructions: pinned.config.instructions, model: pinned.config.model } } as Teammate;
      await appendEvent({ sessionId, runId, type: "session.config", data: { version: current.version, model: pinned.config.model.default, reason: "grant", added, removed } });
      note = `<peeblo_event kind="tools_changed">${added.length ? `You now have: ${added.join(", ")} (find their tools with find_tools).` : ""}${removed.length ? ` No longer available: ${removed.join(", ")}.` : ""}</peeblo_event>\n`;
      return { tm: pinned, note };
    }
  }
  if (rows[0].data.reason === "takeover") {
    const { rows: done } = await pool.query("SELECT 1 FROM events WHERE session_id = $1 AND type = 'turn.finished' AND id > $2 LIMIT 1", [sessionId, rows[0].id]);
    if (!done.length) note = `<peeblo_event kind="model_change">From this message on you run on ${pinned.config.model.default} (changed by ${rows[0].data.by ?? "a person"}${rows[0].data.why ? `: ${rows[0].data.why}` : ""}). Everything earlier in this conversation still stands.</peeblo_event>\n`;
  }
  return { tm: pinned, note };
}

// A message the guardrail refused must not stay in the history, or every later turn is refused for it too.
// Fork back to just before it; Pi carries on in a new session file, which Peeblo records.
async function dropRefusedTurn(l: Live, sessionId: string, runId: string): Promise<void> {
  const e = await l.rpc.send<{ entries: any[] }>("get_entries");
  const lastUser = [...(e.entries ?? [])].reverse().find((x) => x.type === "message" && x.message?.role === "user");
  if (!lastUser) return;
  await l.rpc.send("fork", { entryId: lastUser.id });
  const st = await l.rpc.send<{ sessionId?: string }>("get_state");
  if (st.sessionId) await appendEvent({ sessionId, runId, type: "pi.session", data: { pi_session_id: st.sessionId, reason: "guard_blocked", dropped_entry: lastUser.id } });
}


// Routing at the job boundary, the way coding agents run: a strong model for the main loop of hard work, the
// everyday model for the rest, chosen once per job by Otari's router (switching mid-job would throw away the prompt
// cache). A job the Stop check sends back moves up to the strong model for the rest of it.
const jobModels = new Map<string, string>();
function escalateJob(runId: string): void { jobModels.set(runId, "peeblo-heavy"); }
async function modelForJob(ctx: RunContext, tm: Teammate, turnNo: number, internal?: string): Promise<string> {
  const base = ((ctx.session.place ?? {}) as { model?: string | null }).model || tm.config.model.default;
  const known = jobModels.get(ctx.run.id);
  if (known) return known;
  // Only when the teammate runs on the everyday role (a person-chosen model stays), and only for real work.
  const subagent = Boolean((ctx.session.place as any)?.subagent_of);
  const eligible = turnNo === 1 && !internal && !subagent && base === "peeblo-worker" && config.jobRouting && ctx.text.replace(/<[^>]+>/g, "").trim().length >= 80;
  let pick = base;
  if (eligible) {
    const { recommend, ROLES } = await import("../otari/routing.ts");
    const person = ctx.personId ? await getPerson(ctx.personId) : null;
    const r = await recommend({ sessionId: ctx.session.id, toolUseId: `job-${ctx.run.id}`, agentType: "job", description: ctx.text.slice(0, 200), prompt: ctx.text.slice(0, 4000), parentModel: ROLES["peeblo-worker"].default, endUser: person?.end_user_id ?? undefined,
      candidates: {
        [ROLES["peeblo-worker"].default]: "everyday work: lookups, summaries, drafts, routine tool use, short analysis; fast and cheap",
        [ROLES["peeblo-heavy"].default]: "the strongest open model, many times the price: hard reasoning over many steps, code changes in a repo, debugging, reconciling sources that disagree, long plans",
      } });
    if (!r.fallback && r.model === ROLES["peeblo-heavy"].default) pick = "peeblo-heavy";
    await appendEvent({ sessionId: ctx.session.id, runId: ctx.run.id, type: "job.model", data: { model: pick, by: "otari_router", probabilities: r.probabilities, reason: r.reason, request_id: r.requestId, fallback: r.fallback } }).catch(() => {});
  }
  jobModels.set(ctx.run.id, pick);
  if (jobModels.size > 5000) jobModels.delete(jobModels.keys().next().value!);
  return pick;
}

// A Pi message's text, whether its content is a string or a list of parts.
function userText(m: { content?: unknown }): string {
  return typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("") : "";
}

async function turn(ctx: RunContext, turnNo: number, internal?: string): Promise<{ text: string; stopReason: string | null }> {
  const current = await getTeammate(ctx.session.teammate_id);
  if (!current) throw new Error("teammate is gone");
  const { tm, note: changeNote } = await sessionConfig(ctx.session.id, ctx.run.id, current);
  if (turnNo === 1 && !internal) {
    const waiting = (await pool.query(
      `SELECT a.id, a.run_id FROM approvals a JOIN runs r ON r.id = a.run_id
        WHERE r.session_id = $1 AND a.status = 'pending' AND a.run_id <> $2 AND a.expires_at > now() AND r.status IN ('running', 'waiting') ORDER BY a.created_at DESC LIMIT 1`, [ctx.session.id, ctx.run.id])).rows[0];
    if (waiting) {
      const who = ctx.run.submission_id ? (await pool.query("SELECT p.id, p.display_name FROM submissions s LEFT JOIN people p ON p.id = s.person_id WHERE s.id = $1", [ctx.run.submission_id])).rows[0] : null;
      const name = String(who?.display_name ?? "The person").split(" ")[0];
      await DBOS.send(waiting.id, { decision: "denied", scope: "once", personId: who?.id ?? null, superseded: true,
        reason: `${name} replied before deciding: "${ctx.text.slice(0, 600)}". Change your draft to fit what they said and ask again; answer them in one line.` }, "approval", `supersede:${waiting.id}:${ctx.run.id}`);
      await appendEvent({ sessionId: ctx.session.id, runId: ctx.run.id, type: "run.merged", data: { into: waiting.run_id, approval_id: waiting.id } });
      return { text: "", stopReason: "merged" };
    }
  }
  // One event per execution of the turn step: a second one means the turn resumed after core restarted.
  const attempts = Number((await pool.query("SELECT count(*)::int n FROM events WHERE run_id = $1 AND type = 'turn.attempt' AND (data->>'turn')::int = $2", [ctx.run.id, turnNo])).rows[0].n);
  await appendEvent({ sessionId: ctx.session.id, runId: ctx.run.id, type: "turn.attempt", data: { turn: turnNo, pid: process.pid } });
  // A turn run again after a restart: a write that was waiting for a person is named, so the agent calls it again
  // (the call joins the same card; nothing runs twice).
  let resumeNote = "";
  let resuming = false;
  if (attempts > 0) {
    const waiting = (await pool.query(`SELECT a.action, a.status FROM approvals a WHERE a.run_id = $1 AND a.status IN ('pending', 'approved')
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.run_id = $1 AND e.type = 'tool.call' AND e.data->>'approval_id' = a.id)`, [ctx.run.id])).rows;
    if (waiting.length) resumeNote = `<peeblo_event kind="resumed">Peeblo restarted during this job. ${waiting.map((w) => `Your ${w.action.server ? `${w.action.server} ` : ""}${String(w.action.tool ?? "").replace(/^[a-z]+__/, "")} call with ${JSON.stringify(w.action.arguments ?? {}).slice(0, 300)} was ${w.status === "approved" ? "approved but hasn't run" : "waiting for a person"}`).join("; ")}. Make that same call again with the same arguments: it uses the same approval, so it runs once. Then carry on.</peeblo_event>\n`;
  }
  const person = ctx.personId ? await getPerson(ctx.personId) : null;
  if (person?.end_user_id && config.otariKeyKind === "service") await ensureEndUser(person.end_user_id, person.display_name, config.otariEndUserBudget || undefined, (await teammateKey(tm)) ?? undefined);
  // Receipts say whether Otari's org guardrail screened the turn; read its state fresh for each turn.
  if (guardMode() === "lakera") await freshLakeraState(0);
  // The open guard also screens the person's own message before the teammate sees it.
  if (guardMode() === "open" && !internal) {
    // The guard fails closed: one retry, then the message is not acted on (and the person is told why).
    const screenOnce = () => screenOpen(ctx.session.id, ctx.run.id, person?.end_user_id ?? null, tm.slug, ctx.text);
    const tG = Date.now();
    const g = await screenOnce().catch(() => screenOnce()).finally(() => { if (Date.now() - tG > 1000) console.error(`slow: guard ${Date.now() - tG} ms`); }).catch(async (e) => {
      await appendEvent({ sessionId: ctx.session.id, runId: ctx.run.id, type: "guard.unavailable", data: { checked_by: config.guardModel, error: (e as Error).message.slice(0, 300) } });
      return null;
    });
    if (!g) return { text: `I couldn't get this message checked by the guardrail (${config.guardModel} didn't answer), so I haven't acted on it. Please try again in a moment.`, stopReason: "guard_unavailable" };
    if (!g.safe) return { text: blockedReply(config.guardModel), stopReason: "guard_blocked" };
  }
  // Budgets are enforced by the proxy on every model call (before it reaches Otari), not here.
  const tPi = Date.now();
  const l = await piFor(ctx.session.id, tm);
  if (Date.now() - tPi > 1000) console.error(`slow: pi start ${Date.now() - tPi} ms`);
  const from = person ? `${person.display_name ?? person.slack_user} (${person.slack_user})` : "api";
  const wrapped = `<message from="${from.replace(/"/g, "'")}">${ctx.text}</message>`;
  // A message in this conversation while another job is mid-turn goes into that job (Pi's steer: after its current
  // tool calls, before its next model call), the way a person speaks up while a colleague works. Queued behind the
  // job instead, it would wait until the job ends.
  if (turnNo === 1 && !internal && l.busy && l.runId && l.runId !== ctx.run.id) {
    const into = l.runId;
    const ok = await l.rpc.send("steer", { message: `<peeblo_event kind="mid_job">This message arrived while you were working on the job above. If it's a question, answer it in a line with slack_post (more: true); if it changes the ask, change course; then carry on.</peeblo_event>\n${wrapped}` }).then(() => true, () => false);
    if (ok) {
      personSteers.set(ctx.session.id, Date.now());
      await appendEvent({ sessionId: ctx.session.id, runId: ctx.run.id, type: "run.merged", data: { into, steered: true } });
      return { text: "", stopReason: "merged" };
    }
  }
  // The model for this job: chosen once at its start (and kept, for the prompt cache), moved up when it struggles.
  const want = await modelForJob(ctx, tm, turnNo, internal).catch(() => null);
  if (want && want !== l.model) {
    await l.rpc.send("set_model", { provider: "otari", modelId: want }).then(() => { l.model = want; }, (e) => console.error(`pi: set_model ${want} failed: ${(e as Error).message}`));
  }
  // A turn run again after a restart whose message Pi already has: the work above it is real, so the agent is told to
  // carry on, not handed the same request a second time.
  if (attempts > 0 && !internal) {
    const msgs = await l.rpc.send<{ messages?: any[] }>("get_messages").catch(() => ({ messages: [] as any[] }));
    const has = (msgs.messages ?? []).some((m) => m.role === "user" && userText(m).includes(ctx.text.slice(0, 400)));
    if (has) resumeNote ||= `<peeblo_event kind="resumed">Peeblo restarted while you were working on the message above. Everything you did before is real and still stands; don't redo it. Check where you were (your plan, your files, what you posted) and carry on.</peeblo_event>\n`;
    if (has) resuming = true;
  }
  const job = l.queue.then(async () => {
    bindRun(l.token, ctx.run.id, person?.end_user_id ?? null, turnNo, person?.id ?? null);
    touch(ctx.session.id, l);
    l.busy = (l.busy ?? 0) + 1;
    l.runId = ctx.run.id;
    // No wall clock on real work, only a hard limit (hours) for a job that never ends. Time waiting on a person's
    // answer (an open approval card for this run) doesn't count toward it.
    const settled = l.rpc.settled(config.turnTimeoutMs, async () => Boolean((await pool.query(
      "SELECT 1 FROM approvals WHERE run_id = $1 AND status = 'pending' AND expires_at > now() - interval '1 minute' LIMIT 1", [ctx.run.id])).rowCount));
    // A long job gets a checkpoint now and then: a note steered in between tool calls (nothing is interrupted), so the
    // person hears where things stand.
    const t0 = Date.now();
    const progress = setInterval(() => {
      void l.rpc.send("steer", { message: `<peeblo_event kind="checkpoint">You have been working on this for about ${Math.round((Date.now() - t0) / 60_000)} minutes. If the person would want to know where things stand, post one short progress line with slack_post (more: true). Then carry on.</peeblo_event>` }).catch(() => {});
    }, config.progressEveryMs);
    let snapshotAfter: (() => Promise<number>) | null = null;
    const { repoFacts, snapshotWip } = await import("../environment/repos.ts");
    const repoNote = tm.config.tools.includes("computer") ? await repoFacts(tm, ctx.session.id).catch(() => "") : "";
    // A fact for channel sessions: this message wasn't addressed to the teammate.
    const slackPlace = (ctx.session.place as any)?.slack;
    const channelNote = slackPlace && !slackPlace.direct ? `<peeblo_event kind="reading_along">This is a message in a channel you're reading along in. No one tagged or DMed you; it is addressed to the channel${/<@U[A-Z0-9]+>/.test(ctx.text) ? " (and to the people it tags, who aren't you)" : ""}.</peeblo_event>\n` : "";
    const tNote = Date.now();
    const note = (tm.config.tools.some((t) => t === "web" || t === "code") ? await otariToolNote(ctx.session.id, ctx.run.id) : "") + (await liveThreadsNote(ctx.session.id, tm.id)) + repoNote + channelNote
      + (await feedbackNote(ctx.session.id, ctx.run.id, tm.id)) + (await personNote(ctx, tm, person)) + (slackPlace && !slackPlace.direct ? await rosterNote(slackPlace) : "");
    if (Date.now() - tNote > 1000) console.error(`slow: turn notes ${Date.now() - tNote} ms`);
    snapshotAfter = () => snapshotWip(tm.id, ctx.session.id).catch(() => 0);
    // A continuation from the Stop check is Peeblo's own note, not a person's message.
    let timedOut = false;
    try {
      await l.rpc.send("prompt", { message: internal ?? (resuming ? `${resumeNote}${changeNote}${note}` : `${resumeNote}${changeNote}${note}${wrapped}`) });
      await settled;
    } catch (e) {
      if (!(e instanceof TurnTimeout)) throw e;
      // The hard limit: stop Pi (it would go on working and spending), then the run ends with a status turn.
      timedOut = true;
      await l.rpc.send("abort").catch(() => null);
      await appendEvent({ sessionId: ctx.session.id, runId: ctx.run.id, type: "run.time_limit", data: { minutes: Math.round(config.turnTimeoutMs / 60_000) } }).catch(() => {});
    } finally {
      clearInterval(progress);
    }
    // Uncommitted work in the session's checkouts is saved after every turn (refs/peeblo/wip/<session>).
    await snapshotAfter?.();
    const text = (await l.rpc.send<{ text?: string }>("get_last_assistant_text"))?.text ?? "";
    const msgs = await l.rpc.send<{ messages?: any[] }>("get_messages").catch(() => ({ messages: [] as any[] }));
    const lastAssistant = [...(msgs.messages ?? [])].reverse().find((m) => m.role === "assistant");
    let blocked = false;
    let money: any = null;
    let stuck: any = null;
    if (lastAssistant?.stopReason === "error") {
      const { rows } = await pool.query("SELECT type, data FROM events WHERE run_id = $1 AND type IN ('guard.blocked', 'budget.blocked', 'run.stuck') ORDER BY id DESC", [ctx.run.id]);
      blocked = rows.some((r) => r.type === "guard.blocked");
      money = rows.find((r) => r.type === "budget.blocked")?.data ?? null;
      stuck = rows.find((r) => r.type === "run.stuck")?.data ?? null;
      if (blocked) await dropRefusedTurn(l, ctx.session.id, ctx.run.id);
    }
    return { text, stopReason: timedOut ? "time_limit" : (lastAssistant?.stopReason ?? null), error: lastAssistant?.errorMessage ?? null, blocked, money, stuck };
  });
  void job.finally(() => { l.busy = Math.max(0, (l.busy ?? 1) - 1); if (l.runId === ctx.run.id) l.runId = undefined; touch(ctx.session.id, l); }).catch(() => {});
  l.queue = job.catch(() => {});
  const r = await job;
  if (r.blocked) return { text: blockedReply("Lakera, Otari's org guardrail"), stopReason: "guard_blocked" };
  if (r.stuck) {
    // The tool result already told the teammate it was stopped; the fixed sentence is only a fallback.
    const said = Number((await pool.query("SELECT count(*)::int AS n FROM events WHERE run_id = $1 AND type = 'slack.post'", [ctx.run.id])).rows[0].n);
    return { text: said || r.text ? r.text : `I had to stop before finishing this one; my work so far is saved. Say "continue" and I'll pick up where I left off.`, stopReason: "stuck" };
  }
  // Peeblo's own refusal (before Otari) carries its sentence; Otari's carries its numbers.
  // Peeblo's own budget stop shows its card (Ask the owner for more); no second message with raw numbers.
  // A person's own tier has no card, so it gets the sentence (with Peeblo's numbers) either way.
  if (r.money) {
    const m = r.money;
    const own = m.by === "peeblo" && m.scope === "user"
      ? budgetReply({ scope: "user", message: m.message ?? "", remaining: Math.max(0, Number(m.cap) - Number(m.spent)), estimate: Number(m.estimate) }, tm.config.name)
      : m.by === "peeblo" ? "" : budgetReply(m, tm.config.name);
    return { text: own, stopReason: "budget_blocked" };
  }
  if (r.stopReason === "error") {
    throw new Error(`model error: ${r.error ?? "unknown"}`);
  }
  return r;
}

export function installPiExecutor(): void {
  setRunExecutor(async (ctx) => {
    // Step names stay as they were for turns 1 and 2, so runs in flight across an upgrade replay cleanly.
    const start = (n: number, data: Record<string, unknown>) => DBOS.runStep(() => appendEvent({ sessionId: ctx.session.id, runId: ctx.run.id, type: "turn.started", data: { turn: n, ...data } }), { name: n === 1 ? "turn-start" : `turn-start-${n}` });
    const finish = (n: number, r: { text: string; stopReason: string | null }) => DBOS.runStep(() => appendEvent({ sessionId: ctx.session.id, runId: ctx.run.id, type: "turn.finished", data: { turn: n, text: r.text, stop_reason: r.stopReason } }), { name: n === 1 ? "turn-finish" : `turn-finish-${n}` });
    await start(1, {});
    // A turn is one step: if core dies mid-turn, the step runs again on the same Pi session after restart.
    let r = await DBOS.runStep(() => turn(ctx, 1), { name: "turn" });
    await finish(1, r);
    let n = 1;
    let checks = 0;
    for (;;) {
      // A job stopped on a limit (stuck, or the hard time limit) gets one short turn to say where it is, in its own words.
      if (r.stopReason === "stuck" || r.stopReason === "time_limit") {
        const l = live.get(ctx.session.id);
        if (l) {
          const { allowFinalStatus } = await import("../proxy/relay.ts");
          allowFinalStatus(l.token, ctx.run.id);
          const asker = ctx.run.submission_id ? (await pool.query("SELECT p.display_name FROM submissions s LEFT JOIN people p ON p.id = s.person_id WHERE s.id = $1", [ctx.run.submission_id])).rows[0]?.display_name : null;
          const why = r.stopReason === "time_limit" ? `This job has run for ${Math.round(config.turnTimeoutMs / 3_600_000)} hours, the most one job may run, and has stopped here.` : "This job has stopped here.";
          const note = `<peeblo_event kind="stopped">${why} Post your status for ${String(asker ?? "them").split(" ")[0]} with slack_post, in two or three short lines: what's done, what still fails and why, and what you'd do next. Plain words: never mention keys, scopes or permissions. Your work is saved; say they can tell you to continue. No other tools.</peeblo_event>`;
          await DBOS.runStep(() => appendEvent({ sessionId: ctx.session.id, runId: ctx.run.id, type: "turn.started", data: { turn: n + 1, final_status: true } }), { name: n === 1 ? "turn-start-status" : `turn-start-status-${n + 1}` });
          const s2 = await DBOS.runStep(() => turn(ctx, n + 1, note), { name: n === 1 ? "turn-status" : `turn-status-${n + 1}` });
          await DBOS.runStep(() => appendEvent({ sessionId: ctx.session.id, runId: ctx.run.id, type: "turn.finished", data: { turn: n + 1, text: s2.text, stop_reason: s2.stopReason } }), { name: n === 1 ? "turn-finish-status" : `turn-finish-status-${n + 1}` });
        }
        return { summary: r.text.slice(0, 500) };
      }
      // The Stop check or the outcome grader may send the job back when it isn't done, a few times at most.
      if (checks >= config.maxContinuations) break;
      const check = await DBOS.runStep(() => stopCheck(ctx, r).catch(() => ({ again: null })), { name: n === 1 ? "stop-check" : `stop-check-${n}` });
      if (!check.again) break;
      checks++;
      n++;
      // Sent back once already, or stuck on everyday work: the rest of the job runs on the strong model.
      const cur = jobModels.get(ctx.run.id);
      if (config.jobRouting && cur === "peeblo-worker") {
        escalateJob(ctx.run.id);
        await DBOS.runStep(() => appendEvent({ sessionId: ctx.session.id, runId: ctx.run.id, type: "job.model", data: { model: "peeblo-heavy", by: "escalation", reason: "the Stop check sent the job back" } }), { name: `escalate-${n}` });
      }
      await start(n, { continuation: true });
      r = await DBOS.runStep(() => turn(ctx, n, check.again!), { name: `turn-${n}` });
      await finish(n, r);
    }
    return { summary: r.text.slice(0, 500) };
  });
}

