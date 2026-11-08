// `peeblo image [small|large]`: builds the teammate VM images for this host's architecture (or PEEBLO_VM_ARCH).
// Each build lands in its own folder named by Gondolin's manifest buildId and is never overwritten; `current`
// names the newest. Teammates stay pinned to the build their disk was made on (controller.ts), and old folders
// are removed once nothing is pinned to them. Files Alpine doesn't package (images/vendor.json) are fetched,
// checked by sha256 and copied in.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.ts";
import { pool } from "../db.ts";

export type Tier = "small" | "large";
const REPO = join(import.meta.dirname, "..", "..");
export const tierDir = (size: Tier) => join(config.dataDir, "images", `${size}-${config.vmArch}`);

// The build a tier uses now: `current`, or a build folder from before images were versioned.
export function currentBuild(size: Tier): string | null {
  const f = join(tierDir(size), "current");
  if (existsSync(f)) return readFileSync(f, "utf8").trim();
  return null;
}
export const buildPath = (size: Tier, buildId: string) => join(tierDir(size), buildId);
// Which distro a build is (builds from before this field are Alpine).
export function distroOf(size: Tier, buildId = currentBuild(size)): "debian" | "alpine" | null {
  if (!buildId) return null;
  try { return JSON.parse(readFileSync(join(buildPath(size, buildId), "peeblo-build.json"), "utf8")).distro ?? "alpine"; } catch { return "alpine"; }
}
export function buildIdOf(dir: string): string | null {
  try { return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).buildId ?? null; } catch { return null; }
}

const run = (bin: string, args: string[], cwd?: string) => new Promise<void>((resolve, reject) => {
  const p = spawn(bin, args, { stdio: "inherit", cwd });
  p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${bin} ${args[0]} exited ${code}`))));
});

// Fetches and unpacks the vendored files for a tier; returns Gondolin postBuild.copy entries.
async function vendor(size: Tier): Promise<{ src: string; dest: string }[]> {
  const list = JSON.parse(await readFile(join(REPO, "images", "vendor.json"), "utf8")) as Record<string, any>;
  const dir = join(config.dataDir, "images", "vendor", config.vmArch);
  await mkdir(dir, { recursive: true });
  const out: { src: string; dest: string }[] = [];
  for (const [name, v] of Object.entries(list)) {
    if (name === "_" || !v.tiers.includes(size)) continue;
    const key = v.url[config.vmArch] ? config.vmArch : "any";
    const file = join(dir, `${name}-${v.version}.${v.kind === "wheel" ? "whl" : v.kind === "tgz-binary" ? "tgz" : "bin"}`);
    if (!existsSync(file)) {
      const r = await fetch(v.url[key]);
      if (!r.ok) throw new Error(`${name}: download failed (${r.status})`);
      await writeFile(file, Buffer.from(await r.arrayBuffer()));
    }
    const sum = createHash("sha256").update(await readFile(file)).digest("hex");
    if (sum !== v.sha256[key]) { await rm(file, { force: true }); throw new Error(`${name}: sha256 mismatch (${sum})`); }
    const unpacked = join(dir, `${name}-${v.version}`);
    if (!existsSync(unpacked)) {
      await mkdir(unpacked, { recursive: true });
      if (v.kind === "wheel") await run("unzip", ["-q", file, "-d", unpacked]);
      else if (v.kind === "tgz-binary") await run("tar", ["-xzf", file, "-C", unpacked]);
      else { await writeFile(join(unpacked, name), await readFile(file)); await chmod(join(unpacked, name), 0o755); }
    }
    if (v.kind === "wheel") for (const e of readdirSync(unpacked)) out.push({ src: join(unpacked, e), dest: join(v.dest, e) });
    else { const bin = readdirSync(unpacked)[0]; await chmod(join(unpacked, bin), 0o755); out.push({ src: join(unpacked, bin), dest: v.dest }); }
  }
  return out;
}

// The large computer runs Debian when Docker or Podman is here (Gondolin's OCI path), and Alpine otherwise.
// PEEBLO_LARGE_DISTRO=alpine keeps Alpine even with a container runtime.
export function containerRuntime(): "docker" | "podman" | null {
  for (const rt of ["docker", "podman"] as const) if (spawnSync(rt, ["info", "--format", "{{.ServerVersion}}"], { stdio: "ignore", timeout: 15_000 }).status === 0) return rt;
  return null;
}
export const distroFor = (size: Tier): "debian" | "alpine" => (size === "large" && process.env.PEEBLO_LARGE_DISTRO !== "alpine" && containerRuntime() ? "debian" : "alpine");
const DEBIAN = join(REPO, "images", "large-debian");
const DEBIAN_REPO = "peeblo-large-debian";

// Builds the Debian large image with the container runtime, tagged by the hash of its recipe, and drops older tags.
async function buildDebianOci(rt: "docker" | "podman"): Promise<string> {
  const h = createHash("sha256");
  for (const f of readdirSync(DEBIAN).sort()) h.update(f).update(await readFile(join(DEBIAN, f)));
  const tag = `${DEBIAN_REPO}:${h.digest("hex").slice(0, 16)}`;
  const platform = `linux/${config.vmArch === "aarch64" ? "arm64" : "amd64"}`;
  if (spawnSync(rt, ["image", "inspect", tag], { stdio: "ignore" }).status !== 0) await run(rt, ["build", "--platform", platform, "-t", tag, DEBIAN]);
  const old = spawnSync(rt, ["images", DEBIAN_REPO, "--format", "{{.Repository}}:{{.Tag}}"], { encoding: "utf8" }).stdout.split("\n").filter((t) => t && t !== tag);
  if (old.length) spawnSync(rt, ["rmi", ...old], { stdio: "ignore" });
  return tag;
}

export async function buildImage(only?: string, opts: { extraPackages?: string[] } = {}): Promise<string[]> {
  const ids: string[] = [];
  for (const size of (only ? [only] : ["small", "large"]) as Tier[]) {
    const tmp = join(tierDir(size), `.building-${Date.now()}`);
    await mkdir(tmp, { recursive: true });
    const cfg = JSON.parse(await readFile(join(REPO, "images", `${size}-${config.vmArch}.json`), "utf8"));
    const distro = distroFor(size);
    if (distro === "debian") {
      // Gondolin keeps its Alpine kernel and init; the Debian image is the root filesystem.
      const rt = containerRuntime()!;
      cfg.oci = { image: await buildDebianOci(rt), runtime: rt, pullPolicy: "never" };
      cfg.postBuild = { copy: [] };
    } else cfg.postBuild = { copy: await vendor(size) };
    if (opts.extraPackages?.length) cfg.alpine.rootfsPackages.push(...opts.extraPackages);
    const cfgFile = join(tmp, "..", `.config-${size}.json`);
    await writeFile(cfgFile, JSON.stringify(cfg, null, 2));
    const t0 = Date.now();
    console.log(`building the ${size} ${config.vmArch} image`);
    await run(join(REPO, "node_modules", ".bin", "gondolin"), ["build", "--config", cfgFile, "--output", tmp]);
    const id = buildIdOf(tmp);
    if (!id) throw new Error("the build has no manifest buildId");
    const dest = buildPath(size, id);
    if (existsSync(dest)) await rm(tmp, { recursive: true, force: true }); // same inputs, same build: keep the old one
    else await rename(tmp, dest);
    await writeFile(join(tierDir(size), "current"), id);
    const bytes = readdirSync(dest).reduce((a, f) => a + statSync(join(dest, f)).size, 0);
    await writeFile(join(dest, "peeblo-build.json"), JSON.stringify({ size, distro, oci_image: cfg.oci?.image ?? null, buildId: id, built_at: new Date().toISOString(), build_ms: Date.now() - t0, bytes, packages: distro === "debian" ? "images/large-debian/Dockerfile" : cfg.alpine.rootfsPackages, vendored: cfg.postBuild.copy.map((c: { dest: string }) => c.dest) }, null, 2));
    console.log(`${size} (${distro}): build ${id} (${Math.round(bytes / 1e6)} MB, ${Math.round((Date.now() - t0) / 1000)} s)`);
    await pruneImages(size).catch(() => {});
    ids.push(id);
  }
  return ids;
}

// Removes build folders no teammate is pinned to (never `current`).
export async function pruneImages(size: Tier): Promise<string[]> {
  const cur = currentBuild(size);
  const { rows } = await pool.query("SELECT DISTINCT pins->>$1 AS id FROM environments WHERE pins ? $1", [size]).catch(() => ({ rows: [] as { id: string }[] }));
  const keep = new Set([cur, ...rows.map((r) => r.id)]);
  const removed: string[] = [];
  for (const d of readdirSync(tierDir(size))) {
    if (d.startsWith(".") || d === "current" || keep.has(d) || !buildIdOf(join(tierDir(size), d))) continue;
    await rm(join(tierDir(size), d), { recursive: true, force: true });
    removed.push(d);
  }
  return removed;
}
