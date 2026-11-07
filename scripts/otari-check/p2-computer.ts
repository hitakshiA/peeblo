// The teammate's computer: tiers and the build recipe, through the environment controller with real VMs.
// - small and large get different memory and CPU; large boots the browser image and loads one page headless;
// - the recipe installs into the root disk, the package is still there after sleep and wake, and an unchanged
//   recipe doesn't rerun; a changed one does; a command the rule engine refuses stops it.
import { check, expect, save } from "./harness.ts";
import { api, ensureTeammate } from "./api.ts";
import { pool } from "../../src/db.ts";
import { exec, sleep, TIERS } from "../../src/environment/controller.ts";
import { getTeammate } from "../../src/store/teammates.ts";

const S = "P2C";
const BASE = { name: "Lark", role: "Checks the teammate computer", tools: ["computer"], connectors: [], budget: { monthly_usd: 2 }, model: { default: "deepseek/deepseek-v4.1-flash-1017", fallback: "xiaomi/mimo-v2.6-pro" } };
const idOf = async (slug: string) => (await getTeammate(slug))!.id;
const recipeEvents = async (id: string, since: number) =>
  (await pool.query("SELECT data FROM events WHERE type = 'env.recipe' AND data->>'teammate_id' = $1 AND id > $2 ORDER BY id", [id, since])).rows.map((r) => r.data);
const lastEventId = async () => Number((await pool.query("SELECT coalesce(max(id), 0) AS n FROM events")).rows[0].n);
const resources = async (id: string) => {
  const r = await exec(id, ["sh", "-c", "nproc; awk '/MemTotal/ {print $2}' /proc/meminfo"]);
  const [cpus, kb] = r.stdout.trim().split("\n").map(Number);
  return { cpus, memMb: Math.round(kb / 1024) };
};

await check(S, "small and large tiers get their own memory and CPU", async (c) => {
  await ensureTeammate("vm-small", { ...BASE, computer: { size: "small", allowed_hosts: [] } });
  await ensureTeammate("vm-large", { ...BASE, computer: { size: "large", allowed_hosts: [] } });
  const small = await resources(await idOf("vm-small"));
  const large = await resources(await idOf("vm-large"));
  c.note("small", small); c.note("large", large);
  expect(small.cpus === TIERS.small.cpus && large.cpus === TIERS.large.cpus, `cpus ${small.cpus} / ${large.cpus}`);
  expect(small.memMb < 1100 && large.memMb > 3500, `memory ${small.memMb} / ${large.memMb} MB`);
  await sleep(await idOf("vm-small"), "check");
});

await check(S, "a large teammate runs a headless browser on one page", async (c) => {
  const id = await idOf("vm-large");
  const r = await exec(id, ["sh", "-c", "chromium --headless=new --no-sandbox --disable-gpu --dump-dom https://github.com/earendil-works/gondolin 2>/dev/null | grep -o '<title>[^<]*' | head -1"], { timeoutMs: 120_000 });
  c.note("title", r.stdout.trim().slice(7, 90));
  expect(/gondolin/i.test(r.stdout) && !/privacy error/i.test(r.stdout), `page title: ${r.stdout.trim().slice(0, 120)}`);
  const small = await exec(await idOf("vm-small"), ["sh", "-c", "command -v chromium || echo none"]);
  expect(small.stdout.trim() === "none", "the small tier has a browser");
  await sleep(id, "check");
});

await check(S, "the recipe installs once into the disk, stays after sleep and wake, and reruns only when changed", async (c) => {
  const slug = "vm-recipe";
  await ensureTeammate(slug, { ...BASE, computer: { size: "small", allowed_hosts: [], recipe: [] } });
  const id = await idOf(slug);
  await sleep(id, "check");
  await pool.query("DELETE FROM environments WHERE teammate_id = $1", [id]);
  const { rmSync } = await import("node:fs");
  const { diskOf } = await import("../../src/environment/controller.ts");
  rmSync(diskOf(slug, "small"), { force: true }); // start from a fresh disk
  await api("PATCH", `/v1/teammates/${slug}`, { computer: { size: "small", allowed_hosts: [], recipe: ["apk add --no-cache jq"] }, note: "check: recipe" });
  const t0 = await lastEventId();
  const first = await exec(id, ["sh", "-c", "jq --version"]);
  expect(first.exitCode === 0, `jq missing after the recipe: ${first.stderr}`);
  await sleep(id, "check");
  const again = await exec(id, ["sh", "-c", "jq --version"]);
  expect(again.exitCode === 0, "jq gone after sleep and wake");
  await sleep(id, "check");
  const ran = await recipeEvents(id, t0);
  expect(ran.length === 1 && ran[0].ok, `recipe ran ${ran.length} times: ${JSON.stringify(ran.map((x) => x.ok))}`);
  c.note("first_run_ms", ran[0].ms);
  const boots = (await pool.query("SELECT data FROM events WHERE type = 'env.booted' AND data->>'teammate_id' = $1 AND id > $2 ORDER BY id", [id, t0])).rows.map((r) => r.data.resumed);
  expect(boots.length === 2 && boots[1] === true, `boots (resumed?): ${JSON.stringify(boots)}`);
  // A changed recipe runs again on the next boot.
  await api("PATCH", `/v1/teammates/${slug}`, { computer: { size: "small", allowed_hosts: [], recipe: ["apk add --no-cache jq", "apk add --no-cache tree"] }, note: "check: recipe change" });
  const t1 = await lastEventId();
  const tree = await exec(id, ["sh", "-c", "tree --version && jq --version"]);
  expect(tree.exitCode === 0, `tree missing after the recipe change: ${tree.stderr}`);
  expect((await recipeEvents(id, t1)).length === 1, "the changed recipe didn't run once");
  await sleep(id, "check");
});

await check(S, "a recipe command the rule engine refuses stops the recipe", async (c) => {
  const slug = "vm-recipe";
  const id = await idOf(slug);
  await api("PATCH", `/v1/teammates/${slug}`, { computer: { size: "small", allowed_hosts: [], recipe: ["git push --force origin main", "apk add --no-cache htop"] }, note: "check: refused recipe" });
  const t0 = await lastEventId();
  const r = await exec(id, ["sh", "-c", "command -v htop || echo none"]);
  const ev = await recipeEvents(id, t0);
  expect(ev.length === 1 && ev[0].ok === false && ev[0].refused, `recipe events: ${JSON.stringify(ev)}`);
  expect(r.stdout.trim() === "none", "the step after the refused one ran");
  c.note("refused", ev[0].refused.reason);
  await api("PATCH", `/v1/teammates/${slug}`, { computer: { size: "small", allowed_hosts: [], recipe: [] }, note: "check: reset" });
  await sleep(id, "check");
});
await pool.end();
process.exit((await save(S)) ? 0 : 1);
