// plan: the teammate's own plan for the work in hand, kept as an event (the harness shows it).
// subagent: a fresh session of the same teammate for side work, one level deep: it can look things up and work on
// its own computer folder (run commands, write files), but not change anything outside, and it can't open subagents
// of its own. Several run at once. A subagent is a model
// boundary: it may run on another open-weight model, and one whose cost estimate is over the price
// card threshold waits for a person first.
import { config } from "../config.ts";
import { startRun } from "../durable/runs.ts";
import { checkModel } from "../model-change.ts";
import { countTokens, estimateCost } from "../otari/catalog.ts";
import { ROLES } from "../otari/routing.ts";
import { usd } from "../otari/spend.ts";
import { appendEvent } from "../store/events.ts";
import { getRun, openSession, submit } from "../store/sessions.ts";
import { pool } from "../db.ts";
import { object } from "./schema.ts";
import type { AgentTool } from "./types.ts";

export const planTool: AgentTool = {
  name: "plan",
  description: "Write down or update your plan: the steps and where each stands. Only for work of 3 or more steps; a lookup or a two-source answer needs no plan. Update it alongside other tool calls, not on its own step.",
  input_schema: object({
    steps: { type: "array", maxItems: 12, items: { type: "object", properties: { step: { type: "string" }, status: { type: "string", enum: ["todo", "doing", "done", "dropped"] } }, required: ["step", "status"], additionalProperties: false } },
  }),
  kind: "read",
  async run(ctx, a) {
    await appendEvent({ sessionId: ctx.sessionId, runId: ctx.runId, type: "plan.updated", data: { steps: a.steps } });
    const done = a.steps.filter((s: any) => s.status === "done").length;
    return { text: `Plan saved (${done}/${a.steps.length} done).` };
  },
};

const modelFor = (m: string | null, fallback: string) => (m === null ? fallback : m in ROLES ? ROLES[m].default : m);

export const subagentTool: AgentTool = {
  name: "subagent",
  description: "Hand a self-contained piece of side work (research, reading, comparing, running and checking something on a computer) to a fresh session of yourself, and get its answer back. Start several in one step for independent parts; they run at the same time. Say what you need and why, not how. It can look things up and use its own computer folder, but not change anything outside it.",
  input_schema: object({
    task: { type: "string", description: "What to find out, and what the answer should look like." },
    model: { type: ["string", "null"], description: "A catalog model id or role policy for this work, or null for your own model (pick_model asks Otari's router)." },
  }),
  kind: "read", // several at once; each is its own session, and nothing it does reaches outside its computer folder
  async authorize(ctx, a) {
    if (ctx.subagent) return "A subagent can't open subagents of its own; do the work yourself.";
    return a.model ? checkModel(a.model) : null;
  },
  async gate(ctx, a) {
    const model = modelFor(a.model, ctx.teammate.config.model.default);
    const est = await estimateCost(model, 8000 + (await countTokens(model, a.task)), 2000);
    return est !== null && est > config.priceCardUsd ? { ask: `This subagent would cost about ${usd(est)} on ${a.model}.` } : null;
  },
  async run(ctx, a) {
    const s = await openSession(ctx.teammate.id, "api", `subagent:${ctx.sessionId}:${ctx.toolCallId}`, { subagent_of: ctx.sessionId, model: a.model, read_only: true });
    const sub = await submit({ sessionId: s.id, personId: ctx.person?.id ?? null, requestId: `subagent-${ctx.toolCallId}`, text: a.task, source: "subagent" });
    await startRun(sub.run.id, { child: true });
    // As long as its own work takes: it has the same limits as any job (budget, the stuck check, the hard limit).
    const until = Date.now() + config.turnTimeoutMs;
    for (;;) {
      const run = await getRun(sub.run.id);
      if (run && ["done", "failed", "cancelled"].includes(run.status)) {
        const { rows } = await pool.query("SELECT data FROM events WHERE run_id = $1 AND type = 'turn.finished' ORDER BY id DESC LIMIT 1", [sub.run.id]);
        const answer = rows[0]?.data?.text ?? "";
        if (run.status !== "done") return { text: `The subagent stopped (${run.status}${run.error ? `: ${run.error}` : ""}).`, isError: true, data: { run_id: sub.run.id } };
        return { text: answer, untrusted: "subagent", data: { run_id: sub.run.id, session_id: s.id } };
      }
      if (Date.now() > until) return { text: "The subagent didn't finish in time.", isError: true, data: { run_id: sub.run.id } };
      await new Promise((r) => setTimeout(r, 2000));
    }
  },
};

// One approval for a plan a person stated ("push the guard, then merge"): the card lists the steps; once approved,
// each listed step runs in this job without its own card. Required rules (no force-push, no credentials) still apply.
export const planApprovalTool: AgentTool = {
  name: "plan_approval",
  description: "When a person has asked for several writes as one job (\"push the fix, then merge\", \"put everyone's budget back\"), ask for them together: one card with the steps in plain words, each naming the tool it will use. Once approved, those tools run in this job without another card. Don't use it to bundle steps nobody asked for.",
  input_schema: object({
    title: { type: "string", description: "The whole job in words, e.g. \"Push the guard to PR #1, then merge #1\"." },
    steps: { type: "array", maxItems: 8, items: { type: "object", properties: { action: { type: "string", description: "The step in words: repo, branch, what changes." }, tool: { type: "string", description: "The exact tool name this step uses." } }, required: ["action", "tool"], additionalProperties: false } },
  }),
  kind: "write",
  describe(_ctx, a) {
    return { kind: "plan", title: String(a.title), summary: (a.steps ?? []).map((x: any, i: number) => `${i + 1}. ${x.action}`).join("\n"), steps: a.steps };
  },
  async run(ctx, a) {
    const tools = [...new Set((a.steps ?? []).map((x: any) => String(x.tool)))];
    await appendEvent({ sessionId: ctx.sessionId, runId: ctx.runId, type: "plan.approved", data: { title: a.title, tools } });
    return { text: `Approved: ${a.title}. Do the steps now, in order; the listed tools (${tools.join(", ")}) run in this job without another card.` };
  },
};

