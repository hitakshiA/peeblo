// The fixed list of Peeblo's own tools for a session: which ones a teammate has is decided when its
// session starts, from its pinned config; modes change what the gate allows, never which tools exist.
import type { Teammate } from "../store/teammates.ts";
import { otariTools } from "./otari.ts";
import type { AgentTool } from "./types.ts";
import { runCodeTool, webFetch, webSearchTool } from "./web.ts";
import { checkTextTool, understandFileTool } from "./media.ts";
import { config } from "../config.ts";
import { computerTools } from "./computer.ts";
import { TIERS } from "../environment/controller.ts";
import { recipeTools } from "./recipe.ts";
import { browserTools } from "./browser.ts";
import { repoTools } from "./repos.ts";
import { slackTools } from "./slack.ts";
import { showDataTool } from "./display.ts";
import { canvasTool } from "./canvas.ts";
import { askHumanTool, managerTools } from "./manager.ts";
import { companyMemoryTool, memoryTools, workMemoryTools } from "./memory.ts";
import { pickModelTool } from "./effort.ts";
import { askTeammateTool } from "./teammates.ts";
import { scheduleTools } from "./schedules.ts";
import { planApprovalTool, planTool, subagentTool } from "./work.ts";
import { installSkillTool, readSkillTool, saveSkillTool } from "./skills.ts";

export function peebloTools(tm: Teammate, opts: { subagent?: boolean } = {}): AgentTool[] {
  const all = [planTool, planApprovalTool, readSkillTool, saveSkillTool, installSkillTool, showDataTool, canvasTool, ...slackTools.filter((t) => t.name !== "channel_watch" || tm.slug === "peeblo"), ...memoryTools, ...workMemoryTools, companyMemoryTool, pickModelTool, ...(tm.slug === "peeblo" ? [...managerTools] : [askHumanTool]), askTeammateTool, ...scheduleTools, ...otariTools, ...(tm.config.tools.includes("web") ? [webSearchTool, ...(config.webFetch ? [webFetch] : [])] : []), ...(config.otariCode && tm.config.tools.includes("code") ? [runCodeTool] : []), ...(tm.config.tools.includes("computer") ? [understandFileTool] : []), checkTextTool, ...(tm.config.tools.includes("computer") ? [...computerTools, ...recipeTools, ...(((tm.config.computer as any)?.repos ?? []).length ? repoTools : []), ...(tm.config.computer?.size === "large" ? browserTools : [])] : []), subagentTool];
  // A subagent looks things up but changes nothing, and opens no subagents.
  // The start set is small: how to reply, find more tools, read a skill, recall, plan, hand
  // work on, and the computer. Everything else (hiring, settings, schedules, connectors, web) loads with find_tools.
  const START = new Set(["slack_post", "slack_read_thread", "slack_read_channel", "show_data", "read_skill", "memory_read", "recall", "plan", ...(tm.slug === "peeblo" ? ["delegate", "crew_status"] : ["ask_teammate"]),
    "computer_bash", "computer_read", "computer_write", "computer_edit", "understand_file", "check_text",
    // Code execution sits beside the computer, so the model sees both and picks (CODE_EXEC_ROLES: run code where the data is).
    ...(tm.config.tools.includes("code") ? ["run_code"] : []),
    // A teammate with repos opens and publishes them with its own tools, never with git on the computer.
    ...((((tm.config.computer as any)?.repos ?? []).length) ? ["repo_open", "repo_publish"] : [])]);
  const listed = all.map((t) => (START.has(t.name) ? t : { ...t, deferred: true })).map((t) => (t.name === "computer_bash" ? { ...t, description: `${t.description} ${hardware(tm)}` } : t));
  return opts.subagent ? listed.filter((t) => t.kind === "read") : listed;
}

// What the teammate's computer is, so it plans work that fits (and installs what it needs, knowing the limits).
function hardware(tm: Teammate): string {
  const size = (tm.config.computer?.size ?? "small") as keyof typeof TIERS;
  const t = TIERS[size];
  const os = size === "large" ? "Debian with a browser; it can reach the web" : "Alpine (apk); it reaches package registries and GitHub, and the web only through web_search and web_fetch";
  return `Your computer: ${size}, ${t.cpus} CPUs, ${t.memory}B memory, ${t.disk}B disk, ${os}. It sleeps after a few idle minutes and wakes on the next command; installs last until a reset unless they're in your recipe (recipe_propose).`;
}
