// A teammate's Slack profile (SLACK_UX_SPEC §3.1): its app manifest, built from its config. Code draws the frame and
// checks the limits; the words (bio, agent description, starter prompts) are the agent's, written at hire and
// approved on the ID card. After any config change the manifest is updated (Slack allows about one update a
// minute, so updates queue). agent_view is Slack's agent messaging model; moving an app to it is one-way.
import { config } from "../config.ts";
import { pool } from "../db.ts";
import { appendEvent, onEvent } from "../store/events.ts";
import { getTeammate, type Teammate } from "../store/teammates.ts";

export const BOT_SCOPES = ["app_mentions:read", "assistant:write", "channels:history", "channels:read", "channels:join", "channels:write.invites", "chat:write", "commands", "files:read", "files:write", "groups:history", "groups:read", "groups:write.invites", "im:history", "im:read", "im:write", "mpim:history", "mpim:read", "mpim:write", "reactions:read", "reactions:write", "users:read", "users:read.email", "links:read", "links:write", "canvases:read", "canvases:write"];
const EVENTS = ["app_mention", "message.channels", "message.groups", "message.im", "message.mpim", "app_home_opened", "member_joined_channel", "agent_session_stopped", "agent_session_title_changed", "app_context_changed"];

const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
// Slack's short description limit counts bytes, so it ends on a word with plain dots, never "…".
const shortCut = (s: string, n: number) => (Buffer.byteLength(s) <= n ? s : `${s.slice(0, n - 3).replace(/\s+\S*$/, "")}...`);

// The owner, as a person. Peeblo's owner is whoever runs this Peeblo (the first admin), never "no owner yet".
async function ownerName(tm: Teammate): Promise<string | null> {
  const p = tm.owner_person
    ? (await pool.query("SELECT display_name FROM people WHERE id = $1", [tm.owner_person])).rows[0]
    : (await pool.query("SELECT display_name FROM people WHERE slack_user = ANY($1) ORDER BY created_at LIMIT 1", [config.admins])).rows[0];
  return p?.display_name ? String(p.display_name).split(" ")[0] : null;
}

const ASKS: Record<string, string> = { ask: "Asks before every write", auto: "Asks before it writes anything that matters", trusted: "Asks before it deletes anything", yolo: "Acts without asking" };

// Three plain facts under the bio (code fills them; the model never writes these numbers).
async function facts(tm: Teammate): Promise<string> {
  const c = tm.config;
  const { readableModel } = await import("./look.ts");
  const owner = await ownerName(tm);
  return [
    `Runs on ${readableModel(c.model.default).name}, an open model · $${c.budget.monthly_usd} a month`,
    ASKS[c.mode] ?? ASKS.auto,
    ...(owner ? [`Looked after by ${owner}`] : []),
  ].join("\n");
}

export async function manifestFor(tm: Teammate, color: string): Promise<Record<string, any>> {
  const c = tm.config;
  const base = config.publicUrl;
  const peeblo = tm.slug === "peeblo";
  const bio = c.profile?.bio?.trim() || `${c.name} is ${c.role.replace(/^./, (x) => x.toLowerCase())}.`;
  // Slack wants at least 175 characters here; a short bio gets one plain line about how it works.
  let long = `${bio}\n\n${await facts(tm)}`;
  if (long.length < 175) long = `${bio}\nIt works on its own computer and keeps a receipt for every reply.\n\n${await facts(tm)}`;
  const short = cut(c.name, 18);
  return {
    display_information: { name: cut(c.name, 35), description: shortCut(c.role, 130), long_description: cut(long, 4000), background_color: color },
    features: {
      app_home: { home_tab_enabled: true, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      // The name people see, never the internal slug (a reused name gets a suffix like "ledger-59o" in the slug only).
      bot_user: { display_name: cut(c.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-"), 80), always_online: true },
      // The agent description replaces Slack's generic assistant text, so it is the agent's own bio.
      agent_view: { agent_description: cut(c.profile?.agent_description?.trim() || bio, 300), suggested_prompts: (c.profile?.starter_prompts ?? []).slice(0, 4) },
      shortcuts: [
        { name: cut(`Ask ${short} about this`, 24), type: "message", callback_id: "ask_about", description: cut(`Ask ${c.name} about this message, in a thread`, 150) },
        { name: cut(`Hand this to ${short}`, 24), type: "message", callback_id: "hand_to", description: cut(`Give ${c.name} this message as a job`, 150) },
        { name: cut(`New job for ${short}`, 24), type: "global", callback_id: "new_job", description: cut(`Describe a job for ${c.name}`, 150) },
      ],
      // Slash commands only on Peeblo's own app, so many teammate apps never clash.
      ...(peeblo ? { slash_commands: [{ command: "/peeblo", url: `${base}/slack/commands`, description: "Your AI crew: crew, hire, budget, settings @teammate", usage_hint: "crew | hire | budget | settings @name", should_escape: true }] } : {}),
    },
    oauth_config: { redirect_urls: [`${base}/slack/oauth/callback`], scopes: { bot: BOT_SCOPES } },
    settings: {
      event_subscriptions: { request_url: `${base}/slack/events`, bot_events: EVENTS },
      interactivity: { is_enabled: true, request_url: `${base}/slack/interactions` },
      org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false,
    },
  };
}

// A teammate's face: its hire's avatar, else the one picked from its slug. The ID card, App Home, the crew
// carousel and the app icon all use this one face.
export async function faceOf(tm: Teammate): Promise<{ shape: string; color: string }> {
  const h = (await pool.query("SELECT avatar FROM hires WHERE teammate_id = $1", [tm.id])).rows[0];
  if (h?.avatar?.shape && h?.avatar?.color) return h.avatar;
  // Peeblo has its own face (the one its app is made with, src/manager.ts).
  if (tm.slug === "peeblo") return { shape: "peeblo", color: "#2E7D5B" };
  const { pickFace } = await import("./idcard.ts");
  return pickFace(tm.slug);
}
async function faceColor(tm: Teammate): Promise<string> { return (await faceOf(tm)).color; }

// One manifest update at a time, a minute apart (apps.manifest.update is rate limited).
let chain: Promise<unknown> = Promise.resolve();
let last = 0;
export function syncManifest(teammateId: string): Promise<{ ok: boolean; error?: string }> {
  const job = chain.then(async () => {
    // No Slack app, nothing to update (and no reason to wait a turn in the queue).
    if (!(await pool.query("SELECT 1 FROM slack_apps WHERE teammate_id = $1 LIMIT 1", [teammateId])).rows.length) return { ok: false, error: "no Slack app" };
    const wait = last + 61_000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    return updateNow(teammateId);
  });
  chain = job.catch(() => {});
  return job;
}

export async function updateNow(teammateId: string): Promise<{ ok: boolean; error?: string }> {
  const tm = await getTeammate(teammateId);
  if (!tm) return { ok: false, error: "no teammate" };
  const apps = (await pool.query("SELECT app_id FROM slack_apps WHERE teammate_id = $1", [tm.id])).rows;
  if (!apps.length) return { ok: false, error: "no Slack app" };
  const { configToken } = await import("./admin.ts");
  const token = await configToken();
  const manifest = await manifestFor(tm, await faceColor(tm));
  for (const a of apps) {
    const r: any = await (await fetch("https://slack.com/api/apps.manifest.update", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: new URLSearchParams({ app_id: a.app_id, manifest: JSON.stringify(manifest) }) })).json();
    await appendEvent({ type: "slack.manifest_updated", data: { teammate_id: tm.id, app_id: a.app_id, ok: r.ok, error: r.error ?? null, errors: r.errors ?? null, needs_reinstall: r.permissions_updated ?? null } });
    if (!r.ok) return { ok: false, error: `${r.error}${r.errors ? ` ${JSON.stringify(r.errors).slice(0, 400)}` : ""}` };
    // The app icon is the same face as the ID card and App Home.
    await setIcon(tm, a.app_id);
  }
  return { ok: true };
}

export async function setIcon(tm: Teammate, appId: string): Promise<boolean> {
  const { configToken } = await import("./admin.ts");
  const { facePng } = await import("./idcard.ts");
  const fd = new FormData();
  fd.append("app_id", appId);
  fd.append("file", new Blob([new Uint8Array(await facePng(await faceOf(tm) as any))], { type: "image/png" }), "face.png");
  const icon: any = await (await fetch("https://slack.com/api/apps.icon.set", { method: "POST", headers: { authorization: `Bearer ${await configToken()}` }, body: fd })).json();
  await appendEvent({ type: "slack.icon_set", data: { teammate_id: tm.id, app_id: appId, ok: icon.ok, error: icon.error ?? null } });
  return Boolean(icon.ok);
}

export function installProfileSync(): void {
  onEvent(async (e) => {
    if (e.type !== "teammate.updated") return;
    const id = String((e.data as any).teammate_id);
    void syncManifest(id).catch((err) => console.error("manifest sync:", (err as Error).message));
  });
}
