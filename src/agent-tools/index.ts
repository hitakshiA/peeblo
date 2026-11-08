// The fixed list of Peeblo's own tools for a session (K7a): which ones a teammate has is decided when its
// session starts, from its pinned config; modes change what the gate allows, never which tools exist.
import type { Teammate } from "../store/teammates.ts";
import { otariTools } from "./otari.ts";
import type { AgentTool } from "./types.ts";
import { webFetch, webSearchTool } from "./web.ts";
import { config } from "../config.ts";
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
  const all = [planTool, readSkillTool, ...slackTools, ...memoryTools, ...(tm.slug === "peeblo" ? [...managerTools, companyMemoryTool] : [askHumanTool]), askTeammateTool, ...scheduleTools, ...otariTools, ...(tm.config.tools.includes("web") ? [webSearchTool, ...(config.webFetch ? [webFetch] : [])] : []), ...(tm.config.tools.includes("computer") ? [...computerTools, ...recipeTools, ...(((tm.config.computer as any)?.repos ?? []).length ? repoTools : []), ...(tm.config.computer?.size === "large" ? browserTools : [])] : []), subagentTool];
  // A subagent looks things up but changes nothing, and opens no subagents.
  // The start set is small (NIGHT_PLAN_NOV9 §1): how to reply, find more tools, read a skill, recall, plan, hand
  // work on, and the computer. Everything else (hiring, settings, schedules, connectors, web) loads with find_tools.
  const START = new Set(["slack_post", "read_skill", "memory_read", "memory_search", "plan", ...(tm.slug === "peeblo" ? ["delegate", "crew_status"] : ["ask_teammate"]),
    "computer_bash", "computer_read", "computer_write", "computer_edit"]);
  const listed = all.map((t) => (START.has(t.name) ? t : { ...t, deferred: true }));
  return opts.subagent ? listed.filter((t) => t.kind === "read") : listed;
}
