// The clean start before the one-week story (NIGHT_PLAN_NOV9 §4.0). Archives, never deletes:
// - every dev teammate goes through the normal fire path (src/retire.ts: Otari key, ceiling and budget removed,
//   Slack app uninstalled, schedules off, sessions closed, record archived);
// - Peeblo starts fresh: its test schedules off, test grants removed, sessions closed, its memory and the person
//   cards moved to an archive folder (company memory, which an admin approved, stays);
// - channel settings reset to the default (answer when mentioned);
// - the test messages in Peeblo's DMs with Hitakshi, Maya and Jun are removed (Peeblo's own with its bot token, the
//   people's own with their test tokens), so Day 1 opens on a clean DM.
// Prints the Otari keys before and after (names only).
//   node scripts/night/clean-start.ts [--dry]
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const dry = process.argv.includes("--dry");
const { pool } = await import("../../src/db.ts");
const { config } = await import("../../src/config.ts");
const { admin } = await import("../../src/otari/admin.ts");
const { listTeammates } = await import("../../src/store/teammates.ts");
const { retireTeammate } = await import("../../src/retire.ts");
const { slack } = await import("../../src/slack/api.ts");

const keyNames = async () => {
  const k = await admin("GET", "/organizations/me/keys", undefined, "listing keys", "");
  return ((k.data ?? k) as any[]).filter((x) => !x.revoked_at && x.is_active !== false).map((x) => x.key_name ?? x.name ?? x.id);
};
const before = await keyNames();
console.log(`Otari keys before: ${before.length}`);

// 1. Retire every teammate but Peeblo.
const crew = (await listTeammates()).filter((t) => t.slug !== "peeblo");
console.log(`retiring ${crew.length} teammates${dry ? " (dry run)" : ""}`);
let failed = 0;
for (const t of crew) {
  if (dry) { console.log(`  would retire ${t.slug}`); continue; }
  try {
    const r = await retireTeammate(t.id, { personId: null, label: "clean start before the Day 1 story" });
    console.log(`  ${t.slug}: ${r.steps.join("; ")}`);
  } catch (e) { failed++; console.log(`  ${t.slug}: FAILED ${(e as Error).message.slice(0, 160)}`); }
}

if (!dry) {
  // 2. Peeblo fresh.
  const peeblo = (await pool.query("SELECT id FROM teammates WHERE slug = 'peeblo'")).rows[0].id;
  console.log(`schedules off: ${(await pool.query("UPDATE schedules SET enabled = false WHERE enabled RETURNING id")).rowCount}`);
  console.log(`grants removed: ${(await pool.query("DELETE FROM grants WHERE teammate_id = $1 RETURNING id", [peeblo])).rowCount}`);
  console.log(`Peeblo sessions closed: ${(await pool.query("UPDATE sessions SET status = 'closed' WHERE teammate_id = $1 AND status = 'open' RETURNING id", [peeblo])).rowCount}`);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  for (const dir of [join(config.dataDir, "teammates", "peeblo", "memory"), join(config.dataDir, "people-cards"), join(config.dataDir, "teammates", "peeblo", "memory-vectors.json")]) {
    if (existsSync(dir)) { renameSync(dir, `${dir}.archive-${stamp}`); console.log(`archived ${dir.split("/").slice(-2).join("/")}`); }
  }
  console.log(`channel settings reset: ${(await pool.query("DELETE FROM channel_settings RETURNING channel")).rowCount}`);
  const { syncSchedules } = await import("../../src/durable/schedules.ts");
  await syncSchedules().catch(() => null);

  // 3. Clean DMs with Peeblo.
  const users = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "peeblo", "local", "secrets", "slack-users.json"), "utf8")) as Record<string, { name: string; token: string }>;
  const peebloApp = config.managerAppId;
  const bot = (await pool.query("SELECT bot_user_id FROM slack_apps WHERE app_id = $1", [peebloApp])).rows[0]?.bot_user_id;
  const as = async (token: string, method: string, body: Record<string, string>) => (await (await fetch(`https://slack.com/api/${method}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) })).json()) as any;
  for (const [uid, u] of Object.entries(users)) {
    const dm = await as(u.token, "conversations.open", { users: bot });
    const ch = dm.channel?.id;
    if (!ch) { console.log(`  ${u.name}: no DM (${dm.error})`); continue; }
    let removed = 0, cursor = "";
    for (let page = 0; page < 20; page++) {
      const h = await as(u.token, "conversations.history", { channel: ch, limit: "200", ...(cursor ? { cursor } : {}) });
      for (const m of h.messages ?? []) {
        const replies = m.reply_count ? ((await as(u.token, "conversations.replies", { channel: ch, ts: m.ts, limit: "200" })).messages ?? []).slice(1) : [];
        for (const x of [...replies, m]) {
          const r = x.user === uid ? await as(u.token, "chat.delete", { channel: ch, ts: x.ts }) : x.app_id === peebloApp || x.bot_id ? await slack(peebloApp!, "chat.delete", { channel: ch, ts: x.ts }).catch((e: any) => ({ ok: false, error: e.message })) : { ok: false };
          if ((r as any).ok) removed++;
        }
      }
      cursor = h.response_metadata?.next_cursor ?? "";
      if (!cursor) break;
    }
    console.log(`  ${u.name}: ${removed} test messages removed from the DM with Peeblo`);
  }
}

const after = await keyNames();
console.log(`Otari keys after: ${after.length}: ${after.join(", ")}`);
console.log(failed ? `${failed} retirements failed` : "clean start done");
await pool.end();
process.exit(0);
