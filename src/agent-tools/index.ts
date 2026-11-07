// The fixed list of Peeblo's own tools for a session (K7a): which ones a teammate has is decided when its
// session starts, from its pinned config; modes change what the gate allows, never which tools exist.
import type { Teammate } from "../store/teammates.ts";
import { otariTools } from "./otari.ts";
import type { AgentTool } from "./types.ts";
import { webFetch } from "./web.ts";

export function peebloTools(tm: Teammate): AgentTool[] {
  return [...otariTools, ...(tm.config.tools.includes("web") ? [webFetch] : [])];
}
