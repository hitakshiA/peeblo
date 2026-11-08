// read_skill: opens one of this teammate's skills (src/skills.ts). Reading changes nothing, so it never asks.
import { readSkill } from "../skills.ts";
import { object } from "./schema.ts";
import type { AgentTool } from "./types.ts";

export const readSkillTool: AgentTool = {
  name: "read_skill",
  description: "Load one of your skills (listed under available_skills in your instructions) when the task matches its description. file is another file inside that skill, if its SKILL.md points to one.",
  input_schema: object({ skill: { type: "string" }, file: { type: ["string", "null"] } }),
  kind: "read",
  async run(ctx, a) {
    try { return { text: readSkill(ctx.teammate, a.skill, a.file) }; }
    catch (e) { return { text: (e as Error).message, isError: true }; }
  },
};
