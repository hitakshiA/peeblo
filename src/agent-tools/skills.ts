// read_skill: opens one of this teammate's skills (src/skills.ts). Reading changes nothing, so it never asks.
import { readSkill, saveSkill, SKILL_NAME } from "../skills.ts";
import { appendEvent } from "../store/events.ts";
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

// skill_save: turns how you just did a job into a skill you (only you) can read next time. A person approves it
// first, on a card showing the skill; it's advice for the next run, never code.
export const saveSkillTool: AgentTool = {
  name: "skill_save",
  description: "Save how you did a job as one of your own skills, when someone asks (\"save how you did the close\"). Write it as advice for next time: when to use it, the steps that worked, the traps, where things are. A person approves it first. Read it later with read_skill.",
  input_schema: object({
    name: { type: "string", description: "lowercase-with-dashes, e.g. closing-the-month" },
    description: { type: "string", description: "One sentence: what it's for and when to use it." },
    body: { type: "string", description: "The skill in Markdown: when to use it, steps, traps, where things are." },
  }),
  kind: "write",
  async authorize(_ctx, a) { return SKILL_NAME.test(String(a.name)) ? null : "A skill name is 3–41 lowercase letters, digits or dashes, e.g. closing-the-month."; },
  describe: (_ctx, a) => ({ summary: `Save the skill "${a.name}": ${String(a.description).slice(0, 160)}` }),
  async run(ctx, a) {
    try {
      saveSkill(ctx.teammate, a.name, a.description, a.body);
      await appendEvent({ sessionId: ctx.sessionId, runId: ctx.runId, type: "skill.saved", data: { teammate: ctx.teammate.slug, name: a.name } });
      return { text: `Saved the skill ${a.name}. It's in your skills list from your next conversation on.` };
    } catch (e) { return { text: (e as Error).message, isError: true }; }
  },
};
