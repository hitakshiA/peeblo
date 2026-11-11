// "was the request answered?" is a Stop check in a fresh context (a typed judge from another model family
// than the worker), and a job with a spec (a delegated objective) gets an outcome grader against that spec. Either
// may send the teammate back with the reason, up to PEEBLO_MAX_CONTINUATIONS times.
import { pool } from "../db.ts";
import type { RunContext } from "../durable/runs.ts";
import { appendEvent } from "../store/events.ts";

export async function stopCheck(ctx: RunContext, r: { text: string; stopReason: string | null }): Promise<{ again: string | null }> {
  // "toolUse": the turn ended on a tool that ends it (a posted answer, a hand-off).
  if (r.stopReason !== "stop" && r.stopReason !== "toolUse") return { again: null };
  const src = (await pool.query("SELECT source FROM submissions WHERE id = $1", [ctx.run.submission_id])).rows[0]?.source;
  const place = (ctx.session.place as any)?.slack;
  if (!["slack", "api", "teammate"].includes(src)) return { again: null };
  const posted = (await pool.query("SELECT data->>'text' AS t FROM events WHERE run_id = $1 AND type = 'slack.post' ORDER BY id", [ctx.run.id])).rows.map((x) => String(x.t));
  // Each tool call's latest status only (an approved write logs "waiting_approval", then "completed").
  const calls = (await pool.query(`SELECT DISTINCT ON (coalesce(data->>'id', id::text)) data->>'tool' AS t, data->>'status' AS s FROM events
    WHERE run_id = $1 AND type = 'tool.call' ORDER BY coalesce(data->>'id', id::text), id DESC`, [ctx.run.id])).rows as { t: string; s: string }[];
  const said = [...posted, r.text].join("\n");
  const ruled = async (rule: string, again: string) => {
    await appendEvent({ sessionId: ctx.session.id, runId: ctx.run.id, type: "stop_check.decided", data: { verdict: "continue", reason: rule, via: "rule" } });
    return { again: `<peeblo_event kind="stop_check">${again}</peeblo_event>` };
  };
  // Behaviour (false "noted", untried-route claims, plumbing talk) is taught in the how-you-work text, not filtered here.
  // What stays is a rail: a claimed card that doesn't exist leaves a person waiting on nothing.
  // Saying an approval card is waiting when none is.
  const pendingCard = (await pool.query("SELECT 1 FROM approvals a JOIN runs r ON r.id = a.run_id WHERE r.session_id = $1 AND a.status = 'pending' AND a.expires_at > now() LIMIT 1", [ctx.session.id])).rowCount;
  if (!pendingCard && /\b(card|approv\w*)\b/i.test(said) && /\b(is|it['’]s|card['’]s|still) (waiting|pending|up)\b|\bneeds you to approve\b|\bwaiting (on|for) (you|your)\b|\bpending (your )?approval\b|\b(approve|tap) (it|that|the card) (above|when|and)\b/i.test(said)) {
    return ruled("claimed a card that doesn't exist", "You said an approval card is waiting, but there is no card: the last one expired or was answered. If they already told you to go ahead, call the tool again now (that makes a new card). Otherwise post your whole corrected reply with slack_post (it replaces the earlier one, so include everything they need): nothing is waiting, and they can say go.");
  }
  // An "Ask again" turn has to make the call again.
  const asked = /^Ask again: I'm here now\. Call ([a-z0-9_]+)/.exec(ctx.text)?.[1];
  if (asked && !calls.some((c) => c.t === asked)) return ruled("ask again without the call", `They clicked Ask again: call ${asked} now with the same arguments as before, so they get a new card. Don't describe it; make the call.`);
  // Only direct asks and delegated jobs: a channel it reads along in, a welcome or an unattended run may end quietly.
  if (place && !place.direct) return { again: null };
  // A plain reply (it posted, and used no other tool) has nothing left half-done: no judge call for a greeting.
  if (src !== "teammate" && (posted.length || r.text.trim()) && calls.every((c) => c.t === "slack_post")) return { again: null };
  // A job handed to a teammate is done for this turn: the teammate posts the result itself.
  if (calls.some((c) => c.t === "delegate" && c.s === "completed")) return { again: null };
  // The judge sees a short state (under ~1.5k tokens): the ask, the last post, and a tally of tool outcomes.
  const tally = new Map<string, number>();
  for (const c of calls) tally.set(`${c.t} ${c.s}`, (tally.get(`${c.t} ${c.s}`) ?? 0) + 1);
  const state = [
    `The request${src === "teammate" ? " (a job with a spec from another teammate)" : ""}:\n${ctx.text.slice(0, src === "teammate" ? 2000 : 1000)}`,
    `What the teammate posted for the person${posted.length > 1 ? ` (last of ${posted.length} posts)` : ""}:\n${posted.at(-1)?.slice(0, 1500) || "(nothing posted)"}`,
    r.text.trim() ? `Its final words: ${r.text.slice(0, 300)}` : "",
    `Tools: ${[...tally].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(", ").slice(0, 400) || "none"}`,
  ].filter(Boolean).join("\n\n");
  const { decide } = await import("../otari/decisions.ts");
  if (src === "teammate") {
    const g = await decide(state, { meets: { type: "noul", instructions: "Does the posted result meet the spec: the Objective is done and what it says to hand back is there, in that shape? A clear, honest explanation of why it can't be done also counts as meeting it." } }, { safeDefault: { meets: true } });
    await appendEvent({ sessionId: ctx.session.id, runId: ctx.run.id, type: "outcome.graded", data: { meets: g.answers.meets.value, reason: g.answers.meets.reason, via: g.via, model: g.model, request_ids: g.requestIds } });
    return { again: g.answers.meets.value === false ? `<peeblo_event kind="outcome_grader">A grader checked your result against the job's spec and found it short: ${g.answers.meets.reason ?? "it doesn't meet the spec"}. Fix that and post the result with slack_post; if it can't be done, say exactly what's missing.</peeblo_event>` : null };
  }
  const d = await decide(state, { verdict: { type: "choice", instructions: "Did the teammate finish what the person asked?", criteria: {
    done: "it answered or did what was asked, or clearly explained why it can't",
    continue: "it stopped early: work it promised isn't done, it hit an error it could fix, or nothing was posted for the person",
    waiting: "it is rightly waiting on the person (it asked them a question, or needs an approval)",
  } } }, { safeDefault: { verdict: "done" } });
  await appendEvent({ sessionId: ctx.session.id, runId: ctx.run.id, type: "stop_check.decided", data: { verdict: d.answers.verdict.value, reason: d.answers.verdict.reason, via: d.via, model: d.model, request_ids: d.requestIds } });
  return { again: d.answers.verdict.value === "continue" ? `<peeblo_event kind="stop_check">A check found the request isn't finished yet: ${d.answers.verdict.reason ?? "the answer is incomplete"}. Continue and finish it, posting the result with slack_post. If you can't, say exactly what's missing.</peeblo_event>` : null };
}
