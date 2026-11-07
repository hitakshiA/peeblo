// Teammate computers, tiers and images (COMPUTER_SPEC §1–§2), through the environment controller with real VMs.
// - each tier reports its CPUs and memory;
// - the awake cap holds, and the longest-idle computer is the one put to sleep;
// - a new image build doesn't touch a running teammate, which moves to it only at a boot with no other live
//   session; an image no one is pinned to is removed.
process.env.PEEBLO_AWAKE_CAP_SMALL = "2"; // this process only: a small cap to see eviction
import { check, expect, save } from "./harness.ts";
import { ensureTeammate } from "./api.ts";
const { pool } = await import("../../src/db.ts");
const { awake, exec, sleep, sleepAll, TIERS } = await import("../../src/environment/controller.ts");
const { buildImage, buildPath, currentBuild } = await import("../../src/environment/image.ts");
const { getTeammate } = await import("../../src/store/teammates.ts");
const { existsSync } = await import("node:fs");
const { newId } = await import("../../src/ids.ts");

const S = "P2C";
const BASE = { name: "Lark", role: "Checks the teammate computer", tools: ["computer"], connectors: [], budget: { monthly_usd: 2 }, model: { default: "deepseek/deepseek-v4.1-flash-1017", fallback: "xiaomi/mimo-v2.6-pro" } };
const idOf = async (slug: string) => (await getTeammate(slug))!.id;
const booted = async (id: string) => (await pool.query("SELECT data FROM events WHERE type = 'env.booted' AND data->>'teammate_id' = $1 ORDER BY id DESC LIMIT 1", [id])).rows[0]?.data;
const resources = async (id: string) => {
  const r = await exec(id, ["sh", "-c", "nproc; awk '/MemTotal/ {print $2}' /proc/meminfo"]);
  const [cpus, kb] = r.stdout.trim().split("\n").map(Number);
  return { cpus, memMb: Math.round(kb / 1024) };
};
for (const s of ["vm-small", "vm-small-2", "vm-small-3"]) await ensureTeammate(s, { ...BASE, computer: { size: "small", allowed_hosts: [] } });
await ensureTeammate("vm-large", { ...BASE, computer: { size: "large", allowed_hosts: [] } });

await check(S, "each tier gets its CPUs and memory", async (c) => {
  const small = await resources(await idOf("vm-small"));
  const large = await resources(await idOf("vm-large"));
  c.note("small", small); c.note("large", large);
  expect(small.cpus === TIERS.small.cpus && large.cpus === TIERS.large.cpus, `cpus ${small.cpus} / ${large.cpus}`);
  expect(small.memMb > 900 && small.memMb < 1100 && large.memMb > 3800, `memory ${small.memMb} / ${large.memMb} MB`);
  await sleep(await idOf("vm-large"), "check");
});

await check(S, "the awake cap holds and the longest-idle computer sleeps first", async (c) => {
  const [a, b, d] = [await idOf("vm-small"), await idOf("vm-small-2"), await idOf("vm-small-3")];
  await exec(b, ["true"]);      // a (from the last check) is now the longest idle, b the most recent
  await exec(d, ["true"]);      // a third small computer: over the cap of 2
  const up = awake().map((x) => x.teammateId);
  const ev = (await pool.query("SELECT data FROM events WHERE type = 'env.slept' AND data->>'teammate_id' = $1 ORDER BY id DESC LIMIT 1", [a])).rows[0]?.data;
  c.note("awake", up.length); c.note("evicted_reason", ev?.reason);
  expect(up.filter((x) => [a, b, d].includes(x)).length === 2 && !up.includes(a) && up.includes(b) && up.includes(d), `awake: ${up.join(", ")}`);
  expect(ev?.reason === "evicted: awake cap", `vm-small slept for: ${ev?.reason}`);
  await sleepAll();
});

await check(S, "a new image build leaves a running teammate alone; it moves over at a boot with no other live session", async (c) => {
  const id = await idOf("vm-small");
  const old = currentBuild("small")!;
  await exec(id, ["true"]);
  expect((await booted(id)).l0_build_id === old, "not on the current build to start with");
  // Another conversation of this teammate is live while the new image is built.
  const tm = (await getTeammate("vm-small"))!;
  const sess = newId("se"), sub = newId("su"), run = newId("ru");
  await pool.query("INSERT INTO sessions (id, teammate_id, kind, place_key) VALUES ($1, $2, 'api', $3)", [sess, tm.id, `check:image-${Date.now()}`]);
  await pool.query("INSERT INTO submissions (id, session_id, text, request_id, source) VALUES ($1, $2, 'check', $3, 'api')", [sub, sess, `check-${sub}`]);
  await pool.query("INSERT INTO runs (id, session_id, submission_id, status) VALUES ($1, $2, $3, 'waiting')", [run, sess, sub]);
  try {
    const [fresh] = await buildImage("small", { extraPackages: ["tree"] });
    c.note("builds", { old, fresh });
    expect(fresh !== old && currentBuild("small") === fresh, "no new build");
    expect((await exec(id, ["sh", "-c", "echo still-here"])).stdout.trim() === "still-here", "the running computer was disturbed");
    await sleep(id, "check");
    await exec(id, ["true"]);
    expect((await booted(id)).l0_build_id === old, "moved while another session was live");
    await pool.query("UPDATE runs SET status = 'done' WHERE id = $1", [run]);
    await sleep(id, "check");
    await exec(id, ["true"]);
    const b = await booted(id);
    expect(b.l0_build_id === fresh && b.l2_reset_at, `after the boundary: ${JSON.stringify(b)}`);
    await sleepAll();
    // Nothing pinned to the old build now except other check teammates; rebuild the standard image to finish.
    const [back] = await buildImage("small");
    c.note("standard", back);
    for (const s of ["vm-small", "vm-small-2", "vm-small-3"]) { await exec(await idOf(s), ["true"]); }
    await sleepAll();
    const { pruneImages } = await import("../../src/environment/image.ts");
    const removed = await pruneImages("small");
    c.note("pruned", removed);
    expect(existsSync(buildPath("small", back)), "the current build was removed");
  } finally {
    await pool.query("UPDATE runs SET status = 'done' WHERE id = $1", [run]);
  }
});
await sleepAll();
await pool.end();
process.exit((await save(S)) ? 0 : 1);
