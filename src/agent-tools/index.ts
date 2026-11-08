// The fixed list of Peeblo's own tools for a session (K7a): which ones a teammate has is decided when its
// session starts, from its pinned config; modes change what the gate allows, never which tools exist.
import type { Teammate } from "../store/teammates.ts";
import { otariTools } from "./otari.ts";
import type { AgentTool } from "./types.ts";
import { webFetch } from "./web.ts";
import { computerTools } from "./computer.ts";
import { recipeTools } from "./recipe.ts";
import { browserTools } from "./browser.ts";
import { repoTools } from "./repos.ts";
import { slackTools } from "./slack.ts";
import { askHumanTool, managerTools } from "./manager.ts";
import { companyMemoryTool, memoryTools } from "./memory.ts";
import { askTeammateTool } from "./teammates.ts";
import { scheduleTools } from "./schedules.ts";
import { planTool, subagentTool } from "./work.ts";
import { readSkillTool } from "./skills.ts";

export function peebloTools(tm: Teammate, opts: { subagent?: boolean } = {}): AgentTool[] {
  const all = [planTool, readSkillTool, ...slackTools, ...memoryTools, ...(tm.slug === "peeblo" ? [...managerTools, companyMemoryTool] : [askHumanTool]), askTeammateTool, ...scheduleTools, ...otariTools, ...(tm.config.tools.includes("web") ? [webFetch] : []), ...(tm.config.tools.includes("computer") ? [...computerTools, ...recipeTools, ...(((tm.config.computer as any)?.repos ?? []).length ? repoTools : []), ...(tm.config.computer?.size === "large" ? browserTools : [])] : []), subagentTool];
  // A subagent looks things up but changes nothing, and opens no subagents.
  // Rarely used tools start deferred: found with find_tools when a job needs them.
  // Direct: speaking, plan, memory basics, files and shell, asking a teammate, money and models, web, and the few
  // most-used connectors. Everything else (schedules and triggers, recipes, repos, Otari settings) loads when needed.
  const DEFERRED = new Set([
    "schedule", "webhook_trigger", "watch",
    "otari_read_setting", "otari_prepare_change", "otari_set_web_search", "otari_set_guardrail", "otari_set_routing_policy",
    "recipe_propose", "build_status", "computer_reset", "repo_open", "repo_publish",
    "memory_search", "slack_react", "subagent",
    "company_memory_propose", "models_list", "price_estimate", "budget_status",
  ]);
  // Peeblo hands work on with delegate, so asking a teammate loads on demand for it.
  const deferHere = (n: string) => DEFERRED.has(n) || (tm.slug === "peeblo" && (n === "ask_teammate" || n === "web_fetch"));
  const listed = all.map((t) => (deferHere(t.name) ? { ...t, deferred: true } : t));
  return opts.subagent ? listed.filter((t) => t.kind === "read") : listed;
}
