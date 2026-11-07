// The environment controller: one Gondolin micro-VM per teammate. The VM boots on the first command and
// sleeps after a quiet spell. Its size follows the teammate's tier (small: shell, files and code; large: more
// memory and CPU, and an image with a headless browser). It keeps /workspace (a host folder) and its own root
// disk, saved as a disk checkpoint on sleep, so packages its build recipe installs stay. It holds no secrets
// and gets a bare environment. Network leaves only to the teammate's allowed hosts, and git push is refused here
// until approvals can let it through. A VM that dies becomes "asleep"; the next command boots a new one.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHttpHooks, RealFSProvider, VM, VmCheckpoint } from "@earendil-works/gondolin";
import { checkAction, ruleMessage } from "../otari/rules.ts";
import { config } from "../config.ts";
import { pool } from "../db.ts";
import { appendEvent } from "../store/events.ts";
import { secretsForVm } from "../store/secrets.ts";
import { getTeammate } from "../store/teammates.ts";

type Live = { vm: VM; idle?: NodeJS.Timeout; booted: number; disk: string };
const live = new Map<string, Live>();
const booting = new Map<string, Promise<Live>>();

const BARE_ENV = { PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/root", LANG: "C.UTF-8", TERM: "dumb" };
export const TIERS = {
  small: { memory: "1G", cpus: 1, disk: "4G" },
  large: { memory: "4G", cpus: 2, disk: "8G" },
} as const;
const DEFAULT_HOSTS = ["dl-cdn.alpinelinux.org", "github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com", "registry.npmjs.org", "pypi.org", "files.pythonhosted.org"];

// The small tier's image (shell, git, node, python) and the large tier's (the same plus a headless browser).
export function imagePath(size: "small" | "large" = "small"): string {
  if (size === "small" && config.vmImage) return config.vmImage;
  return join(config.dataDir, "images", `teammate-${size === "large" ? "browser-" : ""}${config.vmArch}`);
}

export function workspaceOf(slug: string): string {
  return join(config.dataDir, "teammates", slug, "workspace");
}
// The teammate's root disk for one tier (a disk checkpoint; a tier change starts a fresh disk).
export function diskOf(slug: string, size: "small" | "large"): string {
  return join(config.dataDir, "teammates", slug, `disk-${size}.qcow2`);
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
  // Secrets: the VM sees placeholders; the real value goes out only on requests to the secret's hosts.
  const secrets = await secretsForVm(tm.id);
  const allowed = [...new Set([...DEFAULT_HOSTS, ...(((tm.config as any).computer?.allowed_hosts as string[]) ?? []), ...Object.values(secrets).flatMap((x) => x.hosts)])];
  const { httpHooks, env } = createHttpHooks({
    allowedHosts: allowed,
    secrets,
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
  const size = tm.config.computer?.size ?? "small";
  const tier = TIERS[size];
  const disk = diskOf(tm.slug, size);
  const options = {
    sessionLabel: `peeblo ${tm.slug}`,
    sandbox: { imagePath: imagePath(size), ...(crossArch ? { append: "console=ttyS0 initramfs_async=1" } : {}) },
    memory: tier.memory, cpus: tier.cpus, rootfs: { mode: "cow" as const, size: tier.disk },
    httpHooks,
    env: { ...env, ...BARE_ENV },
    vfs: { mounts: { "/workspace": new RealFSProvider(workspace) } },
  };
  // Wake on the saved root disk; if it can't be used (e.g. the image was rebuilt), start a fresh one.
  let vm: VM;
  let resumed = false;
  if (existsSync(disk)) {
    try { vm = await VmCheckpoint.load(disk).resume<VM>(options); resumed = true; }
    catch (e) {
      await appendEvent({ type: "env.disk_reset", data: { teammate_id: tm.id, error: (e as Error).message.slice(0, 300) } });
      vm = await VM.create(options);
    }
  } else vm = await VM.create(options);
  await vm.exec(["/bin/sh", "-c", "git config --global --add safe.directory '*' 2>/dev/null; true"]);
  // Chromium trusts only its NSS store, so the large tier adds Gondolin's egress CA there (TLS stays checked).
  if (size === "large") await vm.exec(["/bin/sh", "-c", "d=sql:/root/.pki/nssdb; mkdir -p /root/.pki/nssdb; [ -f /root/.pki/nssdb/cert9.db ] || certutil -d $d -N --empty-password; certutil -d $d -A -t C,, -n gondolin-egress -i /etc/gondolin/mitm/ca.crt"]);
  const l: Live = { vm, booted: Date.now(), disk };
  live.set(tm.id, l);
  await setState(tm.id, "awake", vm.id, workspace);
  await appendEvent({ type: "env.booted", data: { teammate_id: tm.id, vm_id: vm.id, ms: Date.now() - t0, size, memory: tier.memory, cpus: tier.cpus, resumed } });
  await runRecipe(tm.id, vm, tm.config.computer?.recipe ?? []);
  return l;
}

// The build recipe: setup commands that run once into the root disk, and again only when the recipe changes.
// Each command goes through the rule engine first; a refused command stops the recipe. The recipe's hash is
// kept on the disk, so an unchanged recipe never reruns (and a fresh disk runs it again).
const RECIPE_MARK = "/var/lib/peeblo/recipe.sha256";
async function runRecipe(teammateId: string, vm: VM, recipe: string[]): Promise<void> {
  if (!recipe.length) return;
  const hash = createHash("sha256").update(JSON.stringify(recipe)).digest("hex");
  const have = (await vm.exec(["/bin/sh", "-c", `cat ${RECIPE_MARK} 2>/dev/null; true`])).stdout.trim();
  if (have === hash) return;
  const t0 = Date.now();
  const steps: { command: string; exit_code: number | null; ms: number }[] = [];
  for (const command of recipe) {
    const d = await checkAction({ commands: [command] });
    if (d.decision !== "allow") {
      await appendEvent({ type: "env.recipe", data: { teammate_id: teammateId, ok: false, hash, steps, refused: { command, decision: d.decision, reason: ruleMessage(d) } } });
      return;
    }
    const s0 = Date.now();
    const r = await vm.exec(["/bin/sh", "-c", command], { cwd: "/root", env: BARE_ENV, signal: AbortSignal.timeout(10 * 60_000) }).catch((e) => ({ exitCode: null, stdout: "", stderr: String(e) }));
    steps.push({ command, exit_code: r.exitCode, ms: Date.now() - s0 });
    if (r.exitCode !== 0) {
      await appendEvent({ type: "env.recipe", data: { teammate_id: teammateId, ok: false, hash, steps, stderr: String(r.stderr).slice(-1000) } });
      return;
    }
  }
  await vm.exec(["/bin/sh", "-c", `mkdir -p /var/lib/peeblo && echo ${hash} > ${RECIPE_MARK} && sync`]);
  await appendEvent({ type: "env.recipe", data: { teammate_id: teammateId, ok: true, hash, steps, ms: Date.now() - t0 } });
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
  // Saving the root disk also stops the VM; if that fails, close it (the last saved disk stays).
  await mkdir(dirname(l.disk), { recursive: true });
  await l.vm.checkpoint(l.disk).catch(async (e) => {
    await appendEvent({ type: "env.disk_save_failed", data: { teammate_id: teammateId, error: (e as Error).message.slice(0, 300) } });
    await l.vm.close().catch(() => {});
  });
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
