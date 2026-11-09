// Repos and session worktrees (COMPUTER_SPEC §5).
// - Each repo the teammate works in has a bare repo on /workspace (/workspace/repos/<repo>.git: commits are
//   durable at once) and, per session, a checkout on the VM's own disk (/work/<session>/<repo>, much faster).
// - The VM never holds a write credential. The host keeps a mirror per repo (data/teammates/<slug>/mirror) that the
//   agent can never write; updates reach the VM as a git bundle in /workspace, and published work comes back the
//   same way. Host git never runs against a repo config the agent can write.
// - Branches are peeblo/<teammate>/<slug>-<4hex> (the prefix is config, never the model's). The base is
//   origin/<base> after a fetch.
// - After every turn, uncommitted work is saved to refs/peeblo/wip/<session>, so a lost VM disk loses nothing.
// - Publishing checks the bundle: only the session's own prefixed branch, not the default or a protected branch,
//   no tags, no deletes, fast-forward only. Then the host pushes from the mirror and opens a draft PR.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.ts";
import { pool } from "../db.ts";
import { checkAction, ruleMessage } from "../otari/rules.ts";
import { appendEvent } from "../store/events.ts";
import { secretsForVm } from "../store/secrets.ts";
import { getTeammate, type Teammate } from "../store/teammates.ts";
import { exec as vmExec, isAwake, workspaceOf } from "./controller.ts";

export type RepoConfig = { name: string; remote: string; base: string; credential?: string; protected?: string[]; worktree?: { include?: string[]; setup?: string[]; setup_inputs?: string[] } };
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
export function reposOf(tm: Teammate): RepoConfig[] {
  const list = ((tm.config.computer as any)?.repos ?? []) as any[];
  return list.filter((r) => r && NAME.test(String(r.name)) && typeof r.remote === "string").map((r) => ({ base: "main", ...r }));
}
export const branchPrefix = (tm: Teammate) => String((tm.config as any).git?.branch_prefix ?? "peeblo/{teammate}/").replace("{teammate}", tm.slug);
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const bare = (repo: string) => `/workspace/repos/${repo}.git`;
const wtPath = (sessionId: string, repo: string) => `/work/${sessionId}/${repo}`;
export const mirrorOf = (slug: string, repo: string) => join(config.dataDir, "teammates", slug, "mirror", `${repo}.git`);
// Shared package caches on the VM disk, so a second worktree installs from cache.
export const CACHE_ENV = { npm_config_cache: "/var/cache/peeblo/npm", npm_config_store_dir: "/var/cache/peeblo/pnpm-store", UV_CACHE_DIR: "/var/cache/peeblo/uv", PIP_CACHE_DIR: "/var/cache/peeblo/pip" };

// Host git, only ever against the host-owned mirror (its config is ours). The token goes in a header, per call.
// The token never appears in an error: git's command line is dropped, and its output is scrubbed of the token
// in every form it could take.
function hostGit(args: string[], token?: string | null, cwd?: string): string {
  const header = token ? `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` : null;
  // The header goes in through the environment (GIT_CONFIG_*), not argv, so it isn't in the process list either.
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
  if (header) Object.assign(env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: header });
  try {
    return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=always", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env }).trim();
  } catch (e) {
    const raw = `${(e as { stderr?: string }).stderr ?? ""}`.trim() || `git ${args[0] === "--git-dir" ? args[2] : args[0]} failed`;
    throw new Error(scrub(raw, token).slice(-600));
  }
}
export function scrub(text: string, token?: string | null): string {
  if (!token) return text;
  const forms = [token, Buffer.from(`x-access-token:${token}`).toString("base64"), Buffer.from(token).toString("base64"), encodeURIComponent(token)];
  return forms.reduce((t, f) => t.split(f).join("[redacted]"), text);
}
async function tokenFor(tm: Teammate, r: RepoConfig): Promise<string | null> {
  if (!r.credential) return null;
  return (await secretsForVm(tm.id, [r.credential]))[r.credential]?.value ?? null;
}

async function vm(tm: Teammate, sessionId: string, script: string, timeoutMs = 120_000) {
  const r = await vmExec(tm.id, ["sh", "-c", `set -e\n${script}`], { timeoutMs, sessionId, env: CACHE_ENV });
  return r;
}

// Brings the mirror up to date from the remote, and the teammate's bare repo up to date from the mirror (bundle).
async function sync(tm: Teammate, r: RepoConfig, sessionId: string): Promise<void> {
  const m = mirrorOf(tm.slug, r.name);
  const token = await tokenFor(tm, r);
  if (!existsSync(join(m, "HEAD"))) {
    await mkdir(join(m, ".."), { recursive: true });
    hostGit(["clone", "--mirror", "--quiet", r.remote, m], token);
  } else hostGit(["--git-dir", m, "fetch", "--prune", "--quiet", "origin"], token);
  const inDir = join(workspaceOf(tm.slug), ".peeblo", "in");
  await mkdir(inDir, { recursive: true });
  const bundle = join(inDir, `${r.name}.bundle`);
  rmSync(bundle, { force: true });
  hostGit(["--git-dir", m, "bundle", "create", "--quiet", bundle, "--branches"]);
  const res = await vm(tm, sessionId, `
    b=${sh(bare(r.name))}
    [ -d "$b" ] || { git init -q --bare "$b"; git --git-dir="$b" config gc.auto 0; git --git-dir="$b" config maintenance.auto false; git --git-dir="$b" config core.logAllRefUpdates true; }
    git --git-dir="$b" fetch -q --prune /workspace/.peeblo/in/${r.name}.bundle '+refs/heads/*:refs/remotes/origin/*'`);
  rmSync(bundle, { force: true });
  if (res.exitCode !== 0) throw new Error(`couldn't update ${r.name}: ${res.stderr.slice(-300)}`);
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "work";

export type Worktree = { session_id: string; repo: string; branch: string; base: string; base_commit: string | null; path: string; published: boolean };
export async function worktreesOf(sessionId: string): Promise<Worktree[]> {
  return (await pool.query("SELECT * FROM session_worktrees WHERE session_id = $1 AND removed_at IS NULL ORDER BY created_at", [sessionId])).rows;
}

// Creates (or re-attaches) the session's worktree for a repo. After a lost VM disk, it is rebuilt from the branch
// plus the latest WIP snapshot.
// A repo by its short name or its owner/repo (the GitHub name agents see).
export const repoKey = (tm: Teammate, repo: string) => reposOf(tm).find((x) => x.name === repo || x.name === repo.split("/").pop() || x.remote.replace(/\.git$/, "").endsWith(`/${repo}`))?.name ?? repo;
export async function openRepo(tm: Teammate, sessionId: string, repo: string, slug?: string | null, base?: string | null): Promise<{ wt: Worktree; created: boolean; restored: boolean; setup: string }> {
  repo = repoKey(tm, repo);
  const r = reposOf(tm).find((x) => x.name === repo);
  if (!r) throw Object.assign(new Error(`no repo called ${repo}; this teammate has ${reposOf(tm).map((x) => x.name).join(", ") || "no repos"} (an owner adds repos to its config)`), { status: 404 });
  const existing = (await pool.query("SELECT * FROM session_worktrees WHERE session_id = $1 AND repo = $2 AND removed_at IS NULL", [sessionId, repo])).rows[0] as Worktree | undefined;
  if (existing) {
    const there = await vm(tm, sessionId, `test -e ${sh(existing.path)}/.git`).then((x) => x.exitCode === 0);
    if (there) return { wt: existing, created: false, restored: false, setup: "skipped" };
    await sync(tm, r, sessionId);
    const res = await vm(tm, sessionId, `
      b=${sh(bare(repo))}; w=${sh(existing.path)}
      mkdir -p "$(dirname "$w")"
      git --git-dir="$b" worktree prune 2>/dev/null || true
      git --git-dir="$b" worktree add -q -f -f --relative-paths "$w" ${sh(existing.branch)}
      if git --git-dir="$b" rev-parse -q --verify refs/peeblo/wip/${sessionId} >/dev/null; then cd "$w" && git restore -q --source=refs/peeblo/wip/${sessionId} --worktree -- . && git clean -q -n >/dev/null; fi
      git --git-dir="$b" worktree lock --reason "peeblo session ${sessionId}" "$w" 2>/dev/null || true`);
    if (res.exitCode !== 0) throw new Error(`couldn't restore the worktree: ${res.stderr.slice(-300)}`);
    await appendEvent({ sessionId, runId: null, type: "repo.restored", data: { repo, branch: existing.branch } });
    return { wt: existing, created: false, restored: true, setup: await setup(tm, r, sessionId, existing.path) };
  }
  await sync(tm, r, sessionId);
  const baseRef = base ?? r.base;
  const branch = `${branchPrefix(tm)}${slugify(slug ?? baseRef === r.base ? slug ?? "work" : `on-${baseRef}`)}-${randomBytes(2).toString("hex")}`;
  const path = wtPath(sessionId, repo);
  const res = await vm(tm, sessionId, `
    b=${sh(bare(repo))}; w=${sh(path)}
    start=refs/remotes/origin/${baseRef}
    git --git-dir="$b" rev-parse -q --verify "$start" >/dev/null || start=${sh(baseRef)}
    mkdir -p "$(dirname "$w")"
    git --git-dir="$b" worktree add -q --relative-paths -b ${sh(branch)} "$w" "$start"
    git --git-dir="$b" worktree lock --reason "peeblo session ${sessionId}" "$w"
    cd "$w" && git config user.name ${sh(tm.config.name)} && git config user.email ${sh(`${tm.slug}@peeblo.invalid`)}
    git rev-parse HEAD`);
  if (res.exitCode !== 0) throw new Error(`couldn't create the worktree: ${res.stderr.slice(-300)}`);
  const baseCommit = res.stdout.trim().split("\n").pop() ?? null;
  await pool.query("INSERT INTO session_worktrees (session_id, teammate_id, repo, branch, base, base_commit, path) VALUES ($1, $2, $3, $4, $5, $6, $7)", [sessionId, tm.id, repo, branch, baseRef, baseCommit, path]);
  await appendEvent({ sessionId, runId: null, type: "repo.opened", data: { repo, branch, base: baseRef, base_commit: baseCommit } });
  const wt = (await worktreesOf(sessionId)).find((x) => x.repo === repo)!;
  return { wt, created: true, restored: false, setup: await setup(tm, r, sessionId, path) };
}

// Per-worktree setup: copy the owner's local files (include and .worktreeinclude), then run worktree.setup through
// the rule engine, skipped when the setup hash (stored in the worktree's gitdir) matches.
async function setup(tm: Teammate, r: RepoConfig, sessionId: string, path: string): Promise<string> {
  const local = `/workspace/repos/${r.name}.local`;
  const include = (r.worktree?.include ?? []).map(sh).join(" ");
  await vm(tm, sessionId, `cd ${sh(path)}; L=${sh(local)}; [ -d "$L" ] || exit 0
    list="${include.replace(/"/g, "")}"; [ -f .worktreeinclude ] && list="$list $(grep -v '^#' .worktreeinclude | tr '\\n' ' ')"
    for f in $list; do f=$(echo "$f" | tr -d "'"); [ -e "$L/$f" ] && { mkdir -p "$(dirname "$f")"; cp -R "$L/$f" "$f"; }; done; true`).catch(() => null);
  const steps = r.worktree?.setup ?? [];
  if (!steps.length) return "none";
  const inputs = (r.worktree?.setup_inputs ?? []).map(sh).join(" ");
  const h = await vm(tm, sessionId, `cd ${sh(path)}; { printf %s ${sh(JSON.stringify(steps))}; for f in ${inputs || "/dev/null"}; do [ -f "$f" ] && cat "$f"; done; } | sha256sum | cut -c1-64`);
  const hash = h.stdout.trim();
  const stamp = await vm(tm, sessionId, `cd ${sh(path)}; cat "$(git rev-parse --git-dir)/peeblo-setup.sha256" 2>/dev/null || true`);
  if (stamp.stdout.trim() === hash) return "unchanged (skipped)";
  for (const s of steps) {
    const d = await checkAction({ commands: [s] });
    if (d.decision !== "allow") return `refused by the computer's rules (${s}): ${ruleMessage(d)}`;
    const x = await vm(tm, sessionId, `cd ${sh(path)}; ${s}`, 10 * 60_000);
    if (x.exitCode !== 0) return `failed (${s}): ${(x.stderr || x.stdout).slice(-400)}`;
  }
  await vm(tm, sessionId, `cd ${sh(path)}; echo ${hash} > "$(git rev-parse --git-dir)/peeblo-setup.sha256"`);
  await pool.query("UPDATE session_worktrees SET setup_hash = $3 WHERE session_id = $1 AND repo = $2", [sessionId, r.name, hash]);
  return "ran";
}

// After every turn: tracked and untracked files (minus ignored) as a commit on refs/peeblo/wip/<session>, through a
// temporary index, so the branch and the real index are untouched.
export async function snapshotWip(teammateId: string, sessionId: string): Promise<number> {
  const wts = await worktreesOf(sessionId);
  if (!wts.length || !isAwake(teammateId)) return 0;
  const tm = (await getTeammate(teammateId))!;
  let n = 0;
  for (const w of wts) {
    const r = await vm(tm, sessionId, `cd ${sh(w.path)} 2>/dev/null || exit 0
      t=$(mktemp); cp "$(git rev-parse --git-dir)/index" "$t" 2>/dev/null || true
      GIT_INDEX_FILE="$t" git add -A >/dev/null 2>&1
      tree=$(GIT_INDEX_FILE="$t" git write-tree); rm -f "$t"
      c=$(git commit-tree "$tree" -p HEAD -m "peeblo wip ${sessionId}")
      git update-ref refs/peeblo/wip/${sessionId} "$c"; echo "$c"`).catch(() => null);
    if (r?.exitCode === 0) n++;
  }
  return n;
}

// What the agent is told each turn (K10): its own repos, and the other live sessions' branches and touched paths.
export async function repoFacts(tm: Teammate, sessionId: string): Promise<string> {
  const mine = await worktreesOf(sessionId);
  const others = (await pool.query(
    `SELECT w.* FROM session_worktrees w JOIN sessions s ON s.id = w.session_id WHERE w.teammate_id = $1 AND w.session_id <> $2 AND w.removed_at IS NULL AND s.status = 'open'`, [tm.id, sessionId])).rows as Worktree[];
  if (!mine.length && !others.length) return "";
  const lines: string[] = [];
  for (const w of mine) lines.push(`- you: ${w.repo} at ${w.path}, branch ${w.branch}, based on origin/${w.base} @ ${(w.base_commit ?? "").slice(0, 10)}${w.published ? " (published)" : ""}`);
  for (const w of others) {
    let paths = "";
    if (isAwake(tm.id)) {
      const r = await vm(tm, sessionId, `cd ${sh(w.path)} 2>/dev/null && { git diff --name-only ${sh(w.base_commit ?? "HEAD")} 2>/dev/null; git ls-files -o --exclude-standard; } | sort -u | head -20`).catch(() => null);
      paths = (r?.stdout ?? "").trim().split("\n").filter(Boolean).join(", ");
    }
    lines.push(`- another conversation: ${w.repo}, branch ${w.branch}${paths ? `, touching ${paths}` : ""}`);
  }
  return `<peeblo_event kind="repos">Repos in use (paths only):\n${lines.join("\n")}</peeblo_event>\n`;
}

// --- publishing ---
export type PublishCheck = { ok: true; heads: string[] } | { ok: false; reason: string };
// The rail: what a bundle may contain. Pure checks over `git bundle list-heads` and the mirror's refs.
export function checkBundle(mirror: string, bundle: string, w: { branch: string; base: string }, protectedBranches: string[], prefix: string): PublishCheck {
  try { hostGit(["--git-dir", mirror, "bundle", "verify", "--quiet", bundle]); } catch (e) { return { ok: false, reason: `the bundle doesn't verify: ${String((e as any).stderr ?? e).slice(0, 200)}` }; }
  const heads = hostGit(["--git-dir", mirror, "bundle", "list-heads", bundle]).split("\n").filter(Boolean).map((l) => l.split(" ")[1]);
  const def = (() => { try { return hostGit(["--git-dir", mirror, "symbolic-ref", "--short", "HEAD"]); } catch { return "main"; } })();
  for (const h of heads) {
    if (h.startsWith("refs/tags/")) return { ok: false, reason: `tags can't be published (${h})` };
    if (!h.startsWith("refs/heads/")) return { ok: false, reason: `only branches can be published (${h})` };
    const name = h.slice("refs/heads/".length);
    if (name === def || name === w.base || protectedBranches.includes(name)) return { ok: false, reason: `${name} is the default or a protected branch; teammates publish only their own branches` };
    if (!name.startsWith(prefix) || name !== w.branch) return { ok: false, reason: `${name} isn't this conversation's branch (${w.branch})` };
  }
  if (heads.length !== 1) return { ok: false, reason: `expected exactly the branch ${w.branch}, got ${heads.join(", ") || "nothing"}` };
  return { ok: true, heads };
}

export async function publish(tm: Teammate, sessionId: string, repo: string, pr?: { title: string; body?: string } | null, ontoPr?: number | null): Promise<{ text: string; pushed: string; pr_url?: string | null }> {
  if (String((tm.config as any).git?.publish ?? "own-branches") === "off") throw new Error("publishing is off for this teammate");
  const r = reposOf(tm).find((x) => x.name === repo);
  const w = (await worktreesOf(sessionId)).find((x) => x.repo === repo);
  if (!r || !w) throw new Error(`open ${repo} with repo_open first`);
  await sync(tm, r, sessionId);
  // Scratch work never ships: probe and debug scripts the branch adds are refused by name.
  const added = await vm(tm, sessionId, `cd ${sh(w.path)} && git diff --name-only --diff-filter=A refs/remotes/origin/${w.base}...HEAD`);
  const scratch = String(added.stdout ?? "").split("\n").filter((f) => /(^|\/)(probe|dbg|debug|scratch|tmp|temp)[^/]*\.(m?[jt]s|cjs|py|sh|txt|log)$/i.test(f.trim()));
  if (scratch.length) {
    await appendEvent({ sessionId, runId: null, type: "repo.publish_refused", data: { repo, reason: "scratch files", files: scratch } });
    throw new Error(`refused: these look like scratch files and don't belong in the PR: ${scratch.join(", ")}. Remove them in a new commit (git rm), then publish.`);
  }
  const out = join(workspaceOf(tm.slug), ".peeblo", "out");
  await mkdir(out, { recursive: true });
  const file = `${sessionId}-${repo}.bundle`;
  const made = await vm(tm, sessionId, `cd ${sh(w.path)}; mkdir -p /workspace/.peeblo/out; git bundle create -q /workspace/.peeblo/out/${file} ${sh(`refs/heads/${w.branch}`)} ^refs/remotes/origin/${w.base}`);
  if (made.exitCode !== 0) {
    if (/empty/i.test(made.stderr)) throw new Error(`nothing to publish: ${w.branch} has no commits that aren't on ${w.base}. Commit first.`);
    throw new Error(`couldn't bundle the branch: ${made.stderr.slice(-300)}`);
  }
  const m = mirrorOf(tm.slug, repo);
  const bundle = join(out, file);
  try {
    const c = checkBundle(m, bundle, w, r.protected ?? [], branchPrefix(tm));
    if (!c.ok) { await appendEvent({ sessionId, runId: null, type: "repo.publish_refused", data: { repo, reason: c.reason } }); throw new Error(`refused: ${c.reason}`); }
    // Fast-forward only: the remote branch (if any) must be an ancestor of what we push.
    const ref = `refs/heads/${w.branch}`;
    const before = (() => { try { return hostGit(["--git-dir", m, "rev-parse", "-q", "--verify", ref]); } catch { return null; } })();
    hostGit(["--git-dir", m, "fetch", "--quiet", bundle, `${ref}:refs/peeblo/incoming/${sessionId}`]);
    const incoming = hostGit(["--git-dir", m, "rev-parse", `refs/peeblo/incoming/${sessionId}`]);
    if (before) {
      try { hostGit(["--git-dir", m, "merge-base", "--is-ancestor", before, incoming]); }
      catch { await appendEvent({ sessionId, runId: null, type: "repo.publish_refused", data: { repo, reason: "not a fast-forward" } }); throw new Error(`refused: ${w.branch} was rewritten since it was last published (not a fast-forward); teammates never force-push. Make new commits on top instead.`); }
    }
    const token = await tokenFor(tm, r);
    // Onto an open PR's branch in the same repo (not a fork, not the default or a protected branch), fast-forward
    // only: the PR's current head must already be in what we push.
    if (ontoPr) {
      const gh = /github\.com[/:]([^/]+)\/([^/.]+)(\.git)?$/.exec(r.remote);
      if (!gh || !token) throw new Error("pushing to a pull request needs a GitHub repo with a credential");
      const pj: any = await (await fetch(`https://api.github.com/repos/${gh[1]}/${gh[2]}/pulls/${ontoPr}`, { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "peeblo" } })).json();
      if (!pj?.head?.ref) throw new Error(`no pull request #${ontoPr} in ${gh[1]}/${gh[2]}`);
      if (pj.state !== "open") throw new Error(`#${ontoPr} is ${pj.state}; only an open PR's branch can take new commits`);
      if (pj.head.repo?.full_name !== `${gh[1]}/${gh[2]}`) throw new Error(`#${ontoPr} comes from a fork; push to your own branch and open a PR instead`);
      const target = String(pj.head.ref);
      const def = (() => { try { return hostGit(["--git-dir", m, "symbolic-ref", "--short", "HEAD"]); } catch { return "main"; } })();
      if (target === def || target === w.base || (r.protected ?? []).includes(target)) throw new Error(`${target} is the default or a protected branch`);
      hostGit(["--git-dir", m, "fetch", "--quiet", r.remote, `+refs/heads/${target}:refs/peeblo/pr/${ontoPr}`], token);
      const head = hostGit(["--git-dir", m, "rev-parse", `refs/peeblo/pr/${ontoPr}`]);
      try { hostGit(["--git-dir", m, "merge-base", "--is-ancestor", head, incoming]); }
      catch { throw new Error(`your branch doesn't contain #${ontoPr}'s latest commit (${head.slice(0, 10)} on ${target}); merge or rebase onto origin/${target} first, then publish again`); }
      hostGit(["--git-dir", m, "push", "--quiet", r.remote, `${incoming}:refs/heads/${target}`], token);
      hostGit(["--git-dir", m, "update-ref", "-d", `refs/peeblo/incoming/${sessionId}`]);
      await appendEvent({ sessionId, runId: null, type: "repo.published", data: { repo, branch: target, pr: ontoPr, commit: incoming, pr_url: pj.html_url } });
      return { text: `Pushed ${incoming.slice(0, 10)} onto #${ontoPr}'s branch ${target}: ${pj.html_url}`, pushed: incoming, pr_url: pj.html_url };
    }
    // To the URL, not "origin": a mirror's origin pushes every ref and takes no refspec.
    hostGit(["--git-dir", m, "push", "--quiet", r.remote, `${incoming}:${ref}`], token);
    hostGit(["--git-dir", m, "update-ref", ref, incoming]);
    hostGit(["--git-dir", m, "update-ref", "-d", `refs/peeblo/incoming/${sessionId}`]);
    let prUrl: string | null = null;
    if (pr?.title) prUrl = await openDraftPr(tm, r, w, pr).catch((e) => { throw new Error(`pushed ${w.branch}, but the draft PR failed: ${(e as Error).message}`); });
    await pool.query("UPDATE session_worktrees SET published = true, pr_url = coalesce($3, pr_url) WHERE session_id = $1 AND repo = $2", [sessionId, repo, prUrl]);
    await appendEvent({ sessionId, runId: null, type: "repo.published", data: { repo, branch: w.branch, commit: incoming, pr_url: prUrl } });
    return { text: `Pushed ${w.branch} (${incoming.slice(0, 10)})${prUrl ? ` and opened a draft PR: ${prUrl}` : ""}.`, pushed: incoming, pr_url: prUrl };
  } finally {
    rmSync(bundle, { force: true });
  }
}

// A draft PR through GitHub's REST API with the repo's credential (the same token that pushed).
async function openDraftPr(tm: Teammate, r: RepoConfig, w: Worktree, pr: { title: string; body?: string }): Promise<string> {
  const m = /github\.com[/:]([^/]+)\/([^/.]+)(\.git)?$/.exec(r.remote);
  if (!m) throw new Error("draft PRs need a GitHub remote");
  const token = await tokenFor(tm, r);
  if (!token) throw new Error(`the repo has no credential to open a PR with`);
  const res = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}/pulls`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "peeblo" },
    body: JSON.stringify({ title: pr.title, body: `${pr.body ?? ""}\n\n_Opened by ${tm.config.name}, a Peeblo teammate._`.trim(), head: w.branch, base: w.base, draft: true }),
  });
  const j: any = await res.json();
  if (!res.ok) {
    if (res.status === 422 && /already exists/i.test(JSON.stringify(j))) return `https://github.com/${m[1]}/${m[2]}/pulls?q=head:${encodeURIComponent(w.branch)}`;
    throw new Error(`${res.status} ${j?.message ?? ""}`);
  }
  return j.html_url;
}

// --- cleanup ---
// Ends a session's worktrees: WIP snapshot, unlock, remove; the branch stays if it has commits not on the base or
// was published, else it is deleted. WIP refs are kept 14 days.
export async function endWorktrees(teammateId: string, sessionId: string): Promise<{ removed: string[]; kept: string[] }> {
  const tm = (await getTeammate(teammateId))!;
  const out = { removed: [] as string[], kept: [] as string[] };
  for (const w of await worktreesOf(sessionId)) {
    await snapshotWip(teammateId, sessionId).catch(() => 0);
    const r = await vm(tm, sessionId, `
      b=${sh(bare(w.repo))}; w=${sh(w.path)}
      git --git-dir="$b" worktree unlock "$w" 2>/dev/null || true
      git --git-dir="$b" worktree remove --force "$w" 2>/dev/null || { rm -rf "$w"; git --git-dir="$b" worktree prune; }
      ahead=$(git --git-dir="$b" rev-list --count refs/remotes/origin/${w.base}..${sh(`refs/heads/${w.branch}`)} 2>/dev/null || echo 0)
      if [ "$ahead" = 0 ] && [ ${w.published ? 1 : 0} = 0 ]; then git --git-dir="$b" branch -q -D ${sh(w.branch)}; echo deleted; else echo kept; fi`).catch(() => null);
    const kept = (r?.stdout ?? "").includes("kept");
    (kept ? out.kept : out.removed).push(w.branch);
    await pool.query("UPDATE session_worktrees SET removed_at = now() WHERE session_id = $1 AND repo = $2", [sessionId, w.repo]);
    await appendEvent({ sessionId, runId: null, type: "repo.closed", data: { repo: w.repo, branch: w.branch, branch_kept: kept } });
  }
  return out;
}

// The periodic sweep (when the teammate has no live run): end worktrees of closed or long-idle sessions, drop WIP
// refs older than 14 days, and run git maintenance.
export async function sweep(teammateId: string, idleHours = Number(process.env.PEEBLO_SESSION_TTL_HOURS ?? 24)): Promise<number> {
  const live = (await pool.query(`SELECT count(*)::int AS n FROM runs r JOIN sessions s ON s.id = r.session_id WHERE s.teammate_id = $1 AND r.status IN ('running', 'waiting')`, [teammateId])).rows[0].n;
  if (live > 0 || !isAwake(teammateId)) return 0;
  const { rows } = await pool.query(
    `SELECT DISTINCT w.session_id FROM session_worktrees w JOIN sessions s ON s.id = w.session_id
      WHERE w.teammate_id = $1 AND w.removed_at IS NULL AND (s.status = 'closed' OR s.last_active_at < now() - make_interval(hours => $2))`, [teammateId, idleHours]);
  for (const r of rows) await endWorktrees(teammateId, r.session_id).catch(() => {});
  const tm = (await getTeammate(teammateId))!;
  for (const repo of reposOf(tm)) {
    await vm(tm, "sweep", `b=${sh(bare(repo.name))}; [ -d "$b" ] || exit 0
      cut=$(( $(date +%s) - 14*86400 ))
      git --git-dir="$b" for-each-ref --format='%(refname) %(committerdate:unix)' refs/peeblo/wip | while read ref t; do [ "$t" -lt "$cut" ] && git --git-dir="$b" update-ref -d "$ref"; done
      git --git-dir="$b" worktree prune; git --git-dir="$b" maintenance run --quiet 2>/dev/null || git --git-dir="$b" gc --quiet --auto`).catch(() => null);
  }
  return rows.length;
}
