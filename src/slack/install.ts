// "Add to Slack" for a hired teammate's own app: one button wherever the person who asked looks (the ID card, the
// hire thread, Peeblo's App Home), and the switch to that app the moment Slack sends the install back.
import { pool } from "../db.ts";
import { getApp } from "../ingress/apps.ts";
import { appendEvent } from "../store/events.ts";
import { getPerson } from "../store/people.ts";
import { getTeammate, type Teammate } from "../store/teammates.ts";
import { slack } from "./api.ts";

type Msg = { app_id: string; channel: string; ts: string };
const owners = new Map<string, { at: number; ids: string[]; url: string | null }>();

// Workspace Owners review app requests when a workspace requires approved apps. Slack has no API that says whether
// approval is on, so the note is shown whenever the person who asked isn't an Owner.
async function approvalNote(appId: string, slackUser: string | null): Promise<string> {
  let o = owners.get(appId);
  if (!o || Date.now() - o.at > 3_600_000) {
    const ids: string[] = [];
    let cursor = "";
    for (let i = 0; i < 10; i++) {
      const r: any = await slack(appId, "users.list", { limit: 200, ...(cursor ? { cursor } : {}) }).catch(() => null);
      for (const u of r?.members ?? []) if (u.is_owner && !u.deleted && !u.is_bot) ids.push(u.id);
      cursor = r?.response_metadata?.next_cursor ?? "";
      if (!cursor) break;
    }
    const auth: any = await slack(appId, "auth.test", {}).catch(() => null);
    o = { at: Date.now(), ids, url: auth?.url ? `${String(auth.url).replace(/\/$/, "")}/apps/manage` : null };
    owners.set(appId, o);
  }
  if (!o.ids.length || (slackUser && o.ids.includes(slackUser))) return "";
  const who = o.ids
    .slice(0, 3)
    .map((id) => `<@${id}>`)
    .join(", ");
  const where = o.url ? `<${o.url}|Requests to install>` : "Requests to install, in Slack's app management";
  return `If Slack asks you to request it instead, a Workspace Owner approves it (${who}) under ${where}.`;
}

async function installBlocks(tm: Teammate, url: string, peebloApp: string, slackUser: string | null): Promise<any[]> {
  const note = await approvalNote(peebloApp, slackUser);
  return [
    {
      type: "actions",
      block_id: `install:${tm.slug}`,
      elements: [
        {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: `Add ${tm.config.name} to Slack` },
          url,
          action_id: "install",
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `One click: Slack asks you to allow it, then ${tm.config.name} posts as itself, with its own DMs.${note ? ` ${note}` : ""}`,
        },
      ],
    },
  ];
}

// After a hire is created: the ID card it was approved on gets the install button, in place.
export async function offerOnCard(tm: Teammate, runId: string | null, url: string, slackUser: string | null): Promise<void> {
  if (!runId) return;
  const { rows } = await pool.query(
    `SELECT c.data FROM events r JOIN events c ON c.type = 'approval.card' AND c.data->>'approval_id' = r.data->>'approval_id'
      WHERE r.run_id = $1 AND r.type = 'approval.requested' AND r.data->'action'->>'kind' = 'hire' ORDER BY r.id DESC LIMIT 1`,
    [runId],
  );
  const card = rows[0]?.data as (Msg & { image?: string; hero?: string; title?: string; inline?: boolean; thread_ts?: string }) | undefined;
  if (!card) return;
  await postInstall(
    tm,
    { app_id: card.app_id, channel: card.channel, ts: card.ts, inline: Boolean(card.inline), image: card.hero ?? card.image ?? null },
    url,
    slackUser,
  );
}

// The ID card with its install button. A card inside the reply's message (inline) can't carry it, because that
// message is redrawn as the work goes on, so the button gets its own message in the thread.
async function postInstall(
  tm: Teammate,
  card: { app_id: string; channel: string; ts: string; inline: boolean; image: string | null; thread_ts?: string },
  url: string,
  slackUser: string | null,
): Promise<void> {
  const blocks = [
    ...(card.image ? [{ type: "image", image_url: card.image, alt_text: `${tm.config.name}'s ID card` }] : []),
    { type: "section", text: { type: "mrkdwn", text: `*${tm.config.name} is hired.* Add it to Slack so it posts as itself.` } },
    ...(await installBlocks(tm, url, card.app_id, slackUser)),
  ];
  let where = { app_id: card.app_id, channel: card.channel, ts: card.ts, image: card.image };
  if (card.inline) {
    const thread =
      card.thread_ts ??
      (
        await pool.query(
          "SELECT s.place->'slack'->>'thread_ts' AS t FROM hires h JOIN events e ON e.type = 'approval.card' AND e.data->>'ts' = $1 JOIN sessions s ON s.id = e.session_id LIMIT 1",
          [card.ts],
        )
      ).rows[0]?.t ??
      card.ts;
    const r: any = await slack(card.app_id, "chat.postMessage", {
      channel: card.channel,
      thread_ts: thread,
      text: `${tm.config.name} is hired. Add it to Slack:`,
      blocks,
    }).catch(() => null);
    if (r?.ts) where = { ...where, ts: r.ts };
  } else
    await slack(card.app_id, "chat.update", {
      channel: card.channel,
      ts: card.ts,
      text: `${tm.config.name} is hired. Add it to Slack:`,
      blocks,
    }).catch(() => null);
  await pool.query("UPDATE hires SET card = $2 WHERE teammate_id = $1", [tm.id, where]);
}

// The hires still waiting for their install, for Peeblo's App Home (the viewer's own hires; an admin sees all).
export async function waitingInstalls(personId: string | null, all: boolean): Promise<any[]> {
  const { rows } = await pool.query(
    "SELECT h.teammate_id, h.install_url, h.created_at FROM hires h WHERE h.installed_at IS NULL AND h.install_url IS NOT NULL AND ($1 OR h.hired_by = $2) ORDER BY h.created_at DESC LIMIT 10",
    [all, personId],
  );
  const out: any[] = [];
  for (const r of rows) {
    const tm = await getTeammate(r.teammate_id);
    const url = tm ? (await installState(tm.id)).installUrl : null;
    if (tm && url)
      out.push({
        type: "section",
        text: { type: "mrkdwn", text: `*${tm.config.name}* · ${tm.config.role}` },
        accessory: {
          type: "button",
          style: "primary",
          text: { type: "plain_text", text: "Add to Slack" },
          url,
          action_id: `install:${tm.slug}`,
        },
      });
  }
  return out.length ? [{ type: "header", text: { type: "plain_text", text: "Waiting for install" } }, ...out] : [];
}

// The intro card once installed: the ID card as the hero, the app's own face, the name, a
// one-line subtitle (the role, cut at a word, never repeating the body), the agent's bio, and one button: Open home.
// Settings live in App Home for the owner.
export async function hireCard(tm: Teammate, appId: string, team: string, image: string | null): Promise<any> {
  const { config } = await import("../config.ts");
  const go = (extra = "") => `https://slack.com/app_redirect?app=${appId}&team=${team}${extra}`;
  const role = tm.config.role.split(/[:;.(—–]/)[0].trim();
  const subtitle = role.length <= 60 ? role : `${role.slice(0, 60).replace(/\s+\S*$/, "")}…`;
  const bioText = (tm.config.profile?.bio || tm.config.profile?.agent_description || "").trim();
  const bio =
    bioText && !bioText.toLowerCase().startsWith(subtitle.toLowerCase())
      ? bioText
      : bioText.slice(subtitle.length).replace(/^[\s:,.—–-]+/, "");
  return {
    type: "card",
    block_id: `hired:${tm.slug}`,
    ...(image ? { hero_image: { type: "image", image_url: image, alt_text: `${tm.config.name} ID card` } } : {}),
    ...(config.publicUrl
      ? { icon: { type: "image", image_url: `${config.publicUrl}/faces/${tm.slug}.png?v=${tm.version}`, alt_text: tm.config.name } }
      : {}),
    title: { type: "plain_text", text: tm.config.name.slice(0, 150) },
    subtitle: { type: "plain_text", text: subtitle },
    ...(bio ? { body: { type: "mrkdwn", text: fitCard(bio, tm.config.profile?.agent_description) } } : {}),
    actions: [
      { type: "button", style: "primary", text: { type: "plain_text", text: "Open home" }, url: go("&tab=home"), action_id: "open_home" },
    ],
  };
}

// A card body holds about 200 characters: whole sentences that fit, else the one-line description, never a cut word.
function fitCard(bio: string, line?: string): string {
  const MAX = 196;
  if (bio.length <= MAX) return bio;
  let out = "";
  for (const s of bio.match(/[^.!?]+[.!?]+(\s|$)/g) ?? []) {
    if ((out + s).trim().length > MAX) break;
    out += s;
  }
  if (out.trim()) return out.trim();
  if (line && line.length <= MAX) return line;
  return `${bio.slice(0, MAX - 1).replace(/\s+\S*$/, "")}…`;
}

const done = (name: string) => [{ type: "context", elements: [{ type: "mrkdwn", text: `✅ ${name} is in Slack and posts as itself.` }] }];

// Slack sent the install back: the teammate posts as its own app from now on, and says so where it was hired.
export async function switchToOwnApp(appId: string): Promise<void> {
  const app = await getApp(appId);
  if (!app?.teammate_id || !app.secrets.bot_token) return;
  const hire = (await pool.query("SELECT * FROM hires WHERE teammate_id = $1", [app.teammate_id])).rows[0];
  const tm = await getTeammate(app.teammate_id);
  if (!tm) return;
  // Sessions in channels move to the teammate's own app now. A DM with Peeblo stays Peeblo's (only Peeblo can post there).
  await pool.query(
    `UPDATE sessions SET place = jsonb_set(place, '{slack,app_id}', to_jsonb($2::text)) - 'borrowed'
      WHERE teammate_id = $1 AND place->'slack' IS NOT NULL AND place->'slack'->>'channel_type' NOT IN ('im', 'mpim') AND place->'slack'->>'team' = $3`,
    [tm.id, appId, app.team_id],
  );
  if (!hire || hire.installed_at) return;
  await pool.query("UPDATE hires SET installed_at = now() WHERE teammate_id = $1", [tm.id]);
  // The bot user is new at install: set its face again so its first messages don't show Slack's default avatar.
  const { setIcon } = await import("./profile.ts");
  await setIcon(tm, appId).catch((e) => console.error("icon after install:", (e as Error).message));
  // The ID card and Peeblo's "is ready" message lose their button (both are thread replies, rebuilt from what we keep).
  const card = hire.card as (Msg & { image?: string | null }) | null;
  if (card)
    await slack(card.app_id, "chat.update", {
      channel: card.channel,
      ts: card.ts,
      text: `${tm.config.name} is in Slack.`,
      blocks: [await hireCard(tm, appId, app.team_id ?? "", card.image ?? null)],
    }).catch(() => null);
  const hello = hire.hello as Msg | null;
  if (hello)
    await slack(hello.app_id, "chat.update", {
      channel: hello.channel,
      ts: hello.ts,
      text: `${tm.config.name} is installed.`,
      blocks: done(tm.config.name),
    }).catch(() => null);
  const place = hire.place?.slack;
  const hirer = hire.hired_by ? await getPerson(hire.hired_by) : null;
  // It introduces itself in its own words (a first-contact run, src/slack/welcome.ts): in the hire thread when it
  // was hired in a channel it can join, else in its own DM with the person who hired it.
  const { welcomeOnce } = await import("./welcome.ts");
  let posted = false;
  if (place && !["im", "mpim"].includes(place.channel_type)) {
    const joined: any = await slack(appId, "conversations.join", { channel: place.channel }).catch(() => null);
    if (joined?.ok && hirer?.slack_user)
      posted = await welcomeOnce(appId, tm.id, app.team_id ?? "", hirer.slack_user, "installed", {
        channel: place.channel,
        thread_ts: place.thread_ts,
        channel_type: place.channel_type,
      });
  }
  if (!posted && hirer?.slack_user) posted = await welcomeOnce(appId, tm.id, app.team_id ?? "", hirer.slack_user, "installed");
  await appendEvent({ type: "slack.switched", data: { teammate_id: tm.id, app_id: appId, posted_as_self: posted } });
}

// The rail: a teammate works only through its own Slack app. One that has an app (every hire gets one) but hasn't
// been installed doesn't run at all: no replies, jobs, schedules or answers to other teammates. Peeblo never works
// or posts for it. (Teammates made straight through the API, with no Slack app, aren't in Slack at all.)
export async function installState(teammateId: string): Promise<{ waiting: boolean; installUrl: string | null }> {
  const { rows } = await pool.query(
    `SELECT (SELECT install_url FROM hires WHERE teammate_id = $1) AS url, EXISTS (SELECT 1 FROM hires WHERE teammate_id = $1) AS hired,
            array(SELECT app_id FROM slack_apps WHERE teammate_id = $1) AS apps`,
    [teammateId],
  );
  const r = rows[0];
  if (!r.hired && !r.apps.length) return { waiting: false, installUrl: null };
  for (const id of r.apps) if ((await getApp(id))?.secrets.bot_token) return { waiting: false, installUrl: null };
  // A hire whose app is gone has no working link (rehire it, or remove it).
  return { waiting: true, installUrl: r.apps.length ? (r.url ?? null) : null };
}

// Teammates still waiting for "Add to Slack", for ./peeblo check and the console.
export async function waitingTeammates(): Promise<{ slug: string; name: string; since: Date; hasApp: boolean }[]> {
  const { rows } = await pool.query("SELECT h.teammate_id, h.created_at FROM hires h WHERE h.installed_at IS NULL ORDER BY h.created_at");
  const out: { slug: string; name: string; since: Date; hasApp: boolean }[] = [];
  for (const r of rows) {
    const st = await installState(r.teammate_id);
    if (!st.waiting) continue;
    const tm = await getTeammate(r.teammate_id);
    if (tm) out.push({ slug: tm.slug, name: tm.config.name, since: r.created_at, hasApp: Boolean(st.installUrl) });
  }
  return out;
}

// Peeblo's reply when someone wants a teammate that isn't installed: it says so and offers the button again.
export async function offerAgain(
  place: { app_id: string; channel: string; thread_ts: string },
  tm: Teammate,
  slackUser: string | null,
): Promise<boolean> {
  const { installUrl } = await installState(tm.id);
  if (!installUrl) return false;
  const r = await slack(place.app_id, "chat.postMessage", {
    channel: place.channel,
    thread_ts: place.thread_ts,
    text: `${tm.config.name} isn't installed yet. Install it to start working with it.`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `*${tm.config.name} isn't installed yet.* Install it to start working with it.` } },
      ...(await installBlocks(tm, installUrl, place.app_id, slackUser)),
    ],
  }).catch(() => null);
  return Boolean(r);
}
