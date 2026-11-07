// The teammate's computer: a Gondolin micro-VM (one per teammate) with its workspace mounted from the host.
// Each session works in its own folder, /workspace/sessions/<session>. bash runs in the VM (bare environment,
// a timeout); files are read and written through the host mount. Every command and file access is checked
// by the rule engine first (required gates refuse, advisory gates ask a person). Changes are local to the
// teammate's own computer, so they run without a card, one at a time, and writes return the re-read diff.
import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { exec as vmExec, workspaceOf } from "../environment/controller.ts";
import { checkAction, ruleMessage } from "../otari/rules.ts";
import { object } from "./schema.ts";
import type { AgentTool, ToolContext } from "./types.ts";

const GUEST = "/workspace";
const MAX_OUT = 30_000;
const sessionDir = (ctx: ToolContext) => `sessions/${ctx.sessionId}`;

// A path the model gave, as a workspace-relative path; refused if it leaves the workspace.
function resolve(ctx: ToolContext, p: string): { rel: string; host: string } | null {
  const raw = p.startsWith(`${GUEST}/`) ? p.slice(GUEST.length + 1) : p.startsWith("/") ? null : join(sessionDir(ctx), p);
  if (raw === null) return null;
  const rel = normalize(raw);
  if (rel.startsWith("..") || rel.startsWith("/")) return null;
  return { rel, host: join(workspaceOf(ctx.teammate.slug), rel) };
}

// The same path, also refused if a symlink (the VM can make them) leads the host-side file tools out of the
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
    description: "Run a shell command on your own Linux computer (Alpine; your session's folder is the working directory). For repos, builds, tests and scripts. Commands stop after the timeout.",
    input_schema: object({
      command: { type: "string" },
      timeout_seconds: { type: ["integer", "null"], minimum: 1, maximum: 600, description: "Default 120." },
    }),
    kind: "local",
    async gate(_ctx, a) { return rules({ commands: [a.command] }); },
    async run(ctx, a) {
      await mkdir(join(workspaceOf(ctx.teammate.slug), sessionDir(ctx)), { recursive: true });
      const r = await vmExec(ctx.teammate.id, ["sh", "-c", a.command], { cwd: `${GUEST}/${sessionDir(ctx)}`, timeoutMs: (a.timeout_seconds ?? 120) * 1000 });
      const text = `exit ${r.exitCode} (${(r.ms / 1000).toFixed(1)} s)\n${tail(r.stdout)}${r.stderr ? `\n[stderr]\n${tail(r.stderr)}` : ""}`;
      return { text, isError: r.exitCode !== 0, untrusted: "computer:bash", data: { exit_code: r.exitCode, ms: r.ms } };
    },
  },
  {
    name: "computer_read",
    description: "Read a text file on your computer (a path in your session's folder, or under /workspace).",
    input_schema: object({ path: { type: "string" }, offset: { type: ["integer", "null"], minimum: 1, description: "First line, from 1." }, limit: { type: ["integer", "null"], minimum: 1, maximum: 2000 } }),
    kind: "read",
    async gate(ctx, a) {
      const p = await contained(ctx, a.path);
      if (!p) return { deny: `${a.path} is outside your workspace.` };
      return rules({ paths: [p.rel], pathSource: "pre_tool_use.read_target" });
    },
    async run(ctx, a) {
      const p = await contained(ctx, a.path);
      if (!p) return { text: `${a.path} is outside your workspace.`, isError: true };
      const lines = (await readFile(p.host, "utf8")).split("\n");
      const from = (a.offset ?? 1) - 1;
      const part = lines.slice(from, from + (a.limit ?? 2000));
      return { text: `${part.map((l, i) => `${from + i + 1}\t${l}`).join("\n")}${from + part.length < lines.length ? `\n[${lines.length - from - part.length} more lines]` : ""}`, untrusted: `computer:${p.rel}` };
    },
  },
  {
    name: "computer_write",
    description: "Create or replace a file on your computer.",
    input_schema: object({ path: { type: "string" }, content: { type: "string" } }),
    kind: "local",
    async gate(ctx, a) {
      const p = await contained(ctx, a.path);
      if (!p) return { deny: `${a.path} is outside your workspace.` };
      return rules({ paths: [p.rel], pathSource: "pre_tool_use.edit_target" });
    },
    async run(ctx, a) {
      const p = await contained(ctx, a.path);
      if (!p) return { text: `${a.path} is outside your workspace.`, isError: true };
      const before = await stat(p.host).then(() => readFile(p.host, "utf8"), () => null);
      await mkdir(dirname(p.host), { recursive: true });
      await writeFile(p.host, a.content);
      const after = await readFile(p.host, "utf8");
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
      const p = await contained(ctx, a.path);
      if (!p) return { deny: `${a.path} is outside your workspace.` };
      return rules({ paths: [p.rel], pathSource: "pre_tool_use.edit_target" });
    },
    async run(ctx, a) {
      const p = await contained(ctx, a.path);
      if (!p) return { text: `${a.path} is outside your workspace.`, isError: true };
      const before = await readFile(p.host, "utf8");
      const n = before.split(a.old_text).length - 1;
      if (n !== 1) return { text: n === 0 ? `old_text isn't in ${p.rel}; read the file and copy the exact text.` : `old_text appears ${n} times in ${p.rel}; include more surrounding text so it appears once.`, isError: true };
      await writeFile(p.host, before.replace(a.old_text, a.new_text));
      const after = await readFile(p.host, "utf8");
      const at = before.slice(0, before.indexOf(a.old_text)).split("\n").length;
      return { text: `Edited ${p.rel} at line ${at}:\n- ${a.old_text.split("\n").join("\n- ")}\n+ ${a.new_text.split("\n").join("\n+ ")}`, data: { path: p.rel, line: at, changed: after !== before } };
    },
  },
];
