// read_skill: opens one of this teammate's skills (src/crew/skills.ts). Reading changes nothing, so it never asks.
import { installSkill, readSkill, removeSkill, saveSkill, saveSkillFiles, SKILL_NAME } from "../crew/skills.ts";
import { appendEvent } from "../store/events.ts";
import { object } from "./schema.ts";
import type { AgentTool } from "./types.ts";

export const readSkillTool: AgentTool = {
  name: "read_skill",
  description: "Load one of your skills (listed under available_skills in your instructions) when the task matches its description. file is another file inside that skill, if its SKILL.md points to one.",
  input_schema: object({ skill: { type: "string" }, file: { type: ["string", "null"] } }),
  kind: "read",
  async run(ctx, a) {
    try {
      const text = readSkill(ctx.teammate, a.skill, a.file);
      // Its scripts and templates go to the computer, where they can run.
      let where: string | null = null;
      if (!a.file && ctx.teammate.config.tools.includes("computer")) {
        const { workspaceOf } = await import("../environment/controller.ts");
        const { copySkillTo } = await import("../crew/skills.ts");
        const { join } = await import("node:path");
        where = (() => { try { return copySkillTo(ctx.teammate, a.skill, join(workspaceOf(ctx.teammate.slug), "sessions", ctx.sessionId, "skills"), `/workspace/sessions/${ctx.sessionId}/skills`); } catch { return null; } })();
      }
      return { text: where ? `${text}\n\n[peeblo: this skill's files are on your computer at ${where}; run its scripts from there.]` : text };
    }
    catch (e) { return { text: (e as Error).message, isError: true }; }
  },
};

// skill_save: how you did a job, kept as a skill you (only you) read next time. Your own advice, so no card: the
// owner hears about it and can have it removed.
export const saveSkillTool: AgentTool = {
  name: "skill_save",
  description: "Keep how you did a job as one of your own skills, when someone asks (\"save how you did the close\") or when you worked out a way of doing recurring work that you'll need again. Write it as advice for next time: when to use it, the steps that worked, the traps, where things are; add files (a checklist, a template) if it points to them. Your owner is told. To drop one of your skills, give its name with remove.",
  input_schema: object({
    name: { type: "string", description: "lowercase-with-dashes, e.g. closing-the-month" },
    description: { type: ["string", "null"], description: "One sentence: what it's for and when to use it." },
    body: { type: ["string", "null"], description: "The skill in Markdown: when to use it, steps, traps, where things are." },
    files: { type: ["array", "null"], maxItems: 10, items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }, description: "More files in the skill's folder, e.g. checklist.md." },
    remove: { type: ["boolean", "null"], description: "true to delete this skill of yours." },
  }),
  kind: "local",
  async authorize(_ctx, a) { return SKILL_NAME.test(String(a.name)) ? null : "A skill name is 3–41 lowercase letters, digits or dashes, e.g. closing-the-month."; },
  async run(ctx, a) {
    const tell = (text: string) => appendEvent({ type: "notify.owner", data: { teammate_id: ctx.teammate.id, kind: "skill", key: `${ctx.teammate.id}:${a.name}:${Date.now()}`, text } });
    try {
      if (a.remove) {
        if (!removeSkill(ctx.teammate, a.name)) return { text: `You have no skill of your own called ${a.name}.`, isError: true };
        await appendEvent({ sessionId: ctx.sessionId, runId: ctx.runId, type: "skill.removed", data: { teammate: ctx.teammate.slug, name: a.name } });
        await tell(`${ctx.teammate.config.name} removed its skill "${a.name}".`);
        return { text: `Removed the skill ${a.name}.` };
      }
      if (!a.description || !a.body) return { text: "A skill needs a description and a body.", isError: true };
      saveSkill(ctx.teammate, a.name, a.description, a.body);
      const extra = a.files?.length ? saveSkillFiles(ctx.teammate, a.name, a.files) : [];
      await appendEvent({ sessionId: ctx.sessionId, runId: ctx.runId, type: "skill.saved", data: { teammate: ctx.teammate.slug, name: a.name, files: extra } });
      await tell(`${ctx.teammate.config.name} saved a skill for itself: "${a.name}", ${String(a.description).slice(0, 160)} Say "remove the ${a.name} skill" to it if it's wrong.`);
      return { text: `Saved the skill ${a.name}${extra.length ? ` with ${extra.join(", ")}` : ""}. It's in your skills list from your next conversation on; your owner was told.` };
    } catch (e) { return { text: (e as Error).message, isError: true }; }
  },
};

// skill_install: a skill someone shared on the web (a GitHub folder with a SKILL.md, the agentskills.io format).
// Its text becomes standing instructions, so it's screened by the guardrail and its owner approves it on a card.
export const installSkillTool: AgentTool = {
  name: "skill_install",
  description: "Install a skill someone shared (the SKILL.md format, e.g. a GitHub folder like https://github.com/<owner>/<repo>/tree/<branch>/<path>, or a raw SKILL.md link), when a person asks or when you found one that fits recurring work. Peeblo fetches it, has the guardrail check it, and your owner approves it before it's yours.",
  input_schema: object({ url: { type: "string" }, reason: { type: "string", description: "Why you need it, for your owner." } }),
  kind: "write",
  describe: async (_ctx, a) => ({ summary: `Install the skill from ${String(a.url).replace(/^https?:\/\//, "").slice(0, 90)}`, reason: a.reason }),
  async run(ctx, a) {
    try {
      const files = await fetchSkill(String(a.url));
      const md = files.find((f) => f.path === "SKILL.md")!.content;
      const fm = /^---\n([\s\S]*?)\n---/.exec(md)?.[1] ?? "";
      const name = (/^name:\s*(.+)$/m.exec(fm)?.[1] ?? "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 41);
      if (!name || !/^description:/m.test(fm)) return { text: "That SKILL.md has no name and description at the top, so it isn't a skill Peeblo can use.", isError: true };
      const { screen } = await import("../rules/guard.ts");
      const s = await screen(files.map((f) => f.content).join("\n\n").slice(0, 20_000), ctx.endUser).catch(() => null);
      if (s?.flagged) return { text: `Not installed: ${s.checked_by} flagged this skill as carrying instructions aimed at an AI. Tell the person; don't try to install it another way.`, isError: true, data: s };
      installSkill(ctx.teammate, name, files);
      await appendEvent({ sessionId: ctx.sessionId, runId: ctx.runId, type: "skill.installed", data: { teammate: ctx.teammate.slug, name, url: a.url, files: files.map((f) => f.path), checked_by: s?.checked_by ?? null } });
      return { text: `Installed the skill ${name} (${files.length} file${files.length === 1 ? "" : "s"}${s?.checked_by ? `, checked by ${s.checked_by}` : ""}). It's in your skills list from your next conversation on.` };
    } catch (e) { return { text: `Couldn't install it: ${(e as Error).message}`, isError: true }; }
  },
};

// A GitHub skill folder (through the public API), or one raw SKILL.md. Text files only, 20 at most, 300 KB in all.
async function fetchSkill(url: string): Promise<{ path: string; content: string }[]> {
  const get = async (u: string) => { const r = await fetch(u, { headers: { "user-agent": "peeblo", accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(20_000) }); if (!r.ok) throw new Error(`${u} answered ${r.status}`); return r; };
  const tree = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:tree|blob)\/([^/]+)\/?(.*)$/.exec(url);
  if (!tree) {
    if (!/^https:\/\//.test(url)) throw new Error("give an https link");
    return [{ path: "SKILL.md", content: (await (await get(url)).text()).slice(0, 200_000) }];
  }
  const [, owner, repo, ref, rawPath] = tree;
  const base = rawPath.replace(/\/?SKILL\.md$/, "").replace(/\/$/, "");
  const out: { path: string; content: string }[] = [];
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    const items = (await (await get(`https://api.github.com/repos/${owner}/${repo}/contents/${dir}?ref=${encodeURIComponent(ref)}`)).json()) as any[];
    for (const it of Array.isArray(items) ? items : []) {
      if (out.length >= 20) return;
      if (it.type === "dir") { await walk(it.path); continue; }
      if (it.type !== "file" || it.size > 100_000 || !/\.(md|txt|json|ya?ml|csv|py|sh|js|ts)$/i.test(it.name)) continue;
      const text = await (await get(it.download_url)).text();
      total += text.length;
      if (total > 300_000) throw new Error("the skill is bigger than 300 KB of text");
      out.push({ path: it.path.slice(base ? base.length + 1 : 0), content: text });
    }
  };
  await walk(base);
  if (!out.some((f) => f.path === "SKILL.md")) throw new Error("no SKILL.md in that folder");
  return out;
}
