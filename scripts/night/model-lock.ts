// The night's model lock (NIGHT_PLAN_NOV9 §2): every role policy serves DeepSeek V4.1 Flash only, with no
// on_failure to another family, and every teammate runs on it with no fallback model.
//   node scripts/night/model-lock.ts
const { pool } = await import("../../src/db.ts");
const { ROLES, pinnedName, waitUntilServing } = await import("../../src/otari/routing.ts");
const { upsertRoutingPolicy } = await import("../../src/otari/admin.ts");
const { listTeammates, updateTeammate } = await import("../../src/store/teammates.ts");

const FLASH = "deepseek/deepseek-v4.1-flash-1017";
for (const name of ["peeblo-manager", "peeblo-worker", "peeblo-reviewer", "peeblo-grader", "peeblo-judge"]) {
  const r = ROLES[name];
  if (r.default !== FLASH || r.fallback.length) throw new Error(`${name} in config/model-tiers.json isn't DeepSeek Flash only`);
  const spec = { select: [{ default: await pinnedName(FLASH) }], on_failure: [] as string[] };
  await upsertRoutingPolicy(name, spec);
  await waitUntilServing(name);
  console.log(name, JSON.stringify(spec));
}
let changed = 0;
for (const t of await listTeammates()) {
  if (t.config.model.default === FLASH && !t.config.model.fallback) continue;
  // An empty fallback drops it (validateConfig keeps only a non-empty one).
  await updateTeammate(t.slug, { model: { default: FLASH, fallback: "" } } as any, { label: "night: DeepSeek Flash only" }, "Nov 9 night: one model, no fallback to other families");
  changed++;
}
console.log(`teammates moved to DeepSeek Flash only: ${changed}`);
await pool.end();
process.exit(0);
