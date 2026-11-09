// The teammate's computer: a Gondolin micro-VM (one per teammate) with its workspace mounted from the host.
// Each session works in its own folder, /workspace/sessions/<session>, or, once it opens a repo (repo_open), in
// that repo's checkout on the VM's own disk, /work/<session>/<repo>. bash runs in the VM (bare environment, a
// timeout, cwd = the open checkout or the session folder). Files under /workspace are read and written through the
// host mount; files under /work/<session> inside the VM. Every command and file access is checked
// by the rule engine first (required gates refuse, advisory gates ask a person). Changes are local to the
// teammate's own computer, so they run without a card, one at a time, and writes return the re-read diff.
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { exec as vmExec, workspaceOf } from "../environment/controller.ts";
import { checkAction, ruleMessage } from "../otari/rules.ts";
import { CACHE_ENV, worktreesOf } from "../environment/repos.ts";
import { object } from "./schema.ts";
import type { AgentTool, ToolContext } from "./types.ts";

const GUEST = "/workspace";
const MAX_OUT = 30_000;
const sessionDir = (ctx: ToolContext) => `sessions/${ctx.sessionId}`;

// The session's own folder on /workspace (for files that aren't in a repo).
async function sessionFolder(ctx: ToolContext): Promise<void> {
  const dir = join(workspaceOf(ctx.teammate.slug), sessionDir(ctx));
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
}
// The session's open checkout (the newest), if it has one.
async function checkout(ctx: ToolContext): Promise<string | null> {
  return (await worktreesOf(ctx.sessionId)).pop()?.path ?? null;
}

// A path the model gave: on the host mount (/workspace, or relative to the session folder), or in the VM
// (/work/<session>/…, or relative to the open checkout). Anything else is refused.
type Target = { where: "host"; rel: string; host: string } | { where: "vm"; rel: string; guest: string };
// Commands whose output comes from the network (a fetch, a clone, a package registry, an API call).
const SHARED_FILES = /sessions\/[^\s/]+\/files(\/|\b)|(^|[\s"'])files\//;
const NETWORK = /\b(curl|wget|http|https|git\s+(clone|pull|fetch)|gh\s|npx|pip3?\s+download|npm\s+view|xh\s|nc\s|ssh\s|scp\s)\b/i;

async function target(ctx: ToolContext, p: string): Promise<Target | null> {
  const own = `/work/${ctx.sessionId}/`;
  const co = p.startsWith("/") ? null : await checkout(ctx);
  const vmPath = p.startsWith("/work/") ? normalize(p) : co ? normalize(join(co, p)) : null;
  if (vmPath !== null) return vmPath.startsWith(own) ? { where: "vm", rel: vmPath, guest: vmPath } : null;
  const r = await contained(ctx, p);
  return r ? { where: "host", ...r } : null;
}
function resolve(ctx: ToolContext, p: string): { rel: string; host: string } | null {
  const raw = p.startsWith(`${GUEST}/`) ? p.slice(GUEST.length + 1) : p.startsWith("/") ? null : join(sessionDir(ctx), p);
  if (raw === null) return null;
  const rel = normalize(raw);
  if (rel.startsWith("..") || rel.startsWith("/")) return null;
  return { rel, host: join(workspaceOf(ctx.teammate.slug), rel) };
}

// A host path, also refused if a symlink (the VM can make them) leads the host-side file tools out of the
// workspace. The nearest existing part of the path is resolved; a dangling link counts as leaving.
async function contained(ctx: ToolContext, p: string): Promise<{ rel: string; host: string } | null> {
  const r = resolve(ctx, p);
  if (!r) return null;
  const root = await realpath(workspaceOf(ctx.teammate.slug)).catch(() => null);
  if (!root) return r; // no workspace yet: nothing on disk to follow
  for (let at = r.host; ; at = dirname(at)) {
    const real = await realpath(at).catch(() => null);
    if (real) return real === root || real.startsWith(root + sep) ? r : null;
    if (await lstat(at).then(() => true, () => false)) return null; // exists but can't resolve: a dangling link
    if (dirname(at) === at) return null;
  }
}

// Files in the VM (a checkout on the VM disk), moved as base64 so any bytes survive.
async function vmRead(ctx: ToolContext, guest: string): Promise<string | null> {
  const r = await vmExec(ctx.teammate.id, ["sh", "-c", 'test -f "$1" && base64 -w0 "$1"', "sh", guest], { sessionId: ctx.sessionId });
  return r.exitCode === 0 ? Buffer.from(r.stdout.trim(), "base64").toString("utf8") : null;
}
async function vmWrite(ctx: ToolContext, guest: string, content: string): Promise<void> {
  const b64 = Buffer.from(content, "utf8").toString("base64");
  const CHUNK = 96_000;
  for (let i = 0; i === 0 || i < b64.length; i += CHUNK) {
    const r = await vmExec(ctx.teammate.id, ["sh", "-c", `mkdir -p "$(dirname "$2")" && printf %s "$1" | base64 -d ${i === 0 ? ">" : ">>"} "$2"`, "sh", b64.slice(i, i + CHUNK), guest], { sessionId: ctx.sessionId });
    if (r.exitCode !== 0) throw new Error(r.stderr.slice(-200) || "write failed");
  }
}
const readT = (ctx: ToolContext, t: Target) => (t.where === "host" ? stat(t.host).then(() => readFile(t.host, "utf8"), () => null) : vmRead(ctx, t.guest));
const writeT = async (ctx: ToolContext, t: Target, c: string) => { if (t.where === "host") { await mkdir(dirname(t.host), { recursive: true }); await writeFile(t.host, c); } else await vmWrite(ctx, t.guest, c); };

// The rule engine's answer for an action; a refusal or "ask" sentence, or null to go ahead.
async function rules(action: Parameters<typeof checkAction>[0]): Promise<{ deny?: string; ask?: string } | null> {
  const d = await checkAction(action);
  if (d.decision === "deny") return { deny: `Refused by the computer's rules: ${ruleMessage(d)}` };
  if (d.decision === "ask") return { ask: ruleMessage(d) };
  return null;
}

const tail = (s: string) => (s.length > MAX_OUT ? `[first ${s.length - MAX_OUT} characters cut]\n${s.slice(-MAX_OUT)}` : s);

export const computerTools: AgentTool[] = [
  {
    name: "computer_bash",
    description: "Run a shell command on your own Linux computer (python3, duckdb, sqlite, jq, ripgrep, git, pdftotext, ffmpeg, imagemagick, node). Free, but it can take a few seconds to wake. The working directory is your open repo checkout (see repo_open), else your session's folder. Use it where your files are: repos, git, builds and tests; files people shared and long tool results Peeblo saved here; joining data from several sources; work with many steps or longer than 30 seconds; installs; anything you or a person will need later. For a quick exact calculation on numbers already in the conversation, run_code is faster. Commands stop after the timeout.",
    input_schema: object({
      command: { type: "string" },
      timeout_seconds: { type: ["integer", "null"], minimum: 1, maximum: 600, description: "Default 120." },
    }),
    describe(ctx, a) { return { summary: `Run on ${ctx.teammate.config.name}'s computer: ${String(a.command ?? "").replace(/\s+/g, " ").slice(0, 140)}` }; },
    kind: "local",
    async gate(_ctx, a) { return rules({ commands: [a.command] }); },
    async run(ctx, a) {
      await sessionFolder(ctx);
      const cwd = (await checkout(ctx)) ?? `${GUEST}/${sessionDir(ctx)}`;
      const r = await vmExec(ctx.teammate.id, ["sh", "-c", a.command], { cwd, timeoutMs: (a.timeout_seconds ?? 120) * 1000, sessionId: ctx.sessionId, env: CACHE_ENV });
      // A fact: ad-hoc installs land on the working disk, which a reset throws away.
      const install = /\b(apk add|npm (i|install)\b.*(-g|--global)|pip3? install|uv pip install|uv tool install|apt(-get)? install)\b/.test(a.command);
      const note = install && r.exitCode === 0 ? "\n[peeblo: this install is lost at the next computer reset unless it's in your recipe.]" : "";
      const text = `exit ${r.exitCode} (${(r.ms / 1000).toFixed(1)} s)\n${tail(r.stdout)}${r.stderr ? `\n[stderr]\n${tail(r.stderr)}` : ""}${note}`;
      // Untrusted only when it really came from outside: a repo checkout (other people's code) or the
      // network. The teammate's own files and commands in its workspace are its own work.
      // Files people shared (sessions/<id>/files) are outside text too, read any way.
      const outside = Boolean(await checkout(ctx)) || NETWORK.test(a.command) || SHARED_FILES.test(a.command);
      return { text, isError: r.exitCode !== 0, ...(outside ? { untrusted: "computer:bash" } : {}), data: { exit_code: r.exitCode, ms: r.ms } };
    },
  },
  {
    name: "computer_read",
    description: "Read a text file on your computer (a path in your session's folder, or under /workspace).",
    input_schema: object({ path: { type: "string" }, offset: { type: ["integer", "null"], minimum: 1, description: "First line, from 1." }, limit: { type: ["integer", "null"], minimum: 1, maximum: 2000 } }),
    kind: "read",
    async gate(ctx, a) {
      const p = await target(ctx, a.path);
      if (!p) return { deny: `${a.path} is outside your workspace and your own checkouts.` };
      return rules({ paths: [p.rel], pathSource: "pre_tool_use.read_target" });
    },
    async run(ctx, a) {
      await sessionFolder(ctx);
      const p = await target(ctx, a.path);
      if (!p) return { text: `${a.path} is outside your workspace.`, isError: true };
      const body = await readT(ctx, p);
      if (body === null) return { text: `${a.path} doesn't exist.`, isError: true };
      const lines = body.split("\n");
      const from = (a.offset ?? 1) - 1;
      const part = lines.slice(from, from + (a.limit ?? 2000));
      return { text: `${part.map((l, i) => `${from + i + 1}\t${l}`).join("\n")}${from + part.length < lines.length ? `\n[${lines.length - from - part.length} more lines]` : ""}`, ...(p.where === "vm" ? { untrusted: `computer:${p.rel}` } : SHARED_FILES.test(p.rel) ? { untrusted: `file:${p.rel.split("/").pop()}` } : {}) };
    },
  },
  {
    name: "computer_write",
    description: "Create or replace a file on your computer.",
    input_schema: object({ path: { type: "string" }, content: { type: "string" } }),
    kind: "local",
    async gate(ctx, a) {
      const p = await target(ctx, a.path);
      if (!p) return { deny: `${a.path} is outside your workspace and your own checkouts.` };
      return rules({ paths: [p.rel], pathSource: "pre_tool_use.edit_target" });
    },
    async run(ctx, a) {
      await sessionFolder(ctx);
      const p = await target(ctx, a.path);
      if (!p) return { text: `${a.path} is outside your workspace.`, isError: true };
      const before = await readT(ctx, p);
      await writeT(ctx, p, a.content);
      const after = (await readT(ctx, p)) ?? "";
      if (after !== a.content) return { text: `The file on disk doesn't match what was written (${p.rel}).`, isError: true };
      return { text: `${before === null ? "Created" : "Replaced"} ${p.rel} (${after.split("\n").length} lines, ${after.length} characters).`, data: { path: p.rel, created: before === null } };
    },
  },
  {
    name: "computer_edit",
    description: "Replace one exact piece of text in a file on your computer. old_text must appear exactly once.",
    input_schema: object({ path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }),
    kind: "local",
    async gate(ctx, a) {
      const p = await target(ctx, a.path);
      if (!p) return { deny: `${a.path} is outside your workspace and your own checkouts.` };
      return rules({ paths: [p.rel], pathSource: "pre_tool_use.edit_target" });
    },
    async run(ctx, a) {
      await sessionFolder(ctx);
      const p = await target(ctx, a.path);
      if (!p) return { text: `${a.path} is outside your workspace.`, isError: true };
      const before = await readT(ctx, p);
      if (before === null) return { text: `${a.path} doesn't exist.`, isError: true };
      const n = before.split(a.old_text).length - 1;
      if (n !== 1) return { text: n === 0 ? `old_text isn't in ${p.rel}; read the file and copy the exact text.` : `old_text appears ${n} times in ${p.rel}; include more surrounding text so it appears once.`, isError: true };
      await writeT(ctx, p, before.replace(a.old_text, a.new_text));
      const after = (await readT(ctx, p)) ?? "";
      const at = before.slice(0, before.indexOf(a.old_text)).split("\n").length;
      return { text: `Edited ${p.rel} at line ${at}:\n- ${a.old_text.split("\n").join("\n- ")}\n+ ${a.new_text.split("\n").join("\n+ ")}`, data: { path: p.rel, line: at, changed: after !== before } };
    },
  },
];
