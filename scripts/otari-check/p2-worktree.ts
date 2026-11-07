// Worktrees and branches (COMPUTER_SPEC §5), on a real GitHub test repo (hitakshiA/acme-checkout-api):
// - two parallel real turns commit on readable branches with no conflict; main stays as it was;
// - a VM disk reset mid-session restores the uncommitted work from the WIP snapshot;
// - repo_publish pushes the session's own branch and opens a draft PR;
// - a push to main, a tag and a rewritten (non-fast-forward) branch are refused in code; git push from the VM is
//   blocked at egress;
// - session end removes the worktree, keeps a branch that has commits and deletes one that has none.
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, expect, save } from "./harness.ts";
import { api, ensureTeammate } from "./api.ts";
import { turn, used } from "./n-common.ts";
const { pool } = await import("../../src/db.ts");
const { diskOf, exec, sleep, sleepAll } = await import("../../src/environment/controller.ts");
const R = await import("../../src/environment/repos.ts");
const { getTeammate } = await import("../../src/store/teammates.ts");
const { newId } = await import("../../src/ids.ts");

const S = "P2W";
const slug = "vm-git";
const REPO = "checkout-api";
const GH = "hitakshiA/acme-checkout-api";
const token = execSync("gh auth token").toString().trim();
await ensureTeammate(slug, {
  name: "Patch", role: "Fixes bugs in acme's checkout API", tools: ["computer"], connectors: [], mode: "auto",
  budget: { monthly_usd: 3 }, model: { default: "deepseek/deepseek-v4.1-flash-1017", fallback: "xiaomi/mimo-v2.6-pro" },
  computer: { size: "small", allowed_hosts: [], repos: [{ name: REPO, remote: `https://github.com/${GH}.git`, base: "main", credential: "GH_TOKEN" }] },
});
await api("PUT", `/v1/teammates/${slug}/secrets/GH_TOKEN`, { value: token, hosts: ["github.com", "api.github.com"] });
const tm = (await getTeammate(slug))!;
const mainBefore = execSync(`gh api repos/${GH}/commits/main --jq .sha`).toString().trim();
const session = async () => {
  const id = newId("se");
  await pool.query("INSERT INTO sessions (id, teammate_id, kind, place_key) VALUES ($1, $2, 'api', $3)", [id, tm.id, `check:wt-${id}`]);
  return id;
};
const sh = (sid: string, cmd: string) => exec(tm.id, ["sh", "-c", cmd], { sessionId: sid, cwd: `/work/${sid}/${REPO}` });
const cleanup: (() => Promise<void>)[] = [];
// Turns run in core's VM, direct steps in this script's: only one may be awake at a time (they share the disk).
const toCore = () => sleepAll();
const toScript = () => api("POST", `/v1/teammates/${slug}/computer/sleep`);

await check(S, "two parallel real turns commit on readable branches with no conflict", async (c) => {
  const ask = (n: string) => `Open the ${REPO} repo, add a file notes/${n}.md containing the word ${n}, and commit it (message "add ${n} note"). Tell me the branch name.`;
  await toCore();
  const [a, b] = await Promise.all([turn(slug, "wt-one", ask("one")), turn(slug, "wt-two", ask("two"))]);
  await toScript();
  const wa = (await R.worktreesOf(a.sessionId))[0], wb = (await R.worktreesOf(b.sessionId))[0];
  c.note("tools", [a, b].map((r) => r.tools.map((x: any) => `${x.tool}:${x.status}`).join(" ")));
  expect(wa && wb && wa.branch !== wb.branch && wa.branch.startsWith(`peeblo/${slug}/`), `branches: ${wa?.branch} / ${wb?.branch}`);
  for (const [w, n] of [[wa, "one"], [wb, "two"]] as const) {
    const files = await exec(tm.id, ["sh", "-c", `git --git-dir=/workspace/repos/${REPO}.git diff --name-only refs/remotes/origin/main ${w.branch}`]);
    expect(files.stdout.trim() === `notes/${n}.md`, `${w.branch} changed: ${files.stdout.trim() || "nothing"}`);
  }
  const main = await exec(tm.id, ["sh", "-c", `git --git-dir=/workspace/repos/${REPO}.git rev-parse refs/remotes/origin/main`]);
  expect(main.stdout.trim() === mainBefore, "origin/main moved");
  // Both branches merge with no conflict (in a scratch worktree).
  const m = await exec(tm.id, ["sh", "-c", `set -e; g=/workspace/repos/${REPO}.git; rm -rf /work/merge-check; git --git-dir=$g worktree add -q --detach /work/merge-check refs/remotes/origin/main; cd /work/merge-check; git -c user.name=c -c user.email=c@x merge -q --no-edit ${wa.branch} ${wb.branch}; ls notes; cd /; git --git-dir=$g worktree remove --force /work/merge-check`]);
  expect(m.exitCode === 0 && /one\.md/.test(m.stdout) && /two\.md/.test(m.stdout), `merge: ${m.stdout} ${m.stderr.slice(-200)}`);
  c.note("branches", [wa.branch, wb.branch]);
  cleanup.push(async () => { for (const r of [a, b]) await R.endWorktrees(tm.id, r.sessionId); });
});

await check(S, "a VM disk reset mid-session restores the uncommitted work", async (c) => {
  const sid = await session();
  await R.openRepo(tm, sid, REPO, "wip-check");
  await sh(sid, "echo draft-in-progress > draft.txt && echo changed >> README.md");
  expect(await R.snapshotWip(tm.id, sid) === 1, "no WIP snapshot");
  await sleep(tm.id, "check");
  rmSync(diskOf(slug, "small"), { force: true });
  await pool.query("UPDATE environments SET l2 = l2 - 'small' WHERE teammate_id = $1", [tm.id]);
  const r = await R.openRepo(tm, sid, REPO);
  const back = await sh(sid, "cat draft.txt; tail -1 README.md; git status --porcelain | wc -l");
  c.note("restored", r.restored); c.note("files", back.stdout.trim().replace(/\n/g, " | "));
  expect(r.restored && /draft-in-progress/.test(back.stdout) && /changed/.test(back.stdout), `after reset: ${back.stdout} ${back.stderr}`);
  cleanup.push(() => R.endWorktrees(tm.id, sid).then(() => {}));
});

await check(S, "repo_publish pushes the session's own branch and opens a draft PR", async (c) => {
  await toCore();
  const r = await turn(slug, "wt-publish", `Open the ${REPO} repo with the slug "peeblo-check", add a file notes/publish-check.md saying "checked by Peeblo", commit it, and publish it as a draft PR titled "Peeblo publish check".`);
  await toScript();
  const p = used(r.tools, "repo_publish").find((x) => x.status === "completed");
  c.note("tools", r.tools.map((x: any) => `${x.tool}:${x.status}`).join(" "));
  expect(p?.result?.pr_url, `repo_publish: ${JSON.stringify(used(r.tools, "repo_publish").map((x) => [x.status, x.error]))}`);
  const w = (await R.worktreesOf(r.sessionId))[0];
  const pr = JSON.parse(execSync(`gh pr list -R ${GH} --head ${w.branch} --json number,isDraft,headRefName,url`).toString())[0];
  expect(pr?.isDraft && pr.headRefName === w.branch, `PR: ${JSON.stringify(pr)}`);
  c.note("pr", pr.url);
  cleanup.push(async () => {
    execSync(`gh pr close ${pr.number} -R ${GH} --delete-branch`, { stdio: "ignore" });
    await R.endWorktrees(tm.id, r.sessionId);
  });
  // A rewritten branch (non-fast-forward) is refused.
  await sh(r.sessionId, "git commit -q --amend -m 'rewritten'");
  const again = await R.publish(tm, r.sessionId, REPO, null).then(() => "pushed", (e) => (e as Error).message);
  expect(/fast-forward/i.test(again), `after a rewrite: ${again}`);
});

await check(S, "a push to main, a tag and a direct git push are refused", async (c) => {
  const sid = await session();
  const w = (await R.openRepo(tm, sid, REPO, "refusal-check")).wt;
  await sh(sid, "echo x > refusal.txt && git add refusal.txt && git commit -qm refusal && git tag v-check");
  const push = await sh(sid, "git push origin HEAD:main 2>&1; echo exit=$?");
  expect(/exit=[1-9]/.test(push.stdout), `git push from the VM: ${push.stdout.slice(-200)}`);
  // Bundles a session could hand over instead of its own branch, checked by the same rail repo_publish uses.
  const mirror = R.mirrorOf(slug, REPO);
  const dir = mkdtempSync(join(tmpdir(), "peeblo-bundle-"));
  const make = async (name: string, refs: string) => {
    await sh(sid, `git bundle create -q /workspace/.peeblo/out/${name}.bundle ${refs} ^refs/remotes/origin/main`);
    return join(R.mirrorOf(slug, REPO), "..", "..", "workspace", ".peeblo", "out", `${name}.bundle`);
  };
  await sh(sid, "git branch -f main HEAD");
  const toMain = R.checkBundle(mirror, await make("to-main", "refs/heads/main"), w, [], R.branchPrefix(tm));
  const tag = R.checkBundle(mirror, await make("tag", "refs/tags/v-check"), w, [], R.branchPrefix(tm));
  const own = R.checkBundle(mirror, await make("own", `refs/heads/${w.branch}`), w, [], R.branchPrefix(tm));
  rmSync(dir, { recursive: true, force: true });
  c.note("main", !toMain.ok && toMain.reason); c.note("tag", !tag.ok && tag.reason);
  expect(!toMain.ok && /default or a protected/.test(toMain.reason), `main: ${JSON.stringify(toMain)}`);
  expect(!tag.ok && /tags/.test(tag.reason), `tag: ${JSON.stringify(tag)}`);
  expect(own.ok, `own branch: ${JSON.stringify(own)}`);
  cleanup.push(async () => { await sh(sid, "git tag -d v-check; git branch -D main 2>/dev/null; true"); await R.endWorktrees(tm.id, sid); });
});

await check(S, "session end removes the worktree, keeps a branch with commits, deletes one without", async (c) => {
  const withCommits = await session(), empty = await session();
  const a = (await R.openRepo(tm, withCommits, REPO, "keeps")).wt;
  const b = (await R.openRepo(tm, empty, REPO, "drops")).wt;
  await sh(withCommits, "echo k > keep.txt && git add keep.txt && git commit -qm keep");
  const ra = await R.endWorktrees(tm.id, withCommits), rb = await R.endWorktrees(tm.id, empty);
  const branches = (await exec(tm.id, ["sh", "-c", `git --git-dir=/workspace/repos/${REPO}.git branch --format='%(refname:short)'`])).stdout;
  const dirs = (await exec(tm.id, ["sh", "-c", `ls /work/${withCommits} /work/${empty} 2>&1 | grep -c ${REPO} || true`])).stdout.trim();
  c.note("kept", ra.kept); c.note("removed", rb.removed);
  expect(branches.includes(a.branch) && !branches.includes(b.branch), `branches left: ${branches}`);
  expect(dirs === "0", "a worktree folder is still there");
  await exec(tm.id, ["sh", "-c", `git --git-dir=/workspace/repos/${REPO}.git branch -q -D ${a.branch}`]);
});
for (const f of cleanup) await f().catch(() => {});
const mainAfter = execSync(`gh api repos/${GH}/commits/main --jq .sha`).toString().trim();
if (mainAfter !== mainBefore) console.log("WARNING: main moved on GitHub");
await sleepAll();
await pool.end();
process.exit((await save(S)) ? 0 : 1);
