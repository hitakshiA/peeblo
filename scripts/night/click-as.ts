// A signed replay of one button click as Maya or Jun (the browser is signed in only as Hitakshi). It reads the real
// message through that person's own Slack token, finds the button by its label, builds the block_actions payload
// Slack would send (that user, the real message, its action_id, value and block_id), signs it with the message's
// app signing secret, and POSTs it to Peeblo's interactivity endpoint on the public (zrok) URL.
// Every use is a "signed replay", not a real click; say so in PROGRESS.
//   node scripts/night/click-as.ts <maya|jun|hitakshi> <channel> <thread_ts> "<button label>" [message_ts]
//   node scripts/night/click-as.ts --selftest <maya|jun>     (a no-op action, to check the signature path)
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const { config } = await import("../../src/config.ts");
const { pool } = await import("../../src/db.ts");
const { getApp } = await import("../../src/ingress/apps.ts");

const users = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "peeblo", "local", "secrets", "slack-users.json"), "utf8")) as Record<string, { name: string; token: string }>;
const pick = (who: string) => {
  const e = Object.entries(users).find(([, u]) => u.name.toLowerCase().startsWith(who.toLowerCase()));
  if (!e) throw new Error(`no test person ${who}`);
  return { id: e[0], ...e[1] };
};
const api = async (token: string, method: string, body: Record<string, string>) => (await (await fetch(`https://slack.com/api/${method}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) })).json()) as any;

// Every button in a message, wherever Block Kit puts it (actions, card, section accessory, context_actions).
function buttons(blocks: any[]): { block_id: string; el: any }[] {
  const out: { block_id: string; el: any }[] = [];
  for (const b of blocks ?? []) {
    const els = [...(b.elements ?? []), ...(b.actions ?? []), ...(b.accessory ? [b.accessory] : [])];
    for (const el of els) if (el?.type === "button" || el?.type === "feedback_buttons") out.push({ block_id: b.block_id, el });
  }
  return out;
}

async function send(appId: string, payload: any): Promise<string> {
  const app = await getApp(appId);
  if (!app) throw new Error(`Peeblo doesn't know the app ${appId}`);
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `v0=${createHmac("sha256", app.secrets.signing_secret).update(`v0:${ts}:${body}`).digest("hex")}`;
  const r = await fetch(`${config.publicUrl}/slack/interactions`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": ts, "x-slack-signature": sig }, body });
  return `${r.status} ${(await r.text()).slice(0, 120)}`;
}

const args = process.argv.slice(2);
if (args[0] === "--selftest") {
  const u = pick(args[1] ?? "jun");
  const appId = config.managerAppId;
  const app = await getApp(appId);
  const payload = { type: "block_actions", user: { id: u.id, username: u.name, team_id: app!.team_id }, api_app_id: appId, team: { id: app!.team_id }, trigger_id: `replay.${randomBytes(6).toString("hex")}`,
    actions: [{ type: "button", action_id: "noop_selftest", block_id: "selftest", value: "x", action_ts: String(Date.now() / 1000) }] };
  console.log(`selftest as ${u.name}: ${await send(appId, payload)}`);
  const ev = (await pool.query("SELECT data FROM events WHERE type = 'slack.interaction' AND data->>'action' = 'noop_selftest' ORDER BY id DESC LIMIT 1")).rows[0]?.data;
  console.log(ev ? `recorded: user ${ev.user}, app ${ev.app_id}` : "not recorded");
} else {
  const [who, channel, thread, label, messageTs] = args;
  if (!who || !channel || !thread || !label) throw new Error("usage: click-as.ts <person> <channel> <thread_ts> \"<button label>\" [message_ts]");
  const u = pick(who);
  const msgs = ((await api(u.token, "conversations.replies", { channel, ts: thread, limit: "200" })).messages ?? []) as any[];
  const candidates = msgs.filter((m) => !messageTs || m.ts === messageTs).reverse();
  let hit: { m: any; b: { block_id: string; el: any } } | null = null;
  for (const m of candidates) {
    const b = buttons(m.blocks).find((x) => (x.el.text?.text ?? "").toLowerCase() === label.toLowerCase() || x.el.action_id === label);
    if (b) { hit = { m, b }; break; }
  }
  if (!hit) throw new Error(`no button "${label}" in that thread`);
  const { m, b } = hit;
  const app = await getApp(m.app_id);
  const action = { type: "button", action_id: b.el.action_id, block_id: b.block_id, value: b.el.value, text: b.el.text, action_ts: String(Date.now() / 1000) };
  const payload = {
    type: "block_actions", user: { id: u.id, username: u.name, team_id: app?.team_id }, api_app_id: m.app_id, team: { id: app?.team_id },
    container: { type: "message", message_ts: m.ts, channel_id: channel, is_ephemeral: false, thread_ts: thread }, channel: { id: channel },
    message: { ts: m.ts, text: m.text, blocks: m.blocks, thread_ts: thread, app_id: m.app_id },
    trigger_id: `replay.${randomBytes(6).toString("hex")}`, response_url: `${config.publicUrl}/replay/none`, actions: [action],
  };
  console.log(`signed replay as ${u.name}: "${label}" (${b.el.action_id}) on ${m.ts} → ${await send(m.app_id, payload)}`);
}
await pool.end();
process.exit(0);
