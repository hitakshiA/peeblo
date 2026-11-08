// Set a teammate's approval mode (a test helper): node scripts/night/set-mode.ts <slug> <ask|auto|trusted|yolo>
const { updateTeammate } = await import("../../src/store/teammates.ts");
const { pool } = await import("../../src/db.ts");
const [slug, mode] = process.argv.slice(2);
const t = await updateTeammate(slug, { mode } as any, { label: "night test" }, `mode ${mode} for a UI check`);
console.log(t.slug, t.config.mode, "v" + t.version);
await pool.end();
process.exit(0);
