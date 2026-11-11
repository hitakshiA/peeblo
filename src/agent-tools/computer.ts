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
import { exec as vmExec, holdAwake, releaseAwake, workspaceOf } from "../environment/controller.ts";
import { config } from "../config.ts";
import { newId } from "../ids.ts";
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

// Every command runs as a job: its output goes to files in the VM (/work/<session>/.jobs/<id>), so a command that
// outlives its timeout keeps running with nothing lost, and long output keeps both its start (the first error) and
// its end. The model sees the head and tail; the full output stays in the files.
const jobDir = (ctx: ToolContext, id: string) => `/work/${ctx.sessionId}/.jobs/${id}`;
const RUN = 'J="$1"; mkdir -p "$J"; cd "$2" || { echo "no such folder: $2" >"$J/err"; echo 1 >"$J/exit"; exit 1; }; (sh -c "$3") >"$J/out" 2>"$J/err" </dev/null & p=$!; echo $p >"$J/pid"; wait $p; c=$?; echo $c >"$J/exit"; exit $c';
// head + tail of a file, the cut marked; then a record separator; stderr the same; then the exit code or "running".
const SHOW = `J="$1"; H="$2"; show() { s=$(wc -c <"$1" 2>/dev/null || echo 0); if [ "$s" -le $((H*2)) ]; then cat "$1" 2>/dev/null; else head -c "$H" "$1"; printf '\n[… %s characters cut; the whole output is in %s …]\n' $((s-H*2)) "$1"; tail -c "$H" "$1"; fi; }; show "$J/out"; printf '\\036'; show "$J/err"; printf '\\036'; cat "$J/exit" 2>/dev/null || echo running`;

async function showJob(ctx: ToolContext, id: string, half = MAX_OUT / 2): Promise<{ out: string; err: string; exit: number | null }> {
  const r = await vmExec(ctx.teammate.id, ["sh", "-c", SHOW, "sh", jobDir(ctx, id), String(half)], { sessionId: ctx.sessionId, timeoutMs: 60_000 });
  const [out = "", err = "", ex = "running"] = r.stdout.split("\u001e");
  const code = ex.trim() === "running" ? null : Number(ex.trim());
  return { out, err, exit: Number.isFinite(code) ? code : null };
}

// Background jobs: the computer stays awake while one runs (up to PEEBLO_BACKGROUND_MAX_MS); when it ends, a job
// still in the conversation hears about it between tool calls.
const watching = new Map<string, { ctx: ToolContext; command: string; started: number }>();
function watchJob(ctx: ToolContext, id: string, command: string): void {
  holdAwake(ctx.teammate.id, id, config.backgroundMaxMs);
  watching.set(id, { ctx, command, started: Date.now() });
  const tick = setInterval(async () => {
    const w = watching.get(id);
    if (!w) return clearInterval(tick);
    const done = await vmExec(ctx.teammate.id, ["sh", "-c", 'cat "$1/exit" 2>/dev/null', "sh", jobDir(ctx, id)], { sessionId: ctx.sessionId, timeoutMs: 30_000 }).catch(() => null);
    const exit = done && done.exitCode === 0 && done.stdout.trim() !== "" ? Number(done.stdout.trim()) : null;
    if (exit === null && Date.now() - w.started < config.backgroundMaxMs) return;
    clearInterval(tick);
    watching.delete(id);
    releaseAwake(ctx.teammate.id, id);
    const { appendEvent } = await import("../store/events.ts");
    await appendEvent({ sessionId: ctx.sessionId, runId: ctx.runId, type: "computer.job.finished", data: { id, exit, command: command.slice(0, 300) } }).catch(() => {});
    const { notifySession } = await import("../pi/supervisor.ts");
    await notifySession(ctx.sessionId, `<peeblo_event kind="job_finished">Your background command ${id} (${command.replace(/\s+/g, " ").slice(0, 120)}) ${exit === null ? "ran out of time and may have been stopped" : `finished with exit ${exit}`}. computer_job shows its output.</peeblo_event>`).catch(() => {});
  }, 15_000);
}

// Long text a tool produced (a transcript, a page, a program's output) goes whole to a file on the computer; the
// model gets the start and the path, and reads the rest there when it needs it.
export async function keepWhole(ctx: ToolContext, name: string, text: string, show: number): Promise<string> {
  if (text.length <= show) return text;
  const path = `/work/${ctx.sessionId}/out/${name.replace(/[^\w.-]+/g, "-").slice(0, 80)}`;
  try {
    await vmWrite(ctx, path, text);
    return `${text.slice(0, show)}\n[… ${(text.length - show).toLocaleString("en-US")} more characters; the whole text is on your computer at ${path}]`;
  } catch {
    return `${text.slice(0, show)}\n[… ${(text.length - show).toLocaleString("en-US")} more characters cut]`;
  }
}

const fmt = (j: { out: string; err: string }) => `${j.out}${j.err ? `\n[stderr]\n${j.err}` : ""}`;

export const computerTools: AgentTool[] = [
  {
    name: "computer_bash",
    description: "Run a shell command on your own Linux computer (python3, duckdb, sqlite, jq, ripgrep, git, pdftotext, ffmpeg, imagemagick, node). The working directory is your open repo checkout (see repo_open), else your session's folder. Use it where your files are: repos, git, builds and tests; files people shared and long tool results Peeblo saved here; joining data from several sources; installs; anything you or a person will need later. For a quick exact calculation on numbers already in the conversation, run_code is faster. A command still running at its timeout keeps going in the background, and so does one you start with run_in_background (a dev server, a long build, a test suite): you get a job id, and computer_job shows its output, waits for it or stops it. Long output shows its start and end; the whole of it stays in a file.",
    input_schema: object({
      command: { type: "string" },
      timeout_seconds: { type: ["integer", "null"], minimum: 1, maximum: 600, description: "How long to wait for it (default 120). It keeps running after that." },
      run_in_background: { type: ["boolean", "null"], description: "Start it and return at once with a job id." },
    }),
    describe(ctx, a) { return { summary: `Run on ${ctx.teammate.config.name}'s computer: ${String(a.command ?? "").replace(/\s+/g, " ").slice(0, 140)}` }; },
    kind: "local",
    async gate(_ctx, a) { return rules({ commands: [a.command] }); },
    async run(ctx, a) {
      await sessionFolder(ctx);
      const co = await checkout(ctx);
      const cwd = co ?? `${GUEST}/${sessionDir(ctx)}`;
      const id = newId("job");
      const J = jobDir(ctx, id);
      // Untrusted only when it came from outside: the network or files people shared (screened by the guard), or
      // other people's code in a repo checkout (labelled, not screened: a test log is the agent's own work).
      const outside = NETWORK.test(a.command) || SHARED_FILES.test(a.command) ? "computer:network" : co ? "computer:repo" : null;
      if (a.run_in_background) {
        const r = await vmExec(ctx.teammate.id, ["sh", "-c", `(setsid sh -c "$0" "$@" || sh -c "$0" "$@") >/dev/null 2>&1 </dev/null &`, RUN, "sh", J, cwd, a.command], { cwd, sessionId: ctx.sessionId, env: CACHE_ENV, timeoutMs: 30_000 });
        if (r.exitCode !== 0) return { text: `Couldn't start it: ${r.stderr.slice(-500)}`, isError: true };
        watchJob(ctx, id, a.command);
        return { text: `Started in the background as job ${id}. Use computer_job to see its output, wait for it, or stop it.`, data: { job: id } };
      }
      const r = await vmExec(ctx.teammate.id, ["sh", "-c", RUN, "sh", J, cwd, a.command], { cwd, timeoutMs: (a.timeout_seconds ?? 120) * 1000, sessionId: ctx.sessionId, env: CACHE_ENV });
      const j = await showJob(ctx, id);
      if (r.timedOut) {
        watchJob(ctx, id, a.command);
        return { text: `Still running after ${a.timeout_seconds ?? 120} s, so it carries on in the background as job ${id} (computer_job waits for it or stops it). Output so far:\n${fmt(j)}`, ...(outside ? { untrusted: outside } : {}), data: { job: id, ms: r.ms } };
      }
      // A fact: ad-hoc installs land on the working disk, which a reset throws away.
      const install = /\b(apk add|npm (i|install)\b.*(-g|--global)|pip3? install|uv pip install|uv tool install|apt(-get)? install)\b/.test(a.command);
      const note = install && r.exitCode === 0 ? "\n[peeblo: this install is lost at the next computer reset unless it's in your recipe.]" : "";
      const text = `exit ${r.exitCode} (${(r.ms / 1000).toFixed(1)} s)\n${fmt(j)}${note}`;
      return { text, isError: r.exitCode !== 0, ...(outside ? { untrusted: outside } : {}), data: { exit_code: r.exitCode, ms: r.ms } };
    },
  },
  {
    name: "computer_job",
    description: "A command running in the background on your computer (a job id from computer_bash): see its output so far, wait for it to finish (up to 10 minutes per call), or stop it.",
    input_schema: object({
      id: { type: "string", description: "The job id, e.g. job_ab12cd." },
      action: { type: "string", enum: ["status", "wait", "stop"] },
      seconds: { type: ["integer", "null"], minimum: 1, maximum: 600, description: "For wait: the most to wait (default 300)." },
    }),
    kind: "local",
    async run(ctx, a) {
      const id = String(a.id ?? "");
      if (!/^job_[a-z0-9]+$/i.test(id)) return { text: `${id} isn't a job id.`, isError: true };
      const J = jobDir(ctx, id);
      if (a.action === "stop") {
        await vmExec(ctx.teammate.id, ["sh", "-c", 'k() { for c in $(pgrep -P "$1" 2>/dev/null); do k "$c"; done; kill -TERM "$1" 2>/dev/null; }; p=$(cat "$0/pid" 2>/dev/null) && k "$p"; sleep 1; [ -f "$0/exit" ] || echo 143 >"$0/exit"', J], { sessionId: ctx.sessionId, timeoutMs: 30_000 });
        releaseAwake(ctx.teammate.id, id);
        watching.delete(id);
      } else if (a.action === "wait") {
        const secs = a.seconds ?? 300;
        // The wait runs inside the VM with its own limit, so nothing is left looping there.
        await vmExec(ctx.teammate.id, ["sh", "-c", 'timeout "$1" sh -c \'while [ ! -f "$0/exit" ]; do sleep 1; done\' "$0"', J, String(secs)], { sessionId: ctx.sessionId, timeoutMs: (secs + 15) * 1000 });
      }
      const j = await showJob(ctx, id);
      if (!j.out && !j.err && j.exit === null && a.action !== "stop") {
        const exists = await vmExec(ctx.teammate.id, ["sh", "-c", 'test -d "$1"', "sh", J], { sessionId: ctx.sessionId, timeoutMs: 30_000 });
        if (exists.exitCode !== 0) return { text: `There's no job ${id} in this conversation (or its computer was reset).`, isError: true };
      }
      if (j.exit !== null) releaseAwake(ctx.teammate.id, id);
      const state = a.action === "stop" ? "Stopped." : j.exit === null ? "Still running." : `Finished with exit ${j.exit}.`;
      return { text: `${state}\n${fmt(j)}`, untrusted: "computer:job" };
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
