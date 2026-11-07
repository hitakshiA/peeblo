// A worktree per session: when the teammate's workspace is a git repo, each session works in its own git
// worktree on its own branch. Two real turns run in parallel and each commits a file; the branches are
// inspected from the host (git reads the same repo), and both merge into one branch with no conflict.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { check, expect, save } from "./harness.ts";
import { teammate, turn, used } from "./n-common.ts";
import { pool } from "../../src/db.ts";
import { workspaceOf } from "../../src/environment/controller.ts";

const S = "P2W";
const tm = await teammate("vm-git", { tools: ["computer"], connectors: [] });
const ws = workspaceOf(tm);
const git = (...args: string[]) => execFileSync("git", ["-C", ws, ...args], { encoding: "utf8" }).trim();

// A fresh repo with one commit on main.
rmSync(ws, { recursive: true, force: true });
mkdirSync(ws, { recursive: true });
git("init", "-q", "-b", "main");
git("config", "user.name", "Peeblo Check"); git("config", "user.email", "check@peeblo.invalid");
execFileSync("sh", ["-c", "echo '# acme' > README.md"], { cwd: ws });
git("add", "README.md"); git("commit", "-q", "-m", "start");

await check(S, "two parallel sessions commit on their own branches with no conflict", async (c) => {
  const ask = (n: string) => `Your working folder on your computer is a git checkout. Create a file ${n}.txt containing the word ${n}, then commit it with git (message "add ${n}"). Tell me the commit hash.`;
  const [a, b] = await Promise.all([turn(tm, "wt-one", ask("one")), turn(tm, "wt-two", ask("two"))]);
  for (const r of [a, b]) expect(used(r.tools, "computer_bash").some((x) => x.status === "completed"), `no command ran: ${r.tools.map((x: any) => `${x.tool}:${x.status}`).join(", ")}`);
  const branchA = `peeblo/${a.sessionId}`, branchB = `peeblo/${b.sessionId}`;
  const branches = git("branch", "--format=%(refname:short)").split("\n");
  expect(branches.includes(branchA) && branches.includes(branchB), `branches: ${branches.join(", ")}`);
  const filesA = git("diff", "--name-only", "main", branchA), filesB = git("diff", "--name-only", "main", branchB);
  expect(filesA === "one.txt" && filesB === "two.txt", `changed files: ${branchA}: ${filesA || "none"} / ${branchB}: ${filesB || "none"}`);
  expect(git("rev-list", "--count", "main") === "1", "main moved");
  expect(git("status", "--porcelain") === "", `main checkout not clean: ${git("status", "--porcelain")}`);
  git("checkout", "-q", "-b", "check-merge", "main");
  git("merge", "-q", "--no-edit", branchA); git("merge", "-q", "--no-edit", branchB);
  expect(git("ls-files").split("\n").sort().join(",") === "README.md,one.txt,two.txt", "the merge lost a file");
  git("checkout", "-q", "main");
  c.note("branches", [branchA, branchB]);
  c.note("commits", [git("log", "-1", "--format=%h %s", branchA), git("log", "-1", "--format=%h %s", branchB)]);
});

await check(S, "outside a git repo, a session gets a plain folder", async () => {
  const plain = await teammate("vm-check", { tools: ["computer"], connectors: [] });
  const r = await turn(plain, "wt-plain", "On your computer, run pwd and tell me the folder.");
  const { rows } = await pool.query("SELECT count(*) AS n FROM events WHERE session_id = $1 AND type = 'env.worktree'", [r.sessionId]);
  expect(Number(rows[0].n) === 0, "a worktree was attempted outside a repo");
  expect(used(r.tools, "computer_bash").some((x) => x.status === "completed"), "no command ran");
});
await pool.end();
process.exit((await save(S)) ? 0 : 1);
