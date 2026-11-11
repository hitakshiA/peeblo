import { normalizeRecipe, type Recipe } from "../environment/recipe-schema.ts";
// Teammate identity and instructions are versioned config: an edit is a new version, never an overwrite,
// and only people (or Peeblo acting for a person) can make one. The agent itself has no write path here.
import { pool } from "../db.ts";
import { newId } from "../ids.ts";

export type TeammateConfig = {
  name: string; // display name, e.g. "Sprout"
  role: string; // one line, e.g. "Growth analyst for Maya"
  instructions: string; // standing instructions
  model: { default: string; fallback?: string };
  budget: { monthly_usd: number };
  tools: string[]; // tool names the teammate may use: "web" (Otari web search + fetch), …
  web: { allowed_domains: string[]; blocked_domains: string[] }; // Otari enforces these on search and fetch
  connectors: string[]; // names of MCP servers stored in Otari, e.g. "linear", "posthog"
  connector_scopes: Record<string, string[]>; // e.g. { github: ["acme/checkout-api", "acme/*"] }
  read_only?: string[]; // connectors this teammate may only read (e.g. ["stripe"])
  computer: { size: "small" | "large"; allowed_hosts: string[]; recipe: Recipe; repos?: unknown[] };
  git?: { branch_prefix: string; publish: "off" | "own-branches" }; // hosts beyond the defaults; setup commands run once into the disk
  mode: "ask" | "auto" | "trusted" | "yolo";
  // What its Slack profile says, written by the agent at hire (Peeblo drafts it; the owner approves it on the ID
  // card): a bio for the long description, the one line under its name in agent view, and up to 4 starter prompts.
  profile?: { bio: string; agent_description: string; starter_prompts: { title: string; message: string }[] };
};

export type Teammate = { id: string; slug: string; owner_person: string | null; version: number; config: TeammateConfig; created_at: Date };

const SLUG = /^[a-z][a-z0-9-]{1,30}$/;

export function validateConfig(c: Partial<TeammateConfig>): TeammateConfig {
  const problems: string[] = [];
  if (!c.name?.trim()) problems.push("name is required");
  if (!c.role?.trim()) problems.push("role is required");
  if (!c.model?.default?.trim()) problems.push("model.default is required");
  const budget = Number(c.budget?.monthly_usd ?? 10);
  if (!(budget >= 0)) problems.push("budget.monthly_usd must be a number >= 0");
  const size = c.computer?.size ?? "small";
  if (size !== "small" && size !== "large") problems.push("computer.size must be small or large");
  const mode = c.mode ?? "auto";
  if (!["ask", "auto", "trusted", "yolo"].includes(mode)) problems.push("mode must be ask, auto, trusted or yolo");
  const connectors = c.connectors ?? [];
  if (!Array.isArray(connectors) || !connectors.every((x) => typeof x === "string" && /^[a-zA-Z0-9_.-]{1,64}$/.test(x)))
    problems.push("connectors must be a list of Otari MCP server names");
  const web = {
    allowed_domains: hosts(c.web?.allowed_domains, "web.allowed_domains", problems),
    blocked_domains: hosts(c.web?.blocked_domains, "web.blocked_domains", problems),
  };
  const connectorScopes = scopesOf(c.connector_scopes, problems);
  const { recipe, problems: recipeProblems } = normalizeRecipe((c.computer as { recipe?: unknown } | undefined)?.recipe);
  problems.push(...recipeProblems.map((x) => `computer.recipe: ${x}`));
  const computerHosts = hosts((c.computer as { allowed_hosts?: unknown } | undefined)?.allowed_hosts, "computer.allowed_hosts", problems);
  // Repos the teammate works in (each session gets its own checkout and branch), and the branch rules.
  const rawRepos = (c.computer as { repos?: unknown } | undefined)?.repos ?? [];
  const repos: any[] = [];
  if (!Array.isArray(rawRepos)) problems.push("computer.repos must be a list");
  else
    for (const r of rawRepos as any[]) {
      if (!r || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(String(r.name)) || !/^(https:\/\/|git@|\/)/.test(String(r.remote ?? ""))) {
        problems.push("each computer.repos entry needs a name and an https/ssh/local remote");
        continue;
      }
      const list = (v: unknown) => (Array.isArray(v) ? v.map(String).slice(0, 20) : []);
      repos.push({
        name: String(r.name),
        remote: String(r.remote),
        base: String(r.base ?? "main"),
        ...(r.credential ? { credential: String(r.credential) } : {}),
        protected: list(r.protected),
        worktree: { include: list(r.worktree?.include), setup: list(r.worktree?.setup), setup_inputs: list(r.worktree?.setup_inputs) },
      });
    }
  const g = (c as { git?: any }).git ?? {};
  const prefix = String(g.branch_prefix ?? "peeblo/{teammate}/");
  if (!/^[A-Za-z0-9._/{}-]{1,60}\/$/.test(prefix) || /\.\.|\/\//.test(prefix))
    problems.push("git.branch_prefix must be a branch path ending in /");
  const publish = String(g.publish ?? "own-branches");
  if (!["off", "own-branches"].includes(publish)) problems.push("git.publish must be off or own-branches");
  const pr = (c as { profile?: any }).profile;
  let profile: TeammateConfig["profile"] | undefined;
  if (pr) {
    const prompts = Array.isArray(pr.starter_prompts)
      ? pr.starter_prompts
          .slice(0, 4)
          .map((x: any) => ({ title: String(x?.title ?? "").slice(0, 75), message: String(x?.message ?? "").slice(0, 2000) }))
          .filter((x: any) => x.title && x.message)
      : [];
    profile = {
      bio: String(pr.bio ?? "").slice(0, 3000),
      agent_description: String(pr.agent_description ?? "").slice(0, 300),
      starter_prompts: prompts,
    };
  }
  if (problems.length) throw Object.assign(new Error(problems.join("; ")), { status: 400 });
  return {
    ...(profile ? { profile } : {}),
    name: c.name!.trim(),
    role: c.role!.trim(),
    instructions: c.instructions?.trim() ?? "",
    model: { default: c.model!.default.trim(), ...(c.model!.fallback ? { fallback: c.model!.fallback.trim() } : {}) },
    budget: { monthly_usd: budget },
    tools: [...new Set(c.tools ?? [])],
    web,
    connectors: [...new Set(connectors)],
    connector_scopes: connectorScopes,
    read_only: [...new Set<string>(((c as any).read_only ?? []).map(String))].filter((x) => (connectors as string[]).includes(x)),
    computer: { size, allowed_hosts: computerHosts, recipe, repos },
    git: { branch_prefix: prefix, publish: publish as "off" | "own-branches" },
    mode: mode as TeammateConfig["mode"],
  };
}

function scopesOf(v: unknown, problems: string[]): Record<string, string[]> {
  if (v === undefined || v === null) return {};
  if (
    typeof v !== "object" ||
    Array.isArray(v) ||
    !Object.values(v).every((l) => Array.isArray(l) && l.every((x) => typeof x === "string" && /^[\w.-]+\/[\w.*-]+$/.test(x)))
  ) {
    problems.push('connector_scopes must map a connector name to a list like ["owner/repo", "owner/prefix-*"]');
    return {};
  }
  return v as Record<string, string[]>;
}

// Otari takes bare hostnames, at most 100 per list.
const HOST = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/;
function hosts(v: unknown, name: string, problems: string[]): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 100 || !v.every((h) => typeof h === "string" && HOST.test(h.trim().toLowerCase()))) {
    problems.push(`${name} must be a list of up to 100 bare hostnames like docs.stripe.com`);
    return [];
  }
  return [...new Set(v.map((h: string) => h.trim().toLowerCase()))];
}

export async function createTeammate(
  slug: string,
  config: Partial<TeammateConfig>,
  by: { personId: string | null; label: string },
): Promise<Teammate> {
  if (!SLUG.test(slug))
    throw Object.assign(new Error("slug must be lowercase letters, digits or dashes, 2-31 chars, starting with a letter"), { status: 400 });
  const valid = validateConfig(config);
  const id = newId("tm");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO teammates (id, slug, owner_person) VALUES ($1, $2, $3)", [id, slug, by.personId]);
    await client.query("INSERT INTO teammate_versions (teammate_id, version, config, changed_by, note) VALUES ($1, 1, $2, $3, 'hired')", [
      id,
      valid,
      by.label,
    ]);
    await client.query("INSERT INTO audit (actor, action, target, data) VALUES ($1, 'teammate.create', $2, $3)", [by.label, id, { slug }]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    if ((error as { code?: string }).code === "23505")
      throw Object.assign(new Error(`a teammate called ${slug} already exists`), { status: 409 });
    throw error;
  } finally {
    client.release();
  }
  return (await getTeammate(id))!;
}

// Configs saved before a field existed get its default when read.
function withDefaults<T extends { config: TeammateConfig }>(row: T): T {
  const c = row.config;
  return {
    ...row,
    config: {
      ...c,
      tools: c.tools ?? [],
      web: c.web ?? { allowed_domains: [], blocked_domains: [] },
      connectors: c.connectors ?? [],
      connector_scopes: c.connector_scopes ?? {},
    },
  };
}

export async function getTeammate(idOrSlug: string): Promise<Teammate | null> {
  const { rows } = await pool.query<Teammate>(
    `SELECT t.id, t.slug, t.owner_person, t.version, v.config, t.created_at
       FROM teammates t JOIN teammate_versions v ON v.teammate_id = t.id AND v.version = t.version
      WHERE (t.id = $1 OR t.slug = $1) AND t.archived_at IS NULL`,
    [idOrSlug],
  );
  return rows[0] ? withDefaults(rows[0]) : null;
}

// The teammate as it was at one config version (a session keeps the version it started with).
export async function teammateAt(id: string, version: number): Promise<Teammate | null> {
  const { rows } = await pool.query<Teammate>(
    `SELECT t.id, t.slug, t.owner_person, v.version, v.config, t.created_at
       FROM teammates t JOIN teammate_versions v ON v.teammate_id = t.id AND v.version = $2
      WHERE t.id = $1 AND t.archived_at IS NULL`,
    [id, version],
  );
  return rows[0] ? withDefaults(rows[0]) : null;
}

export async function listTeammates(): Promise<Teammate[]> {
  const { rows } = await pool.query<Teammate>(
    `SELECT t.id, t.slug, t.owner_person, t.version, v.config, t.created_at, t.hidden
       FROM teammates t JOIN teammate_versions v ON v.teammate_id = t.id AND v.version = t.version
      WHERE t.archived_at IS NULL ORDER BY t.created_at`,
  );
  return rows.map(withDefaults);
}

// A change is a new version built from the current one. Returns the new current config.
export async function updateTeammate(
  idOrSlug: string,
  patch: Partial<TeammateConfig>,
  by: { label: string },
  note?: string,
): Promise<Teammate> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string; version: number; config: TeammateConfig }>(
      `SELECT t.id, t.version, v.config FROM teammates t JOIN teammate_versions v ON v.teammate_id = t.id AND v.version = t.version
        WHERE (t.id = $1 OR t.slug = $1) AND t.archived_at IS NULL FOR UPDATE OF t`,
      [idOrSlug],
    );
    if (!rows[0]) throw Object.assign(new Error(`no teammate ${idOrSlug}`), { status: 404 });
    const cur = rows[0];
    const next = validateConfig({
      ...cur.config,
      ...patch,
      model: { ...cur.config.model, ...(patch.model ?? {}) },
      budget: { ...cur.config.budget, ...(patch.budget ?? {}) },
      computer: { ...cur.config.computer, ...(patch.computer ?? {}) },
      git: { ...(cur.config.git ?? {}), ...((patch as any).git ?? {}) } as any,
      web: { ...cur.config.web, ...(patch.web ?? {}) },
      connector_scopes: { ...(cur.config.connector_scopes ?? {}), ...(patch.connector_scopes ?? {}) },
    });
    const version = cur.version + 1;
    await client.query("INSERT INTO teammate_versions (teammate_id, version, config, changed_by, note) VALUES ($1, $2, $3, $4, $5)", [
      cur.id,
      version,
      next,
      by.label,
      note ?? null,
    ]);
    await client.query("UPDATE teammates SET version = $2 WHERE id = $1", [cur.id, version]);
    await client.query("INSERT INTO audit (actor, action, target, data) VALUES ($1, 'teammate.update', $2, $3)", [
      by.label,
      cur.id,
      { version, note },
    ]);
    await client.query("COMMIT");
    // Its Slack profile follows its config (src/slack/profile.ts listens).
    const { appendEvent } = await import("./events.ts");
    await appendEvent({ type: "teammate.updated", data: { teammate_id: cur.id, version } }).catch(() => {});
    return (await getTeammate(cur.id))!;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function teammateVersions(idOrSlug: string) {
  const { rows } = await pool.query(
    `SELECT v.version, v.changed_by, v.note, v.created_at, v.config FROM teammate_versions v JOIN teammates t ON t.id = v.teammate_id
      WHERE t.id = $1 OR t.slug = $1 ORDER BY v.version`,
    [idOrSlug],
  );
  return rows;
}
