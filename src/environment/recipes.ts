// Build recipes: a teammate's setup (packages, steps, config files) built once into an immutable L1 disk.
// - Built in a separate, short-lived build VM from the L0 image, with build egress (package registries plus the
//   recipe's own hosts) and secret placeholders, never real values. Each step goes through the rule engine.
// - verify must pass; then the disk is saved as recipe-<hash>.qcow2 (atomic rename). A failed build never replaces
//   the active one.
// - The build hash covers the build fields, the L0 buildId and the runner version, so the same recipe on the same
//   base is never built twice.
// - A teammate moves to a new L1 only at a boundary: when no other session of it is live.
// - One build at a time per host; a newer trigger for the same teammate cancels a queued one.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, statSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHttpHooks, VM } from "@earendil-works/gondolin";
import { config } from "../config.ts";
import { pool } from "../db.ts";
import { newId } from "../ids.ts";
import { checkAction, ruleMessage } from "../otari/rules.ts";
import { appendEvent } from "../store/events.ts";
import { placeholderOf, secretsForVm } from "../store/secrets.ts";
import { getTeammate } from "../store/teammates.ts";
import { BARE_ENV, imagePath, PERSIST_HOME, TIERS } from "./controller.ts";
import { currentBuild, distroOf, type Tier } from "./image.ts";
import { sh } from "./shell.ts";

export const RUNNER_VERSION = "2"; // 2: /root and /var/cache on the disk
const STEP_MS = 10 * 60_000;
const BUILD_MS = 30 * 60_000;

import { EMPTY, normalizeRecipe, type Recipe } from "./recipe-schema.ts";
export { normalizeRecipe, type Recipe };

const BUILD_FIELDS = (r: Recipe) => ({ packages: r.packages, run: r.run, files: r.files, env: r.env, secrets: r.secrets, network: r.network, verify: r.verify });
const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));
export const buildHash = (r: Recipe, l0: string) => createHash("sha256").update(canonical({ build: BUILD_FIELDS(r), l0, runner: RUNNER_VERSION })).digest("hex");
export const isEmpty = (r: Recipe) => canonical(BUILD_FIELDS(r)) === canonical(BUILD_FIELDS(EMPTY));
const recipeOf = (tmConfig: any): Recipe => normalizeRecipe(tmConfig?.computer?.recipe).recipe;

const teammateDir = (slug: string) => join(config.dataDir, "teammates", slug);
const l1Path = (slug: string, size: Tier, hash: string) => join(teammateDir(slug), `recipe-${size}-${hash.slice(0, 24)}.qcow2`);

async function otherLiveSessions(teammateId: string, sessionId: string | null): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM runs r JOIN sessions s ON s.id = r.session_id WHERE s.teammate_id = $1 AND r.status IN ('running', 'waiting') AND s.id <> coalesce($2, '')`, [teammateId, sessionId]);
  return rows[0].n;
}

// The L1 a boot on this L0 should use. A built recipe matching the config is adopted here, at a boundary only;
// a missing build is queued and the old disk is used meanwhile.
export async function activeL1(teammateId: string, size: Tier, l0: string, sessionId: string | null = null): Promise<{ id: string; disk: string; recipe: Recipe } | null> {
  const tm = await getTeammate(teammateId);
  if (!tm) return null;
  const want = recipeOf(tm.config);
  const { rows } = await pool.query("SELECT * FROM recipe_builds WHERE teammate_id = $1 AND size = $2 AND l0_build_id = $3 AND status IN ('built', 'active') ORDER BY created_at DESC", [teammateId, size, l0]);
  const active = rows.find((b) => b.status === "active") ?? null;
  const asL1 = (b: any) => (b ? { id: b.id, disk: b.disk, recipe: normalizeRecipe(b.recipe).recipe } : null);
  const atBoundary = (await otherLiveSessions(teammateId, sessionId)) === 0;
  if (isEmpty(want)) {
    if (active && atBoundary) await pool.query("UPDATE recipe_builds SET status = 'superseded' WHERE id = $1", [active.id]);
    return active && !atBoundary ? asL1(active) : null;
  }
  const hash = buildHash(want, l0);
  const desired = rows.find((b) => b.hash === hash && b.disk && existsSync(b.disk));
  if (desired?.status === "active") return asL1(desired);
  if (desired && atBoundary) {
    await pool.query("UPDATE recipe_builds SET status = 'superseded' WHERE teammate_id = $1 AND size = $2 AND status = 'active'", [teammateId, size]);
    await pool.query("UPDATE recipe_builds SET status = 'active', purpose = 'config' WHERE id = $1", [desired.id]);
    await appendEvent({ type: "env.recipe.adopted", data: { teammate_id: teammateId, build_id: desired.id, hash } });
    return asL1({ ...desired, status: "active" });
  }
  if (!desired) void queueBuild(teammateId, size, "config").catch(() => {});
  return asL1(active);
}

// --- the build queue: one build at a time per host ---
let chain: Promise<unknown> = Promise.resolve();
const queued = new Map<string, string>(); // teammate:size → queued build id (a newer trigger replaces it)

export async function queueBuild(teammateId: string, size: Tier, purpose: "config" | "trial", recipeOverride?: Recipe): Promise<{ id: string; status: string; hash: string }> {
  const tm = await getTeammate(teammateId);
  if (!tm) throw new Error("no such teammate");
  const l0 = currentBuild(size);
  if (!l0) throw new Error(`the ${size} computer image isn't built yet; run ./peeblo image ${size}`);
  const recipe = recipeOverride ?? recipeOf(tm.config);
  const hash = buildHash(recipe, l0);
  // Same hash, same base: nothing to build.
  const same = (await pool.query("SELECT id, status FROM recipe_builds WHERE teammate_id = $1 AND size = $2 AND hash = $3 AND status IN ('queued', 'building', 'built', 'active') ORDER BY created_at DESC LIMIT 1", [teammateId, size, hash])).rows[0];
  if (same) return { id: same.id, status: same.status, hash };
  const key = `${teammateId}:${size}:${purpose}`;
  const prev = queued.get(key);
  if (prev) { await pool.query("UPDATE recipe_builds SET status = 'cancelled', finished_at = now() WHERE id = $1 AND status = 'queued'", [prev]); }
  const id = newId("rb");
  await pool.query("INSERT INTO recipe_builds (id, teammate_id, size, hash, l0_build_id, recipe, status, purpose) VALUES ($1, $2, $3, $4, $5, $6, 'queued', $7)", [id, teammateId, size, hash, l0, recipe, purpose]);
  queued.set(key, id);
  const job = chain.then(async () => {
    if (queued.get(key) === id) queued.delete(key);
    const st = (await pool.query("SELECT status FROM recipe_builds WHERE id = $1", [id])).rows[0]?.status;
    if (st !== "queued") return;
    await runBuild(id).catch(() => {});
  });
  chain = job.catch(() => {});
  return { id, status: "queued", hash };
}

export async function waitForBuild(id: string, timeoutMs = BUILD_MS + 60_000): Promise<any> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const b = (await pool.query("SELECT * FROM recipe_builds WHERE id = $1", [id])).rows[0];
    if (!b || !["queued", "building"].includes(b.status) || Date.now() > until) return b;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const REGISTRY_HOSTS = { apk: ["dl-cdn.alpinelinux.org"], apt: ["deb.debian.org"], npm: ["registry.npmjs.org"], pip: ["pypi.org", "files.pythonhosted.org"] };

async function runBuild(id: string): Promise<void> {
  const b = (await pool.query("SELECT * FROM recipe_builds WHERE id = $1", [id])).rows[0];
  const tm = (await getTeammate(b.teammate_id))!;
  const recipe = normalizeRecipe(b.recipe).recipe;
  const size = b.size as Tier;
  const dir = join(teammateDir(tm.slug), "builds");
  await mkdir(dir, { recursive: true });
  const logFile = join(dir, `${id}.log`);
  const log = (s: string) => appendFileSync(logFile, s.endsWith("\n") ? s : `${s}\n`);
  await pool.query("UPDATE recipe_builds SET status = 'building' WHERE id = $1", [id]);
  const t0 = Date.now();
  const fail = async (error: string, step?: string) => {
    await pool.query("UPDATE recipe_builds SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [id, error.slice(0, 2000)]);
    await appendEvent({ type: "env.build.failed", data: { teammate_id: tm.id, build_id: id, purpose: b.purpose, step: step ?? null, error: error.slice(0, 500) } });
    if (b.purpose === "config") await appendEvent({ type: "notify.owner", data: { teammate_id: tm.id, kind: "build_failed", text: `${tm.config.name}'s computer setup failed at "${step ?? "start"}": ${error.slice(0, 300)}. The current setup is unchanged.` } });
    log(`FAILED: ${error}`);
  };
  // Build egress: the registries the recipe uses, its own build hosts and its secrets' hosts. Secrets are
  // placeholders; the real value goes out only to the secret's hosts.
  const secrets = await secretsForVm(tm.id, recipe.secrets);
  const hosts = new Set<string>(recipe.network.hosts);
  for (const k of ["apk", "apt", "npm", "pip"] as const) if (recipe.packages[k].length) for (const h of REGISTRY_HOSTS[k]) hosts.add(h);
  if (recipe.run.length) for (const h of [...REGISTRY_HOSTS.apk, ...REGISTRY_HOSTS.apt, ...REGISTRY_HOSTS.npm, ...REGISTRY_HOSTS.pip, "github.com", "objects.githubusercontent.com", "codeload.github.com"]) hosts.add(h);
  for (const s of Object.values(secrets)) for (const h of s.hosts) hosts.add(h);
  const { httpHooks, env } = createHttpHooks({ allowedHosts: [...hosts], secrets });
  let vm: VM | null = null;
  const deadline = setTimeout(() => void vm?.close().catch(() => {}), BUILD_MS);
  try {
    vm = await VM.create({ sessionLabel: `peeblo build ${tm.slug}`, sandbox: { imagePath: imagePath(size, b.l0_build_id) }, memory: TIERS[size].memory, cpus: TIERS[size].cpus, rootfs: { mode: "cow", size: TIERS[size].disk }, httpHooks, env: { ...env, ...BARE_ENV } });
    await vm.exec(["/bin/sh", "-c", PERSIST_HOME]);
    const steps: { name: string; run: string; timeout_s?: number }[] = [];
    // System packages for the computer's distro: apk on Alpine, apt on Debian (the large computer with Docker).
    const distro = distroOf(size, b.l0_build_id) ?? "alpine";
    const wrong = distro === "debian" ? recipe.packages.apk : recipe.packages.apt;
    const right = distro === "debian" ? recipe.packages.apt : recipe.packages.apk;
    if (wrong.length && !right.length) { await fail(`this computer runs ${distro === "debian" ? "Debian: list system packages under packages.apt" : "Alpine: list system packages under packages.apk"}`, "system packages"); return; }
    if (right.length) steps.push(distro === "debian"
      ? { name: "apt packages", run: `apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${right.map(sh).join(" ")}` }
      : { name: "apk packages", run: `apk add --no-cache ${right.map(sh).join(" ")}` });
    if (recipe.packages.npm.length) steps.push({ name: "npm packages", run: `npm install -g --no-audit --no-fund ${recipe.packages.npm.map(sh).join(" ")}` });
    if (recipe.packages.pip.length) steps.push({ name: "pip packages", run: `uv pip install --system --break-system-packages ${recipe.packages.pip.map(sh).join(" ")}` });
    const files = recipe.files.map((f) => ({ ...f, content: f.content.replace(/\$\{secret:([A-Z][A-Z0-9_]*)\}/g, (_m, n) => placeholderOf(tm.id, n)) }));
    for (const f of files) steps.push({ name: `file ${f.path}`, run: `mkdir -p "$(dirname ${sh(f.path)})" && printf %s ${sh(f.content)} > ${sh(f.path)}${f.mode ? ` && chmod ${sh(f.mode)} ${sh(f.path)}` : ""}` });
    if (Object.keys(recipe.env).length) steps.push({ name: "environment", run: `mkdir -p /etc/profile.d && printf %s ${sh(Object.entries(recipe.env).map(([k, v]) => `export ${k}=${sh(v)}`).join("\n") + "\n")} > /etc/profile.d/peeblo-recipe.sh` });
    steps.push(...recipe.run);
    for (const v of recipe.verify) steps.push({ name: `verify: ${v.slice(0, 60)}`, run: v });
    const verify: { command: string; output: string }[] = [];
    for (const s of steps) {
      if (!s.name.startsWith("file ") && s.name !== "environment") {
        const d = await checkAction({ commands: [s.run] });
        if (d.decision !== "allow") { await fail(`refused by the computer's rules: ${ruleMessage(d)}`, s.name); return; }
      }
      const s0 = Date.now();
      const r = await vm.exec(["/bin/sh", "-c", `[ -f /etc/profile.d/peeblo-recipe.sh ] && . /etc/profile.d/peeblo-recipe.sh; ${s.run}`], { cwd: "/root", env: { ...BARE_ENV, ...Object.fromEntries(Object.entries(secrets).map(([n, x]) => [n, x.placeholder])) }, signal: AbortSignal.timeout(Math.min(STEP_MS, (s.timeout_s ?? 600) * 1000)) })
        .catch((e) => ({ exitCode: -1, stdout: "", stderr: String(e) }));
      const out = `${r.stdout}${r.stderr}`;
      log(`$ ${s.name}\n${out}\n[exit ${r.exitCode}, ${Date.now() - s0} ms]`);
      await appendEvent({ type: "env.build.step", data: { teammate_id: tm.id, build_id: id, name: s.name, exit_code: r.exitCode, ms: Date.now() - s0, tail: out.slice(-4096) } });
      if (s.name.startsWith("verify")) verify.push({ command: s.run, output: out.trim().slice(-500) });
      if (r.exitCode !== 0) { await fail(`exit ${r.exitCode}: ${out.trim().slice(-400)}`, s.name); return; }
    }
    await vm.exec(["/bin/sh", "-c", "rm -rf /var/cache/apk/* /var/lib/apt/lists/* /var/cache/apt/archives/*.deb /root/.npm/_cacache /root/.cache/uv /var/cache/peeblo/* 2>/dev/null; sync"]);
    // Save the build as an immutable L1 disk (this stops the build VM), then promote it with a rename.
    const final = l1Path(tm.slug, size, b.hash);
    const tmp = `${final}.tmp`;
    await vm.checkpoint(tmp);
    vm = null;
    await rename(tmp, final);
    const bytes = statSync(final).size;
    await pool.query("UPDATE recipe_builds SET status = 'built', disk = $2, bytes = $3, verify = $4, finished_at = now() WHERE id = $1", [id, final, bytes, JSON.stringify(verify)]);
    await appendEvent({ type: "env.build.built", data: { teammate_id: tm.id, build_id: id, purpose: b.purpose, ms: Date.now() - t0, bytes } });
    log(`BUILT in ${Date.now() - t0} ms, ${bytes} bytes`);
  } catch (e) {
    await fail((e as Error).message);
  } finally {
    clearTimeout(deadline);
    await vm?.close().catch(() => {});
    await rm(`${l1Path(tm.slug, size, b.hash)}.tmp`, { force: true }).catch(() => {});
  }
}

// Long-running services from the recipe, started on every boot (there are no RAM snapshots). Output goes to a
// log file, so a background process never holds the exec channel open.
export async function startServices(teammateId: string, vm: VM, recipe: Recipe | null): Promise<void> {
  for (const s of recipe?.start ?? []) {
    const name = s.name.replace(/[^a-z0-9_-]/gi, "-");
    await vm.exec(["/bin/sh", "-c", `[ -f /etc/profile.d/peeblo-recipe.sh ] && . /etc/profile.d/peeblo-recipe.sh; nohup sh -c ${sh(s.run)} > /var/log/peeblo-${name}.log 2>&1 < /dev/null &`]);
    let ready = !s.ready;
    for (let i = 0; i < 30 && !ready; i++) {
      ready = (await vm.exec(["/bin/sh", "-c", s.ready!])).exitCode === 0;
      if (!ready) await new Promise((r) => setTimeout(r, 1000));
    }
    await appendEvent({ type: "env.service", data: { teammate_id: teammateId, name: s.name, ready } });
  }
}

// What the agent and the console see about a teammate's builds.
export async function buildStatus(teammateId: string): Promise<{ active: any; latest: any[] }> {
  const { rows } = await pool.query("SELECT id, size, status, purpose, hash, l0_build_id, bytes, error, verify, created_at, finished_at FROM recipe_builds WHERE teammate_id = $1 ORDER BY created_at DESC LIMIT 5", [teammateId]);
  return { active: rows.find((r) => r.status === "active") ?? null, latest: rows };
}

// Config triggers: a recipe change (or a base image newer than the active build) queues a build. Same hash, no build.
export async function queueIfNeeded(teammateId: string): Promise<void> {
  const tm = await getTeammate(teammateId);
  if (!tm) return;
  const size = (tm.config.computer?.size ?? "small") as Tier;
  const want = normalizeRecipe(tm.config.computer?.recipe).recipe;
  if (isEmpty(want) || !currentBuild(size)) return;
  await queueBuild(tm.id, size, "config");
}
export async function queueMissingBuilds(): Promise<void> {
  // At start nothing is building: a build left queued or building was cut by the restart, and would block a new
  // build of the same setup. It ends as failed, and the setup is queued again below.
  await pool.query("UPDATE recipe_builds SET status = 'failed', finished_at = now(), error = 'interrupted by a restart' WHERE status IN ('queued', 'building')");
  const { rows } = await pool.query("SELECT id FROM teammates WHERE archived_at IS NULL");
  for (const r of rows) await queueIfNeeded(r.id).catch(() => {});
}
