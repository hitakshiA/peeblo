// plan: the teammate's own plan for the work in hand, kept as an event (the harness shows it).
// subagent: a fresh session of the same teammate for side work, one level deep and read-only: it can look
// things up but not change anything, and it can't open subagents of its own. A subagent is a model
// boundary (K3): it may run on another open-weight model, and one whose cost estimate is over the price
// card threshold waits for a person first (K16).
import { config } from "../config.ts";
import { startRun } from "../durable/runs.ts";
import { checkModel } from "../model-change.ts";
import { estimateCost } from "../otari/catalog.ts";
import { ROLES } from "../otari/routing.ts";
import { usd } from "../otari/spend.ts";
import { appendEvent } from "../store/events.ts";
import { getRun, openSession, submit } from "../store/sessions.ts";
import { pool } from "../db.ts";
import { object } from "./schema.ts";
import type { AgentTool } from "./types.ts";

export const planTool: AgentTool = {
  name: "plan",
  description: "Write down or update your plan for this piece of work: the steps and where each stands. Use it for anything with more than two steps, and keep it current.",
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
  description: "Hand a self-contained piece of read-only side work (research, reading, comparing) to a fresh session of yourself, and get its answer back. Say what you need and why, not how. It can look things up but not change anything.",
  input_schema: object({
    task: { type: "string", description: "What to find out, and what the answer should look like." },
    model: { type: ["string", "null"], description: "A catalog model id or role policy for this work, or null for your own model. See routing_recommend." },
  }),
  kind: "local",
  async authorize(ctx, a) {
    if (ctx.subagent) return "A subagent can't open subagents of its own; do the work yourself.";
    return a.model ? checkModel(a.model) : null;
  },
  async gate(ctx, a) {
    const est = await estimateCost(modelFor(a.model, ctx.teammate.config.model.default), 8000 + Math.ceil(a.task.length / 4), 2000);
    return est !== null && est > config.priceCardUsd ? { ask: `This subagent would cost about ${usd(est)} on ${a.model}.` } : null;
  },
  async run(ctx, a) {
    const s = await openSession(ctx.teammate.id, "api", `subagent:${ctx.sessionId}:${ctx.toolCallId}`, { subagent_of: ctx.sessionId, model: a.model, read_only: true });
    const sub = await submit({ sessionId: s.id, personId: ctx.person?.id ?? null, requestId: `subagent-${ctx.toolCallId}`, text: a.task, source: "subagent" });
    await startRun(sub.run.id);
    const until = Date.now() + 8 * 60_000;
    for (;;) {
      const run = await getRun(sub.run.id);
      if (run && ["done", "failed", "cancelled"].includes(run.status)) {
        const { rows } = await pool.query("SELECT data FROM events WHERE run_id = $1 AND type = 'turn.finished' ORDER BY id DESC LIMIT 1", [sub.run.id]);
        const answer = rows[0]?.data?.text ?? "";
        if (run.status !== "done") return { text: `The subagent stopped (${run.status}${run.error ? `: ${run.error}` : ""}).`, isError: true, data: { run_id: sub.run.id } };
        return { text: answer, untrusted: "subagent", data: { run_id: sub.run.id, session_id: s.id } };
      }
      if (Date.now() > until) return { text: "The subagent didn't finish in 8 minutes.", isError: true, data: { run_id: sub.run.id } };
      await new Promise((r) => setTimeout(r, 1500));
    }
  },
};
