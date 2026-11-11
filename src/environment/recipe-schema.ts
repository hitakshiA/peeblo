// The build recipe's schema (no imports, so the teammate store can validate recipes).
export type Recipe = {
  packages: { apk: string[]; apt: string[]; npm: string[]; pip: string[] };
  run: { name: string; run: string; timeout_s?: number }[];
  files: { path: string; content: string; mode?: string }[];
  env: Record<string, string>;
  secrets: string[];
  network: { hosts: string[] };
  verify: string[];
  start: { name: string; run: string; ready?: string }[];
};
export const EMPTY: Recipe = { packages: { apk: [], apt: [], npm: [], pip: [] }, run: [], files: [], env: {}, secrets: [], network: { hosts: [] }, verify: [], start: [] };

// A host name, or a wildcard over a domain's subdomains (*.example.com).
export const HOST = /^(\*\.)?([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;
const PKG = /^[A-Za-z0-9@._/=<>~^+-]{1,200}$/;
// Validates a recipe; a v1 recipe (a list of commands) becomes run steps. Returns the recipe or the problems.
export function normalizeRecipe(raw: unknown): { recipe: Recipe; problems: string[] } {
  const problems: string[] = [];
  if (raw == null) return { recipe: structuredClone(EMPTY), problems };
  const r: any = Array.isArray(raw) ? { run: raw.map((c, i) => ({ name: `step ${i + 1}`, run: c })) } : raw;
  if (typeof r !== "object") return { recipe: structuredClone(EMPTY), problems: ["recipe must be an object"] };
  const list = (v: unknown, what: string, test: (x: string) => boolean): string[] => {
    if (v == null) return [];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && test(x))) { problems.push(`${what} must be a list of valid entries`); return []; }
    return v as string[];
  };
  const recipe: Recipe = {
    packages: { apk: list(r.packages?.apk, "packages.apk", (x) => PKG.test(x)), apt: list(r.packages?.apt, "packages.apt", (x) => PKG.test(x)), npm: list(r.packages?.npm, "packages.npm", (x) => PKG.test(x)), pip: list(r.packages?.pip, "packages.pip", (x) => PKG.test(x)) },
    run: (Array.isArray(r.run) ? r.run : []).map((s: any, i: number) => ({ name: String(s?.name ?? `step ${i + 1}`).slice(0, 80), run: String(s?.run ?? ""), ...(s?.timeout_s ? { timeout_s: Math.min(600, Number(s.timeout_s)) } : {}) })),
    files: (Array.isArray(r.files) ? r.files : []).map((f: any) => ({ path: String(f?.path ?? ""), content: String(f?.content ?? ""), ...(f?.mode ? { mode: String(f.mode) } : {}) })),
    env: r.env && typeof r.env === "object" ? Object.fromEntries(Object.entries(r.env).map(([k, v]) => [k, String(v)])) : {},
    secrets: list(r.secrets, "secrets", (x) => /^[A-Z][A-Z0-9_]{1,63}$/.test(x)),
    network: { hosts: list(r.network?.hosts, "network.hosts", (x) => HOST.test(x)) },
    verify: list(r.verify, "verify", (x) => x.length > 0 && x.length < 2000),
    start: (Array.isArray(r.start) ? r.start : []).map((s: any) => ({ name: String(s?.name ?? "service"), run: String(s?.run ?? ""), ...(s?.ready ? { ready: String(s.ready) } : {}) })),
  };
  if (recipe.run.length > 20) problems.push("run has more than 20 steps");
  if (recipe.run.some((s) => !s.run.trim() || s.run.length > 4000)) problems.push("every run step needs a command (under 4,000 characters)");
  if (recipe.files.some((f) => !f.path.startsWith("/") || f.path.startsWith("/workspace"))) problems.push("files need absolute paths outside /workspace");
  if (recipe.files.reduce((a, f) => a + f.content.length, 0) > 64_000) problems.push("files total more than 64 KB");
  if (Object.keys(recipe.env).some((k) => !/^[A-Z_][A-Z0-9_]*$/.test(k))) problems.push("env names must be upper-case");
  if (recipe.start.some((s) => !s.run.trim())) problems.push("every start entry needs a command");
  return { recipe, problems };
}

