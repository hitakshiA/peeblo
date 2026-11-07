// The environment controller: one Gondolin micro-VM per teammate. The VM boots on the first command,
// sleeps after a quiet spell, and keeps only its /workspace (a host folder). It holds no secrets and gets
// a bare environment. Network leaves only to the teammate's allowed hosts, and git push is refused here
// until approvals can let it through. A VM that dies becomes "asleep"; the next command boots a new one.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createHttpHooks, RealFSProvider, VM } from "@earendil-works/gondolin";
import { config } from "../config.ts";
import { pool } from "../db.ts";
import { appendEvent } from "../store/events.ts";
import { getTeammate } from "../store/teammates.ts";

type Live = { vm: VM; idle?: NodeJS.Timeout; booted: number };
const live = new Map<string, Live>();
const booting = new Map<string, Promise<Live>>();

const BARE_ENV = { PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/root", LANG: "C.UTF-8", TERM: "dumb" };
const DEFAULT_HOSTS = ["github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com", "registry.npmjs.org", "pypi.org", "files.pythonhosted.org"];

export function imagePath(): string {
  return config.vmImage || join(config.dataDir, "images", `teammate-${config.vmArch}`);
}

export function workspaceOf(slug: string): string {
  return join(config.dataDir, "teammates", slug, "workspace");
}

async function setState(teammateId: string, state: "asleep" | "booting" | "awake", vmId: string | null, workspace: string): Promise<void> {
  await pool.query(
    `INSERT INTO environments (teammate_id, state, vm_id, workspace) VALUES ($1, $2, $3, $4)
     ON CONFLICT (teammate_id) DO UPDATE SET state = EXCLUDED.state, vm_id = EXCLUDED.vm_id, updated_at = now()`,
    [teammateId, state, vmId, workspace],
  );
}

async function boot(teammateId: string): Promise<Live> {
  const tm = await getTeammate(teammateId);
  if (!tm) throw new Error(`no teammate ${teammateId}`);
  const workspace = workspaceOf(tm.slug);
  await mkdir(workspace, { recursive: true });
  await setState(tm.id, "booting", null, workspace);
  const allowed = [...new Set([...DEFAULT_HOSTS, ...(((tm.config as any).computer?.allowed_hosts as string[]) ?? [])])];
  const { httpHooks, env } = createHttpHooks({
    allowedHosts: allowed,
    onRequest: async (req) => {
      const u = new URL(req.url);
      if (u.pathname.endsWith("/git-receive-pack") || u.searchParams.get("service") === "git-receive-pack") {
        await appendEvent({ type: "env.blocked", data: { teammate_id: tm.id, reason: "git push needs approval", host: u.host, path: u.pathname } });
        return new Response("peeblo: git push needs a person's approval\n", { status: 403 });
      }
      return undefined;
    },
  });
  const t0 = Date.now();
  const crossArch = config.vmArch === "x86_64" && process.arch === "arm64";
  const vm = await VM.create({
    sessionLabel: `peeblo ${tm.slug}`,
    sandbox: { imagePath: imagePath(), ...(crossArch ? { append: "console=ttyS0 initramfs_async=1" } : {}) },
    httpHooks,
    env: { ...env, ...BARE_ENV },
    vfs: { mounts: { "/workspace": new RealFSProvider(workspace) } },
  });
  await vm.exec(["/bin/sh", "-c", "git config --global --add safe.directory '*' 2>/dev/null; true"]);
  const l: Live = { vm, booted: Date.now() };
  live.set(tm.id, l);
  await setState(tm.id, "awake", vm.id, workspace);
  await appendEvent({ type: "env.booted", data: { teammate_id: tm.id, vm_id: vm.id, ms: Date.now() - t0 } });
  return l;
}

async function ensure(teammateId: string): Promise<Live> {
  const l = live.get(teammateId);
  if (l) return l;
  let p = booting.get(teammateId);
  if (!p) {
    p = boot(teammateId).finally(() => booting.delete(teammateId));
    booting.set(teammateId, p);
  }
  return p;
}

function touch(teammateId: string, l: Live): void {
  if (l.idle) clearTimeout(l.idle);
  l.idle = setTimeout(() => void sleep(teammateId, "idle"), config.vmIdleMs);
}

export async function sleep(teammateId: string, reason: string): Promise<void> {
  const l = live.get(teammateId);
  if (!l) return;
  live.delete(teammateId);
  if (l.idle) clearTimeout(l.idle);
  await l.vm.close().catch(() => {});
  const { rows } = await pool.query<{ workspace: string }>("SELECT workspace FROM environments WHERE teammate_id = $1", [teammateId]);
  await setState(teammateId, "asleep", null, rows[0]?.workspace ?? "");
  await appendEvent({ type: "env.slept", data: { teammate_id: teammateId, reason, awake_ms: Date.now() - l.booted } });
}

export type ExecResult = { exitCode: number; stdout: string; stderr: string; ms: number };

// Runs one command in the teammate's VM. A dead VM is reported as an error and forgotten, so the
// caller sees a failed command (not a hung one) and the next command boots a fresh VM.
export async function exec(teammateId: string, argv: string[], opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ExecResult> {
  const l = await ensure(teammateId);
  touch(teammateId, l);
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 120_000);
  opts.signal?.addEventListener("abort", () => ctl.abort(), { once: true });
  try {
    const r = await l.vm.exec(argv, { cwd: opts.cwd ?? "/workspace", env: BARE_ENV, signal: ctl.signal });
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t0 };
  } catch (error) {
    if (ctl.signal.aborted) return { exitCode: 124, stdout: "", stderr: "timed out", ms: Date.now() - t0 };
    live.delete(teammateId);
    await setState(teammateId, "asleep", null, workspaceOf((await getTeammate(teammateId))?.slug ?? teammateId)).catch(() => {});
    await appendEvent({ type: "env.crashed", data: { teammate_id: teammateId, error: (error as Error).message } });
    throw new Error(`the teammate's computer stopped unexpectedly (${(error as Error).message}); it restarts on the next command`);
  } finally {
    clearTimeout(timer);
  }
}

export function vmFor(teammateId: string): Promise<VM> {
  return ensure(teammateId).then((l) => { touch(teammateId, l); return l.vm; });
}

export async function sleepAll(): Promise<void> {
  await Promise.all([...live.keys()].map((id) => sleep(id, "shutdown")));
}
