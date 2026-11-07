// Asking another teammate (K18): what you need and in what shape, never how. The asker and payer come from this
// conversation (K6); depth, call count and spend caps are code (src/chains.ts). Teammates ask each other for
// intelligence; writes stay with the teammate whose job they are.
import { answerOf, callTeammate } from "../chains.ts";
import { findTeammate } from "./manager.ts";
import { object } from "./schema.ts";
import type { AgentTool } from "./types.ts";

export const askTeammateTool: AgentTool = {
  name: "ask_teammate",
  description: "Ask another teammate for something in its field (a number, a lookup, a review) in this same thread. wait: true gets you its answer here; wait: false lets it answer in the thread while you carry on.",
  input_schema: object({
    teammate: { type: "string" },
    question: { type: "string", description: "What you need and why." },
    answer_shape: { type: ["string", "null"], description: "e.g. 'one number with its source'." },
    wait: { type: "boolean" },
  }),
  kind: "local",
  async authorize(_ctx, a) { return (await findTeammate(a.teammate)) ? null : `There's no teammate called ${a.teammate}.`; },
  async run(ctx, a) {
    const callee = (await findTeammate(a.teammate))!;
    const text = [`${ctx.teammate.config.name} asks (for ${ctx.person?.display_name ?? "the person in this thread"}):`, a.question, a.answer_shape ? `Answer as: ${a.answer_shape}` : "", "Reply with slack_post in this thread."].filter(Boolean).join("\n");
    const r = await callTeammate({ runId: ctx.runId, sessionId: ctx.sessionId, caller: ctx.teammate, personId: ctx.person?.id ?? null, toolCallId: ctx.toolCallId }, callee, text, "ask");
    if ("refused" in r) return { text: r.refused, isError: true };
    if (!a.wait) return { text: `Asked ${callee.config.name}; it will answer in this thread.`, data: r };
    const ans = await answerOf(r.runId, 6 * 60_000);
    if (ans.status === "running") return { text: `${callee.config.name} is still working; its answer will appear in the thread.`, data: r };
    return { text: ans.status === "done" ? `${callee.config.name} answered:\n${ans.text}` : `${callee.config.name} couldn't finish (${ans.status}).`, untrusted: `teammate:${callee.slug}`, data: r };
  },
};
