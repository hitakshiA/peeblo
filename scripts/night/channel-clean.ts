// Lists or removes the dev-era posts in a channel (test data only), so the workspace reads like a real one.
//   node scripts/night/channel-clean.ts list <channel_name>                 → ts, author, app, text start, replies
//   node scripts/night/channel-clean.ts delete <channel_name> <before_ts>   → deletes top-level posts (and their
//       replies) older than before_ts: people's posts with their own user token, app posts with that app's bot token,
//       and anything left (retired apps) with the workspace admin's token.
// Tokens are read here only and never printed.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const users = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "peeblo", "local", "secrets", "slack-users.json"), "utf8")) as Record<string, { name: string; token: string }>;
const admin = users.U0CGL01BU72.token;
const [cmd, name, before] = process.argv.slice(2);

async function call(token: string, method: string, body: Record<string, unknown>): Promise<any> {
  const form = new URLSearchParams(Object.entries(body).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
  const r = await fetch(`https://slack.com/api/${method}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" }, body: form });
  return r.json();
}

const chans: any[] = [];
for (let cursor = ""; ;) {
  const j = await call(admin, "conversations.list", { types: "public_channel", limit: 200, cursor: cursor || undefined, exclude_archived: true });
  chans.push(...(j.channels ?? []));
  cursor = j.response_metadata?.next_cursor ?? "";
  if (!cursor) break;
}
// Known channels by id, so a rate-limited conversations.list doesn't stop the run.
const KNOWN: Record<string, string> = { growth: "C0CFADC9S3H", "all-peeblo-demo": "C0CFA7BUYJ3", "new-channel": "C0CFTFD7VAM" };
const ch = chans.find((c) => c.name === name) ?? (KNOWN[name] ? { name, id: KNOWN[name] } : undefined);
if (!ch) throw new Error(`no channel ${name}`);
const msgs: any[] = [];
for (let cursor = ""; ;) {
  const j = await call(admin, "conversations.history", { channel: ch.id, limit: 200, cursor: cursor || undefined });
  if (!j.ok) throw new Error(`history: ${j.error}`);
  msgs.push(...j.messages);
  cursor = j.response_metadata?.next_cursor ?? "";
  if (!cursor) break;
}
msgs.reverse();

if (cmd === "list") {
  console.log(`${ch.name} ${ch.id}: ${msgs.length} posts`);
  for (const m of msgs) console.log([m.ts, new Date(Number(m.ts) * 1000).toISOString().slice(5, 16), m.user ?? "-", m.app_id ?? m.bot_id ?? "-", m.subtype ?? "", m.reply_count ?? 0, String(m.text ?? "").replace(/\s+/g, " ").slice(0, 90)].join(" | "));
  process.exit(0);
}

if (cmd === "delete") {
  if (!before) throw new Error("say before which ts");
  // The bot token of every Peeblo app, old and new, from core's database (keyed by the bot's user id).
  const { pool } = await import(join(import.meta.dirname, "..", "..", "src", "db.ts"));
  const { getApp } = await import(join(import.meta.dirname, "..", "..", "src", "ingress", "apps.ts"));
  const byBot = new Map<string, string>((await pool.query("SELECT app_id, bot_user_id FROM slack_apps")).rows.map((r: any) => [String(r.bot_user_id), String(r.app_id)]));
  const tokenFor = async (m: any): Promise<string | null> => {
    if (m.user && users[m.user]) return users[m.user].token; // a person's post, even when sent through an app
    const app = m.user ? byBot.get(m.user) : null;
    return app ? ((await getApp(app))?.secrets?.bot_token ?? null) : null;
  };
  let gone = 0, kept = 0;
  for (const m of msgs.filter((x) => Number(x.ts) < Number(before) && x.subtype !== "channel_join")) {
    const thread = m.reply_count ? ((await call(admin, "conversations.replies", { channel: ch.id, ts: m.ts, limit: 200 })).messages ?? []).slice(1) : [];
    for (const x of [...thread.reverse(), m]) {
      const t = await tokenFor(x);
      let r = t ? await call(t, "chat.delete", { channel: ch.id, ts: x.ts }) : { ok: false, error: "no token for its author" };
      // A retired app's token is gone: the workspace admin (Hitakshi) can delete its posts.
      if (!r.ok) r = await call(admin, "chat.delete", { channel: ch.id, ts: x.ts });
      if (r.ok) gone++; else { kept++; console.log(`kept ${x.ts} (${x.user ?? x.app_id ?? x.bot_id}): ${r.error}`); }
    }
  }
  console.log(`${ch.name}: deleted ${gone}, could not delete ${kept}`);
  await pool.end();
  process.exit(0);
}
