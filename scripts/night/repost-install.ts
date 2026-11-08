// Re-posts a hired teammate's ID card and install button in a thread (when an earlier one was lost).
//   node scripts/night/repost-install.ts <slug> <channel> <thread_ts> <asker slack id>
const { pool } = await import("../../src/db.ts");
const { getTeammate } = await import("../../src/store/teammates.ts");
const { installState, postInstall } = await import("../../src/slack/install.ts");
const { config } = await import("../../src/config.ts");
const [slug, channel, thread, asker] = process.argv.slice(2);
const tm = (await getTeammate(slug))!;
const url = (await installState(tm.id)).installUrl;
if (!url) throw new Error(`${slug} has no install link (already installed?)`);
const card = (await pool.query("SELECT card FROM hires WHERE teammate_id = $1", [tm.id])).rows[0]?.card ?? {};
const image = card.image ?? (await pool.query("SELECT e.data->>'hero' AS h, e.data->>'image' AS i FROM events e WHERE e.type = 'approval.card' AND e.data->>'hero' IS NOT NULL ORDER BY e.id DESC LIMIT 1")).rows[0]?.h ?? null;
await postInstall(tm, { app_id: config.managerAppId, channel, ts: thread, inline: true, image, thread_ts: thread }, url, asker);
console.log(`posted ${tm.config.name}'s install button in ${channel} / ${thread}`);
await pool.end(); process.exit(0);
