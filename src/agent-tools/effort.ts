// Smart routing for one job (NIGHT_PLAN_NOV9 §2.3): everyday work runs on the teammate's role policy (DeepSeek Flash,
// MiMo fallback, in Otari). When a job is unusual, the teammate asks Otari's recommender which model fits this work,
// and the rest of the job runs on the answer. Only budgets limit it (the per-teammate and total caps), never a
// count of calls, so nothing stops mid-job.
import type { AgentTool } from "./types.ts";
import { object } from "./schema.ts";

// runId → the model the rest of that job runs on (read by the relay).
export const jobModel = new Map<string, string>();

const CANDIDATES: Record<string, string> = {
  "deepseek/deepseek-v4.1-flash-1017": "everyday work: lookups, summaries, drafts, routine tool use; fast and cheap",
  "moonshotai/kimi-k3.1-pro": "the strongest open model, about 20x the price: hard reasoning, reconciling sources that disagree, long dependent plans, subtle code bugs, careful money math",
  "minimax/minimax-m3.1-flash": "a different model family at a similar price: a second opinion or a check on another model's work",
};

export const pickModelTool: AgentTool = {
  name: "pick_model",
  description: "When a job is clearly harder (or simpler) than everyday work, ask Otari's router which model fits it, and run the rest of this job on its pick. Everyday work doesn't need this. Typical reasons: sources that disagree and must be reconciled, a long plan with dependent steps, a subtle bug, careful money math, or a second opinion from another model family. Describe the work in a line or two.",
  input_schema: object({ work: { type: "string", description: "What the rest of this job has to do, and what makes it hard." } }),
  kind: "local",
  async run(ctx, a) {
    if (!ctx.runId) return { text: "There's no job to route.", isError: true };
    const { recommend } = await import("../otari/routing.ts");
    const r = await recommend({ sessionId: ctx.sessionId, toolUseId: ctx.toolCallId, agentType: "analysis", description: String(a.work).slice(0, 200), prompt: String(a.work), parentModel: "deepseek/deepseek-v4.1-flash-1017", candidates: CANDIDATES, endUser: ctx.endUser ?? undefined });
    if (r.fallback || r.model === "deepseek/deepseek-v4.1-flash-1017") {
      jobModel.delete(ctx.runId);
      return { text: r.fallback ? "Otari's router didn't answer; staying on the everyday model." : `Otari's router says the everyday model fits this${r.reason ? ` (${r.reason})` : ""}; staying on it.`, data: r };
    }
    jobModel.set(ctx.runId, r.model);
    const name = r.model.includes("kimi") ? "Kimi K3.1 Pro" : r.model.includes("minimax") ? "MiniMax M3.1 Flash" : r.model;
    return { text: `Otari's router picked ${name} for the rest of this job${r.reason ? ` (${r.reason})` : ""}. Say in your answer which model did the hard part and why.`, data: r };
  },
};
