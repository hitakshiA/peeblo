// Skills: instructions a teammate loads when a task matches, from Peeblo's own skills/ folder (Anthropic's
// SKILL.md format: name and description frontmatter, the body read on demand, more files beside it if needed).
// Pi lists skills only when a tool named read or bash exists, and Peeblo's teammates have neither (their files are
// in a VM; the manager has no computer). So Peeblo writes the same <available_skills> list into the system prompt,
// and read_skill opens a skill's files, never anything outside skills/.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { config } from "./config.ts";
import { join, normalize, sep } from "node:path";
import type { Teammate } from "./store/teammates.ts";

const DIR = join(import.meta.dirname, "..", "skills");
// Skills a teammate learned on the job (skill_save, approved by a person), one folder each, beside its memory.
const learnedDir = (slug: string) => join(config.dataDir, "teammates", slug, "skills");
const learned = (slug: string) => (existsSync(learnedDir(slug)) ? readdirSync(learnedDir(slug)).filter((n) => existsSync(join(learnedDir(slug), n, "SKILL.md"))) : []);
const dirOf = (tm: Teammate, name: string) => (existsSync(join(DIR, name, "SKILL.md")) ? join(DIR, name) : join(learnedDir(tm.slug), name));
export const SKILL_NAME = /^[a-z][a-z0-9-]{2,40}$/;

// Saves a learned skill (the approval happened at the tool's gate). A built-in skill's name can't be taken.
export function saveSkill(tm: Teammate, name: string, description: string, body: string): string {
  if (!SKILL_NAME.test(name)) throw new Error("A skill name is 3–41 lowercase letters, digits or dashes, e.g. closing-the-month.");
  if (existsSync(join(DIR, name))) throw new Error(`${name} is one of Peeblo's own skills; pick another name.`);
  const dir = join(learnedDir(tm.slug), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description.replace(/\n/g, " ").slice(0, 300)}\n---\n\n${body.trim()}\n`);
  return dir;
}

// More files inside a learned skill's folder (a checklist, a template, a script it points to). Paths stay inside it.
export function saveSkillFiles(tm: Teammate, name: string, files: { path: string; content: string }[]): string[] {
  const dir = join(learnedDir(tm.slug), name);
  const saved: string[] = [];
  for (const f of files.slice(0, 20)) {
    const target = normalize(join(dir, f.path));
    if (!target.startsWith(dir + sep) || /(^|\/)\.\.?(\/|$)/.test(f.path)) continue;
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, String(f.content).slice(0, 200_000));
    saved.push(f.path);
  }
  return saved;
}
// A skill installed whole (its own SKILL.md with frontmatter, plus its files). A built-in skill's name can't be taken.
export function installSkill(tm: Teammate, name: string, files: { path: string; content: string }[]): string {
  if (!SKILL_NAME.test(name)) throw new Error("A skill name is 3–41 lowercase letters, digits or dashes.");
  if (existsSync(join(DIR, name))) throw new Error(`${name} is one of Peeblo's own skills; it can't be replaced.`);
  if (!files.some((f) => f.path === "SKILL.md")) throw new Error("A skill needs a SKILL.md.");
  mkdirSync(join(learnedDir(tm.slug), name), { recursive: true });
  saveSkillFiles(tm, name, files);
  return join(learnedDir(tm.slug), name);
}
export function removeSkill(tm: Teammate, name: string): boolean {
  const dir = join(learnedDir(tm.slug), name);
  if (!SKILL_NAME.test(name) || !existsSync(join(dir, "SKILL.md"))) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

export function skillsFor(tm: Teammate): string[] {
  const computer = tm.config.tools.includes("computer");
  return [
    ...(tm.slug === "peeblo" ? ["working-as-chief-of-staff", "hiring-a-teammate", "writing-job-specs", "channel-etiquette", "company-setup", "changing-otari-settings"] : []),
    "writing-routines", "tidying-memory", "reviewing-work", "writing-in-slack", "working-with-numbers", "handling-approvals",
    "answering-incident-questions", "reconciling-records", "replying-to-customers",
    ...(computer ? ["writing-recipes", ...(((tm.config.computer as any)?.repos ?? []).length ? ["working-in-repos"] : [])] : []),
  ].filter((s) => existsSync(join(DIR, s, "SKILL.md"))).concat(learned(tm.slug));
}

function frontmatter(tm: Teammate, name: string): { name: string; description: string } {
  const text = readFileSync(join(dirOf(tm, name), "SKILL.md"), "utf8");
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const get = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, "m").exec(fm)?.[1]?.trim() ?? "";
  return { name: get("name") || name, description: get("description") };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function skillsPrompt(tm: Teammate): string {
  const list = skillsFor(tm).map((n) => frontmatter(tm, n));
  if (!list.length) return "";
  return [
    "The following skills provide specialized instructions for specific tasks.",
    "When a task matches a skill's description, call read_skill with its name before you start, and follow it.",
    "read_skill is the only way to open a skill: skills aren't files you can reach from code execution or a computer.",
    "",
    "<available_skills>",
    ...list.flatMap((s) => ["  <skill>", `    <name>${esc(s.name)}</name>`, `    <description>${esc(s.description)}</description>`, "  </skill>"]),
    "</available_skills>",
  ].join("\n");
}

// A skill's SKILL.md, or another file inside that skill's folder. Only skills this teammate has.
export function readSkill(tm: Teammate, name: string, file?: string | null): string {
  if (!skillsFor(tm).includes(name)) throw new Error(`No skill called ${name} here; the list in your instructions has the ones you can use.`);
  const base = realpathSync(dirOf(tm, name));
  const target = normalize(join(base, file || "SKILL.md"));
  if (!target.startsWith(base + sep) || !existsSync(target)) throw new Error(`${file} isn't a file of the ${name} skill.`);
  if (!realpathSync(target).startsWith(base + sep)) throw new Error(`${file} isn't a file of the ${name} skill.`);
  return readFileSync(target, "utf8").slice(0, 40_000);
}
