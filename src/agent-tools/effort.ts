// Routing at the boundary (how pi-otari routes subagents): when one part of a job is clearly harder than everyday
// work, the teammate asks Otari's recommender which model fits that part. If it picks a stronger or different model,
// that part runs as a subagent on the pick and its answer comes back; the job itself never switches model mid-way.
// The candidates are the role defaults in config/model-tiers.json, so nothing here names a model; a pick runs on its
// role policy. Only budgets limit it.
import type { AgentTool } from "./types.ts";
import { object } from "./schema.ts";

async function candidates(): Promise<{ everyday: string; list: Record<string, string> }> {
  const { ROLES } = await import("../otari/routing.ts");
  const everyday = ROLES["peeblo-worker"].default;
  return { everyday, list: {
    [everyday]: "everyday work: lookups, summaries, drafts, routine tool use; fast and cheap",
    [ROLES["peeblo-heavy"].default]: "the strongest open model, many times the price: hard reasoning, reconciling sources that disagree, long dependent plans, subtle code bugs, careful money math",
    [ROLES["peeblo-reviewer"].default]: "a different model family at a similar price: a second opinion or a check on another model's work",
  } };
}

export const pickModelTool: AgentTool = {
  name: "pick_model",
  description: "When one part of a job is clearly harder than the rest, ask Otari's router which model fits that part. If it picks a stronger model (or another family for a second opinion), that part runs on its pick as a helper with its own computer folder, and you get the answer back. Typical reasons: sources that disagree and must be reconciled, a long plan with dependent steps, a subtle bug, careful money math, a second opinion. Give the self-contained task, with the facts it needs.",
  input_schema: object({
    work: { type: "string", description: "Why this part is hard, in a line." },
    task: { type: "string", description: "The self-contained task for the chosen model, with the facts and numbers it needs; it can look things up but changes nothing." },
  }),
  kind: "local",
  async run(ctx, a) {
    if (!ctx.runId) return { text: "There's no job to route.", isError: true };
    const { recommend } = await import("../otari/routing.ts");
    const { readableModel } = await import("../slack/look.ts");
    const c = await candidates();
    const r = await recommend({ sessionId: ctx.sessionId, toolUseId: ctx.toolCallId, agentType: "analysis", description: String(a.work).slice(0, 200), prompt: `${a.work}\n\n${a.task}`.slice(0, 4000), parentModel: c.everyday, candidates: c.list, endUser: ctx.endUser ?? undefined });
    if (r.fallback || r.model === c.everyday) return { text: r.fallback ? "Otari's router didn't answer; do it yourself on your own model." : `Otari's router says the everyday model fits this${r.reason ? ` (${r.reason})` : ""}; do it yourself.`, data: r };
    const { subagentTool } = await import("./work.ts");
    const name = readableModel(r.model).name;
    // The pick runs on its role policy when it has one (the heavy model through `peeblo-heavy`), so Otari's fallback
    // and its step-down to a cheaper model as the key's budget runs down apply to it.
    const { ROLES } = await import("../otari/routing.ts");
    const role = Object.entries(ROLES).find(([, v]) => v.default === r.model && v.step_down)?.[0];
    const out = await subagentTool.run(ctx, { task: a.task, model: role ?? r.model });
    if (out.isError) return { text: `Otari's router picked ${name}, but that run didn't finish (${out.text}); do it yourself.`, isError: true, data: r };
    return { text: `Otari's router picked ${name}${r.reason ? ` (${r.reason})` : ""}; its answer:\n${out.text}\n\nCheck it against what you know, and say in your reply that ${name} did this part.`, untrusted: out.untrusted, data: { ...r, ...(out.data as object) } };
  },
};
