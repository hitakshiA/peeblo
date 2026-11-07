// Build recipes (COMPUTER_SPEC §4), with real build VMs:
// - a recipe builds once in a separate VM and the package is there after sleep and wake; the same hash builds nothing;
// - a failing step leaves the active build untouched;
// - a changed recipe is adopted only after the live session ends;
// - a secret placeholder written to ~/.npmrc works after sleep and wake, and the real value is nowhere in the guest;
// - recipe_propose from a real turn runs a trial build and creates one owner approval.
import { execSync } from "node:child_process";
import { check, expect, save } from "./harness.ts";
import { api, answer, ensureTeammate, OWNER } from "./api.ts";
import { turn, used } from "./n-common.ts";
const { pool } = await import("../../src/db.ts");
const { exec, sleep, sleepAll } = await import("../../src/environment/controller.ts");
const { queueBuild, waitForBuild } = await import("../../src/environment/recipes.ts");
const { getTeammate } = await import("../../src/store/teammates.ts");
const { newId } = await import("../../src/ids.ts");

const S = "P2R";
const slug = "vm-recipe";
const BASE = { name: "Lark", role: "Checks recipes", tools: ["computer"], connectors: [], budget: { monthly_usd: 2 }, model: { default: "deepseek/deepseek-v4.1-flash-1017", fallback: "xiaomi/mimo-v2.6-pro" }, mode: "auto" };
const setRecipe = (recipe: unknown) => api("PATCH", `/v1/teammates/${slug}`, { computer: { size: "small", allowed_hosts: [], recipe }, note: "check" });
await ensureTeammate(slug, { ...BASE, computer: { size: "small", allowed_hosts: [], recipe: {} } });
const tm0 = (await getTeammate(slug))!;
const id = tm0.id;
const owner = (await pool.query("SELECT id FROM people WHERE slack_user = $1", [OWNER.slack_user])).rows[0]?.id;
await pool.query("UPDATE teammates SET owner_person = $2 WHERE id = $1", [id, owner]);
const builds = async (since: Date) => (await pool.query("SELECT id, status, purpose, hash FROM recipe_builds WHERE teammate_id = $1 AND created_at > $2 ORDER BY created_at", [id, since])).rows;
const lastBoot = async () => (await pool.query("SELECT data FROM events WHERE type = 'env.booted' AND data->>'teammate_id' = $1 ORDER BY id DESC LIMIT 1", [id])).rows[0]?.data;
const settled = async () => { for (let i = 0; i < 300; i++) { const b = (await pool.query("SELECT count(*)::int AS n FROM recipe_builds WHERE teammate_id = $1 AND status IN ('queued', 'building')", [id])).rows[0].n; if (!b) return; await new Promise((r) => setTimeout(r, 1000)); } };
await sleepAll();

await check(S, "a recipe builds once in its own VM, and the package is there after sleep and wake", async (c) => {
  const t0 = new Date();
  await setRecipe({ packages: { apk: ["jq"] }, verify: ["jq --version"] }); // core queues the build
  await settled();
  const first = await builds(t0);
  expect(first.length === 1 && first[0].status === "built", `builds: ${JSON.stringify(first)}`);
  await exec(id, ["true"]);
  expect((await lastBoot()).l1_build_id === first[0].id, "the teammate didn't start from the built recipe");
  await sleep(id, "check");
  const after = await exec(id, ["sh", "-c", "jq --version"]);
  expect(after.exitCode === 0, "jq gone after sleep and wake");
  await sleep(id, "check");
  // The same recipe again (a no-op config change): no build.
  await setRecipe({ packages: { apk: ["jq"] }, verify: ["jq --version"] });
  await settled();
  expect((await builds(t0)).length === 1, "a same-hash change started a build");
  c.note("build", first[0].id);
});

await check(S, "a failing step leaves the active build untouched", async (c) => {
  const t0 = new Date();
  await setRecipe({ packages: { apk: ["jq"] }, run: [{ name: "breaks", run: "exit 3" }], verify: ["jq --version"] });
  await settled();
  const b = await builds(t0);
  const active = (await pool.query("SELECT id FROM recipe_builds WHERE teammate_id = $1 AND status = 'active'", [id])).rows;
  expect(b.length === 1 && b[0].status === "failed", `builds: ${JSON.stringify(b)}`);
  const step = (await pool.query("SELECT data FROM events WHERE type = 'env.build.failed' AND data->>'build_id' = $1", [b[0].id])).rows[0]?.data;
  expect(step?.step === "breaks", `failed step: ${step?.step}`);
  expect(active.length === 1, "the active build changed");
  const r = await exec(id, ["sh", "-c", "jq --version"]);
  expect(r.exitCode === 0, "the computer lost its working setup");
  await sleep(id, "check");
  c.note("failed_build", b[0].id);
});

await check(S, "a changed recipe is adopted only after the live session ends", async (c) => {
  const t0 = new Date();
  await setRecipe({ packages: { apk: ["jq", "tree"] }, verify: ["jq --version", "tree --version"] });
  await settled();
  const built = (await builds(t0)).find((x) => x.status === "built");
  expect(built, "the new recipe didn't build");
  const sess = newId("se"), sub = newId("su"), run = newId("ru");
  await pool.query("INSERT INTO sessions (id, teammate_id, kind, place_key) VALUES ($1, $2, 'api', $3)", [sess, id, `check:adopt-${Date.now()}`]);
  await pool.query("INSERT INTO submissions (id, session_id, text, request_id, source) VALUES ($1, $2, 'check', $3, 'api')", [sub, sess, `check-${sub}`]);
  await pool.query("INSERT INTO runs (id, session_id, submission_id, status) VALUES ($1, $2, $3, 'running')", [run, sess, sub]);
  try {
    await exec(id, ["true"]);
    expect((await lastBoot()).l1_build_id !== built!.id, "adopted while a session was live");
    await sleep(id, "check");
    await pool.query("UPDATE runs SET status = 'done' WHERE id = $1", [run]);
    const r = await exec(id, ["sh", "-c", "tree --version"]);
    expect((await lastBoot()).l1_build_id === built!.id && r.exitCode === 0, "not adopted after the session ended");
    await sleep(id, "check");
  } finally { await pool.query("UPDATE runs SET status = 'done' WHERE id = $1", [run]); }
});

await check(S, "a secret placeholder in ~/.npmrc works after sleep and wake; the real value is nowhere in the guest", async (c) => {
  const real = execSync("gh auth token").toString().trim();
  await api("PUT", `/v1/teammates/${slug}/secrets/GH_TOKEN`, { value: real, hosts: ["api.github.com"] });
  const t0 = new Date();
  await setRecipe({ packages: { apk: ["jq"] }, files: [{ path: "/root/.ghrc", content: "token=${secret:GH_TOKEN}\n", mode: "0600" }], secrets: ["GH_TOKEN"], verify: ["grep -q '^token=peeblo-secret-' /root/.ghrc"] });
  await settled();
  const b = (await builds(t0)).at(-1);
  expect(b?.status === "built", `build: ${JSON.stringify(b)}`);
  await exec(id, ["true"]);
  await sleep(id, "check");
  const use = await exec(id, ["sh", "-c", "t=$(sed -n 's/^token=//p' /root/.ghrc); curl -s -o /dev/null -w '%{http_code}' -H \"Authorization: Bearer $t\" https://api.github.com/user"]);
  expect(use.stdout.trim() === "200", `GitHub answered ${use.stdout.trim()} with the placeholder`);
  const scan = await exec(id, ["sh", "-c", `grep -rlsF ${JSON.stringify(real.slice(4, 20))} /root /etc /tmp /var /usr/local /workspace 2>/dev/null | head -3; echo done`], { timeoutMs: 120_000 });
  expect(scan.stdout.trim() === "done", `the real value was found in: ${scan.stdout}`);
  await sleep(id, "check");
  c.note("github_status", use.stdout.trim());
});

await check(S, "recipe_propose from a real turn trial-builds and asks the owner once", async (c) => {
  const t0 = new Date();
  const r = await turn(slug, "propose", "Make the sqlite3 command-line tool part of your computer's permanent setup (it's the apk package sqlite). Verify it with sqlite3 --version.", { answer: "approved", answerAs: owner });
  const p = used(r.tools, "recipe_propose");
  const trial = (await builds(t0)).filter((x) => x.purpose === "trial");
  const asks = r.events.filter((e: any) => e.type === "approval.requested" && e.data.action?.kind === "recipe_change");
  c.note("tools", r.tools.map((x: any) => `${x.tool}:${x.status}`));
  expect(p.some((x) => x.status === "completed"), `recipe_propose: ${JSON.stringify(p.map((x) => [x.status, x.error]))}`);
  expect(trial.length >= 1 && trial.some((x) => ["built", "active"].includes(x.status)), `trial builds: ${JSON.stringify(trial)}`);
  expect(asks.length === 1 && asks[0].data.action.approvers?.[0] === owner, `owner approvals: ${asks.length}`);
  const cfg = (await getTeammate(slug))!.config.computer.recipe as any;
  expect(cfg.packages.apk.some((x: string) => /^sqlite/.test(x)), `recipe after approval: ${JSON.stringify(cfg.packages)}`);
  c.note("answer", answer(r.events).slice(0, 160));
});
await setRecipe({});
await sleepAll();
await pool.end();
process.exit((await save(S)) ? 0 : 1);
