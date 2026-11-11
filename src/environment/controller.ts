// The environment controller: one Gondolin micro-VM per teammate, booted on the first command and put to sleep
// after a quiet spell. Its size follows the teammate's tier: small (shell, files, code, data, documents) or large
// (more memory and CPU, plus a headless browser, office conversion, OCR and media).
//
// A computer is four layers:
// - L0, the base image: one folder per Gondolin buildId (image.ts). A teammate stays pinned to its build until it
//   has no other live session, then moves to the current one at its next boot.
// - L1, the recipe disk: immutable, built once per recipe hash in a separate build VM (recipes.ts).
// - L2, the working disk: resumed from L1 (or L0), saved as a disk checkpoint on sleep. It holds ad-hoc installs,
//   caches and session checkouts, and is thrown away whenever L0 or L1 changes.
// - L3, /workspace: a host folder, the only layer that is never rebuilt.
//
// The VM holds no secrets (placeholders only) and gets a bare environment. Network leaves only to allowed hosts
// (large teammates: any public host for reading, writes only to allowed hosts; internal ranges stay blocked), and
// git push is refused at egress. Awake
// computers are capped per tier and checked against free host memory; the longest-idle one is put to sleep to
// make room. A VM that dies becomes "asleep"; the next command boots a new one.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { freemem, platform } from "node:os";
import { dirname, join } from "node:path";
import { createHttpHooks, RealFSProvider, VM, VmCheckpoint } from "@earendil-works/gondolin";
import { config } from "../config.ts";
import { pool } from "../db.ts";
import { appendEvent } from "../store/events.ts";
import { secretsForVm } from "../store/secrets.ts";
import { getTeammate } from "../store/teammates.ts";
import { buildPath, currentBuild, type Tier } from "./image.ts";

// leases: background jobs keeping the computer awake (job id → when the lease ends).
type Live = { vm: VM; idle?: NodeJS.Timeout; booted: number; lastUsed: number; inflight: number; disk: string; size: Tier; leases: Map<string, number> };
const live = new Map<string, Live>();
const booting = new Map<string, Promise<Live>>();

// Gondolin mounts /root and /var/cache as tmpfs, so a disk checkpoint would drop home-folder config (~/.npmrc,
// ~/.gitconfig) and package caches. Unmounting them puts both on the VM's own disk. /tmp and /var/log stay in memory.
export const PERSIST_HOME = "umount /root 2>/dev/null; umount /var/cache 2>/dev/null; mkdir -p /root /var/cache/peeblo; chmod 700 /root;";
export const BARE_ENV = { PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/root", LANG: "C.UTF-8", TERM: "dumb" };
// memory is a ceiling (QEMU allocates guest RAM lazily); footprint is what an awake one costs the host.
export const TIERS = {
  small: { memory: config.smallMemory, cpus: 2, disk: "4G", footprintMb: 300 },
  large: { memory: "4G", cpus: 4, disk: "8G", footprintMb: 1500 },
} as const;
export const awakeCap = (size: Tier) => (size === "small" ? config.awakeCapSmall : config.awakeCapLarge);
const RESERVE_MB = config.hostReserveMb;
// Package registries and code hosts every build needs: Codex's "Common dependencies" preset
// (learn.chatgpt.com/docs/cloud/internet-access), each domain with its subdomains.
const COMMON_DEPENDENCIES = ["alpinelinux.org", "anaconda.com", "apache.org", "apt.llvm.org", "archlinux.org", "azure.com", "bitbucket.org", "bower.io", "centos.org", "cocoapods.org", "continuum.io", "cpan.org", "crates.io", "debian.org", "docker.com", "docker.io", "dot.net", "dotnet.microsoft.com", "eclipse.org", "fedoraproject.org", "gcr.io", "ghcr.io", "github.com", "githubusercontent.com", "gitlab.com", "golang.org", "google.com", "goproxy.io", "gradle.org", "hashicorp.com", "haskell.org", "hex.pm", "java.com", "java.net", "jcenter.bintray.com", "json-schema.org", "json.schemastore.org", "k8s.io", "launchpad.net", "maven.org", "mcr.microsoft.com", "metacpan.org", "microsoft.com", "nodejs.org", "npmjs.com", "npmjs.org", "nuget.org", "oracle.com", "packagecloud.io", "packages.microsoft.com", "packagist.org", "pkg.go.dev", "ppa.launchpad.net", "pub.dev", "pypa.io", "pypi.org", "pypi.python.org", "pythonhosted.org", "quay.io", "ruby-lang.org", "rubyforge.org", "rubygems.org", "rubyonrails.org", "rustup.rs", "rvm.io", "sourceforge.net", "spring.io", "swift.org", "ubuntu.com", "visualstudio.com", "yarnpkg.com"];
export const DEFAULT_HOSTS = [...COMMON_DEPENDENCIES, ...COMMON_DEPENDENCIES.map((d) => `*.${d}`)];
// Methods that only read. A large computer may read any public site, but sends data (POST, PUT, …) only to its
// allowed hosts: untrusted pages, company files and a way out never meet without a person (Meta's Rule of Two).
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export function egressRefusal(size: Tier, method: string, host: string, allowed: string[]): string | null {
  if (size !== "large" || READ_METHODS.has(method.toUpperCase())) return null;
  const h = host.toLowerCase().replace(/:\d+$/, "");
  const ok = allowed.some((p) => p === h || (p.startsWith("*.") && (h.endsWith(p.slice(1)) || h === p.slice(2))));
  return ok ? null : `peeblo: this computer may read any site but sends data (${method.toUpperCase()}) only to its allowed hosts; ${h} isn't one. The teammate's owner can add it.`;
}

export function workspaceOf(slug: string): string {
  return join(config.dataDir, "teammates", slug, "workspace");
}
// The teammate's working disk (L2) for one tier.
export function diskOf(slug: string, size: Tier): string {
  return join(config.dataDir, "teammates", slug, `disk-${size}.qcow2`);
}
// The image folder for a tier: a pinned build, else the current one.
export function imagePath(size: Tier = "small", buildId?: string | null): string {
  if (size === "small" && config.vmImage) return config.vmImage;
  const id = buildId ?? currentBuild(size);
  if (!id) throw new Error(`the ${size} computer image isn't built yet; run ./peeblo image ${size}`);
  return buildPath(size, id);
}

// Memory the host can give a new VM. macOS counts inactive and purgeable pages as used, so read vm_stat there.
export function availableMb(): number {
  if (platform() === "darwin") {
    try {
      const out = execFileSync("vm_stat", { encoding: "utf8" });
      const page = Number(/page size of (\d+)/.exec(out)?.[1] ?? 16384);
      const n = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
      return Math.round(((n("Pages free") + n("Pages inactive") + n("Pages speculative") + n("Pages purgeable")) * page) / 1e6);
    } catch { /* fall through */ }
  }
  try { return Math.round(Number(/MemAvailable:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf8"))?.[1]) / 1024); } catch { return Math.round(freemem() / 1e6); }
}

async function setState(teammateId: string, state: "asleep" | "booting" | "awake", vmId: string | null, workspace: string): Promise<void> {
  await pool.query(
    `INSERT INTO environments (teammate_id, state, vm_id, workspace) VALUES ($1, $2, $3, $4)
     ON CONFLICT (teammate_id) DO UPDATE SET state = EXCLUDED.state, vm_id = EXCLUDED.vm_id, updated_at = now()`,
    [teammateId, state, vmId, workspace],
  );
}

// Makes room before a wake: the tier's awake cap, then free host memory. Only idle computers are put to sleep.
async function makeRoom(size: Tier): Promise<void> {
  const idle = (pred: (l: Live) => boolean) => [...live.entries()].filter(([, l]) => l.inflight === 0 && !leased(l) && pred(l)).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  // Every computer of this size is busy: wait up to 3 minutes for one to go idle, then give up.
  const until = Date.now() + 180_000;
  while ([...live.values()].filter((l) => l.size === size).length >= awakeCap(size)) {
    const victim = idle((l) => l.size === size)[0];
    if (victim) { await sleep(victim[0], "evicted: awake cap"); continue; }
    if (Date.now() > until) throw new Error(`all ${awakeCap(size)} ${size} computers are still busy after 3 minutes; try again in a moment`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  const need = TIERS[size].footprintMb + RESERVE_MB;
  while (availableMb() < need) {
    const victim = idle(() => true)[0];
    if (!victim) { await appendEvent({ type: "env.memory_pressure", data: { size, available_mb: availableMb(), need_mb: need } }); break; }
    await sleep(victim[0], "evicted: host memory");
  }
}

// Which L0 build a boot uses: the pinned one while another session is live, else the current one.
async function pickL0(teammateId: string, size: Tier, pinned: string | null, sessionId: string | null): Promise<string> {
  const cur = currentBuild(size);
  if (!cur) throw new Error(`the ${size} computer image isn't built yet; run ./peeblo image ${size}`);
  if (!pinned || pinned === cur || !existsSync(buildPath(size, pinned))) return cur;
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM runs r JOIN sessions s ON s.id = r.session_id
      WHERE s.teammate_id = $1 AND r.status IN ('running', 'waiting') AND s.id <> coalesce($2, '')`, [teammateId, sessionId]);
  return rows[0].n > 0 ? pinned : cur;
}

async function boot(teammateId: string, sessionId: string | null): Promise<Live> {
  const tm = await getTeammate(teammateId);
  if (!tm) throw new Error(`no teammate ${teammateId}`);
  const size = (tm.config.computer?.size ?? "small") as Tier;
  const tier = TIERS[size];
  await makeRoom(size);
  const workspace = workspaceOf(tm.slug);
  await mkdir(workspace, { recursive: true });
  await setState(tm.id, "booting", null, workspace);
  const env0 = (await pool.query("SELECT pins, l2 FROM environments WHERE teammate_id = $1", [tm.id])).rows[0] ?? { pins: {}, l2: {} };
  const l0 = config.vmImage && size === "small" ? "custom" : await pickL0(tm.id, size, env0.pins?.[size] ?? null, sessionId);
  const { activeL1 } = await import("./recipes.ts");
  const l1 = await activeL1(tm.id, size, l0);
  // L2 is thrown away when it was made from another L0 or L1.
  const disk = diskOf(tm.slug, size);
  const made = env0.l2?.[size] ?? null;
  let l2ResetAt: string | null = null;
  if (existsSync(disk) && (!made || made.l0 !== l0 || (made.l1 ?? null) !== (l1?.id ?? null))) {
    rmSync(disk, { force: true });
    l2ResetAt = new Date().toISOString();
  }

  // Secrets: the VM sees placeholders; the real value goes out only on requests to the secret's hosts.
  const secrets = await secretsForVm(tm.id);
  const extra = ((tm.config as any).computer?.allowed_hosts as string[]) ?? [];
  const writable = [...new Set([...DEFAULT_HOSTS, ...extra, ...Object.values(secrets).flatMap((x) => x.hosts)])];
  const { httpHooks, env } = createHttpHooks({
    allowedHosts: size === "large" ? ["*"] : writable,
    secrets,
    onRequest: async (req) => {
      const u = new URL(req.url);
      const refused = egressRefusal(size, req.method, u.host, writable);
      if (refused) {
        await appendEvent({ type: "env.blocked", data: { teammate_id: tm.id, reason: "write to a host outside the allowlist", method: req.method, host: u.host } });
        return new Response(`${refused}\n`, { status: 403 });
      }
      if (u.pathname.endsWith("/git-receive-pack") || u.searchParams.get("service") === "git-receive-pack") {
        await appendEvent({ type: "env.blocked", data: { teammate_id: tm.id, reason: "git push needs approval", host: u.host, path: u.pathname } });
        return new Response("peeblo: git push needs a person's approval\n", { status: 403 });
      }
      return undefined;
    },
  });
  const t0 = Date.now();
  const crossArch = config.vmArch === "x86_64" && process.arch === "arm64";
  const options = {
    sessionLabel: `peeblo ${tm.slug}`,
    sandbox: { imagePath: l0 === "custom" ? config.vmImage : imagePath(size, l0), ...(crossArch ? { append: "console=ttyS0 initramfs_async=1" } : {}) },
    memory: tier.memory, cpus: tier.cpus, rootfs: { mode: "cow" as const, size: tier.disk },
    httpHooks,
    env: { ...env, ...BARE_ENV },
    vfs: { mounts: { "/workspace": new RealFSProvider(workspace) } },
  };
  // Wake on L2; else start from L1; else from the image. A disk that can't be used is replaced by a fresh one.
  let vm: VM;
  let from: "l2" | "l1" | "l0" = "l0";
  const start = async (path: string | null) => (path ? VmCheckpoint.load(path).resume<VM>(options) : VM.create(options));
  try {
    if (existsSync(disk)) { vm = await start(disk); from = "l2"; }
    else if (l1?.disk && existsSync(l1.disk)) { vm = await start(l1.disk); from = "l1"; }
    else vm = await start(null);
  } catch (e) {
    await appendEvent({ type: "env.disk_reset", data: { teammate_id: tm.id, from, error: (e as Error).message.slice(0, 300) } });
    rmSync(disk, { force: true });
    l2ResetAt = new Date().toISOString();
    vm = await (l1?.disk && from !== "l1" && existsSync(l1.disk) ? start(l1.disk) : start(null));
  }
  await vm.exec(["/bin/sh", "-c", `${PERSIST_HOME} git config --global --add safe.directory '*' 2>/dev/null; git config --global gc.auto 0; true`]);
  // Chromium trusts only its NSS store, so the large tier adds Gondolin's egress CA there (TLS stays checked).
  if (size === "large") await vm.exec(["/bin/sh", "-c", "d=sql:/root/.pki/nssdb; mkdir -p /root/.pki/nssdb; [ -f /root/.pki/nssdb/cert9.db ] || certutil -d $d -N --empty-password; certutil -d $d -A -t C,, -n gondolin-egress -i /etc/gondolin/mitm/ca.crt"]);
  const l: Live = { vm, booted: Date.now(), lastUsed: Date.now(), inflight: 0, disk, size, leases: new Map() };
  live.set(tm.id, l);
  await setState(tm.id, "awake", vm.id, workspace);
  await pool.query(
    `UPDATE environments SET size = $2, pins = pins || jsonb_build_object($2::text, $3::text), l2 = l2 || jsonb_build_object($2::text, jsonb_build_object('l0', $3::text, 'l1', $4::text)),
       l2_reset_at = coalesce($5::timestamptz, l2_reset_at) WHERE teammate_id = $1`, [tm.id, size, l0, l1?.id ?? null, l2ResetAt]);
  const prov = (await pool.query("SELECT l2_reset_at FROM environments WHERE teammate_id = $1", [tm.id])).rows[0];
  await appendEvent({ type: "env.booted", data: {
    teammate_id: tm.id, vm_id: vm.id, ms: Date.now() - t0, size, memory: tier.memory, cpus: tier.cpus, from,
    l0_build_id: l0, l1_build_id: l1?.id ?? null, l2_reset_at: prov?.l2_reset_at ?? null,
  } });
  const { startServices } = await import("./recipes.ts");
  await startServices(tm.id, vm, l1?.recipe ?? null).catch(() => {});
  return l;
}

async function ensure(teammateId: string, sessionId: string | null): Promise<Live> {
  const l = live.get(teammateId);
  if (l) return l;
  let p = booting.get(teammateId);
  if (!p) {
    p = boot(teammateId, sessionId).finally(() => booting.delete(teammateId));
    booting.set(teammateId, p);
  }
  return p;
}

// A background job keeps its computer awake (no idle sleep, no eviction) until it ends or its lease runs out.
function leased(l: Live): boolean {
  const now = Date.now();
  for (const [id, until] of l.leases) if (until <= now) l.leases.delete(id);
  return l.leases.size > 0;
}
export function holdAwake(teammateId: string, jobId: string, ms: number): void {
  const l = live.get(teammateId);
  if (l) l.leases.set(jobId, Date.now() + ms);
}
export function releaseAwake(teammateId: string, jobId: string): void {
  live.get(teammateId)?.leases.delete(jobId);
}

// The idle timer restarts after every command and never sleeps a computer with a command running, a background
// job, or one that was replaced (a reboot after a crash makes a new Live).
function touch(teammateId: string, l: Live): void {
  l.lastUsed = Date.now();
  if (l.idle) clearTimeout(l.idle);
  l.idle = setTimeout(() => {
    if (live.get(teammateId) !== l) return;
    if (l.inflight > 0 || leased(l)) return touch(teammateId, l);
    sleep(teammateId, "idle").catch((e) => console.error(`peeblo: idle sleep failed for ${teammateId}: ${(e as Error).message}`));
  }, config.vmIdleMs);
}

export async function sleep(teammateId: string, reason: string): Promise<void> {
  const l = live.get(teammateId);
  if (!l) return;
  live.delete(teammateId);
  if (l.idle) clearTimeout(l.idle);
  // Hooks that must run before the disk is saved (e.g. the browser's cookies go back to core).
  for (const h of beforeSleep) await h(teammateId, l.vm).catch(() => {});
  // Saving the working disk also stops the VM; if that fails, close it (the last saved disk stays).
  await mkdir(dirname(l.disk), { recursive: true });
  await l.vm.checkpoint(l.disk).catch(async (e) => {
    await appendEvent({ type: "env.disk_save_failed", data: { teammate_id: teammateId, error: (e as Error).message.slice(0, 300) } });
    await l.vm.close().catch(() => {});
  });
  const { rows } = await pool.query<{ workspace: string }>("SELECT workspace FROM environments WHERE teammate_id = $1", [teammateId]);
  await setState(teammateId, "asleep", null, rows[0]?.workspace ?? "");
  await appendEvent({ type: "env.slept", data: { teammate_id: teammateId, reason, awake_ms: Date.now() - l.booted } });
}
const beforeSleep: ((teammateId: string, vm: VM) => Promise<void>)[] = [];
export const onBeforeSleep = (h: (teammateId: string, vm: VM) => Promise<void>) => void beforeSleep.push(h);

export type ExecResult = { exitCode: number; stdout: string; stderr: string; ms: number; timedOut?: boolean };

// Runs one command in the teammate's VM. A dead VM is reported as an error and forgotten, so the
// caller sees a failed command (not a hung one) and the next command boots a fresh VM.
export async function exec(teammateId: string, argv: string[], opts: { cwd?: string; timeoutMs?: number; signal?: AbortSignal; sessionId?: string; env?: Record<string, string> } = {}): Promise<ExecResult> {
  const l = await ensure(teammateId, opts.sessionId ?? null);
  touch(teammateId, l);
  l.inflight++;
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 120_000);
  opts.signal?.addEventListener("abort", () => ctl.abort(), { once: true });
  try {
    const r = await l.vm.exec(argv, { cwd: opts.cwd ?? "/workspace", env: { ...BARE_ENV, ...(opts.env ?? {}) }, signal: ctl.signal });
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, ms: Date.now() - t0 };
  } catch (error) {
    // Aborting only stops the wait here: the command goes on running inside the VM.
    if (ctl.signal.aborted) return { exitCode: 124, stdout: "", stderr: "timed out", ms: Date.now() - t0, timedOut: true };
    live.delete(teammateId);
    await setState(teammateId, "asleep", null, workspaceOf((await getTeammate(teammateId))?.slug ?? teammateId)).catch(() => {});
    await appendEvent({ type: "env.crashed", data: { teammate_id: teammateId, error: (error as Error).message } });
    throw new Error(`the teammate's computer stopped unexpectedly (${(error as Error).message}); it restarts on the next command`);
  } finally {
    clearTimeout(timer);
    l.inflight--;
    if (live.get(teammateId) === l) touch(teammateId, l);
  }
}

export const isAwake = (teammateId: string) => live.has(teammateId);
export const awake = () => [...live.entries()].map(([id, l]) => ({ teammateId: id, size: l.size, lastUsed: l.lastUsed, inflight: l.inflight }));

export async function sleepAll(): Promise<void> {
  await Promise.all([...live.keys()].map((id) => sleep(id, "shutdown")));
}
