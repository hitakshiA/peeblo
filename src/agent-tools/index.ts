// The fixed list of Peeblo's own tools for a session (K7a): which ones a teammate has is decided when its
// session starts, from its pinned config; modes change what the gate allows, never which tools exist.
import type { Teammate } from "../store/teammates.ts";
import { otariTools } from "./otari.ts";
import type { AgentTool } from "./types.ts";
import { webFetch } from "./web.ts";
import { computerTools } from "./computer.ts";
import { planTool, subagentTool } from "./work.ts";

export function peebloTools(tm: Teammate, opts: { subagent?: boolean } = {}): AgentTool[] {
  const all = [planTool, ...otariTools, ...(tm.config.tools.includes("web") ? [webFetch] : []), ...(tm.config.tools.includes("computer") ? computerTools : []), subagentTool];
  // A subagent looks things up but changes nothing, and opens no subagents.
  return opts.subagent ? all.filter((t) => t.kind === "read") : all;
}
