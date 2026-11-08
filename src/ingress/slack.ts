// The public ingress: the only paths reachable from the internet. One endpoint serves every Slack app:
// route by api_app_id, verify with that app's own signing secret, and claim (team, channel, ts) so one
// human message is handled once even when five apps receive it. Everything else answers 404.
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { config } from "../config.ts";
import { pool } from "../db.ts";
import { appendEvent } from "../store/events.ts";
import { getApp, saveApp } from "./apps.ts";

export function verifySlack(secret: string, ts: string | undefined, body: string, sig: string | undefined, now = Date.now()): boolean {
  if (!ts || !sig || Math.abs(now / 1000 - Number(ts)) > 300) return false;
  const mine = "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
  return mine.length === sig.length && timingSafeEqual(Buffer.from(mine), Buffer.from(sig));
}

async function rawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 2_000_000) throw new Error("too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// The first delivery of a message to an app wins; returns false for every later delivery of it to the same app.
export async function claimMessage(teamId: string, channel: string, ts: string, appId: string, eventType: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    "INSERT INTO slack_claims (team_id, channel, ts, app_id, event_type) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
    [teamId, channel, ts, appId, eventType],
  );
  return rowCount === 1;
}

type Handler = (e: { appId: string; teammateId: string | null; teamId: string; event: any; payload: any }) => Promise<void>;
const handlers: Handler[] = [];
type InteractionHandler = (e: { appId: string; teammateId: string | null; payload: any }) => Promise<void>;
const interactionHandlers: InteractionHandler[] = [];
export const onSlackInteraction = (h: InteractionHandler) => void interactionHandlers.push(h);
type EventHandler = (e: { appId: string; teammateId: string | null; teamId: string; event: any }) => Promise<void>;
const otherHandlers: EventHandler[] = [];
export const onSlackEvent = (h: EventHandler) => void otherHandlers.push(h);

export function onSlackMessage(h: Handler): void {
  handlers.push(h);
}

async function handleEvents(body: string, req: IncomingMessage): Promise<[number, string]> {
  let payload: any;
  try { payload = JSON.parse(body); } catch { return [400, "bad body"]; }
  // Slack checks a new request URL before we could know the new app's secret, and this ping carries no app id.
  if (payload.type === "url_verification") return [200, String(payload.challenge ?? "")];
  const app = await getApp(String(payload.api_app_id ?? ""));
  if (!app || !verifySlack(app.secrets.signing_secret, req.headers["x-slack-request-timestamp"] as string, body, req.headers["x-slack-signature"] as string)) return [401, "bad signature"];
  const ev = payload.event ?? {};
  if (ev.user && ev.user === app.bot_user_id) return [200, ""];
  if (ev.type === "message" || ev.type === "app_mention") {
    if (ev.user === app.bot_user_id) return [200, ""];                       // our own post echoed back
    const first = await claimMessage(payload.team_id, ev.channel, ev.ts ?? ev.event_ts, app.app_id, ev.type);
    if (!first) return [200, ""];
    await appendEvent({ type: "slack.message", data: { app_id: app.app_id, team_id: payload.team_id, event_id: payload.event_id, event: ev } });
    for (const h of handlers) await h({ appId: app.app_id, teammateId: app.teammate_id, teamId: payload.team_id, event: ev, payload }).catch((e) => console.error("slack handler:", e));
    return [200, ""];
  }
  await appendEvent({ type: `slack.${ev.type ?? payload.type}`, data: { app_id: app.app_id, team_id: payload.team_id, event_id: payload.event_id, event: ev } });
  for (const h of otherHandlers) void h({ appId: app.app_id, teammateId: app.teammate_id, teamId: payload.team_id, event: ev }).catch((e) => console.error("slack event:", e));
  return [200, ""];
}

async function handleInteraction(body: string, req: IncomingMessage): Promise<[number, string]> {
  let payload: any;
  try { payload = JSON.parse(new URLSearchParams(body).get("payload") ?? ""); } catch { return [400, "bad body"]; }
  let app = await getApp(String(payload.api_app_id ?? payload.view?.app_id ?? ""));
  // Some payloads (message shortcuts) can arrive without the app id: the app is the one whose secret signed it.
  if (!app) {
    const { listApps } = await import("./apps.ts");
    for (const a of await listApps()) {
      const full = await getApp(a.app_id);
      if (full && verifySlack(full.secrets.signing_secret, req.headers["x-slack-request-timestamp"] as string, body, req.headers["x-slack-signature"] as string)) { app = full; break; }
    }
  }
  if (!app || !verifySlack(app.secrets.signing_secret, req.headers["x-slack-request-timestamp"] as string, body, req.headers["x-slack-signature"] as string)) { console.error(`slack interaction refused: type ${payload.type}, app ${payload.api_app_id ?? "none"}`); return [401, "bad signature"]; }
  await appendEvent({ type: "slack.interaction", data: { app_id: app.app_id, type: payload.type, user: payload.user?.id, action: payload.actions?.[0]?.action_id, value: payload.actions?.[0]?.value, callback: payload.view?.callback_id } });
  const { handleShortcut, handleSubmission } = await import("../slack/commands.ts");
  // Shortcuts (on a message, or anywhere): answered at once, the work happens after.
  if (payload.type === "message_action" || payload.type === "shortcut") { void handleShortcut(app.app_id, payload).catch((e) => console.error("slack shortcut:", e)); return [200, ""]; }
  // Forms: a settings save answers with field errors, so it's checked before replying.
  if (payload.type === "view_submission" && ["teammate_settings", "new_job", "hire_form"].includes(payload.view?.callback_id)) {
    const errors = await handleSubmission(app.app_id, payload).catch((e) => ({ instructions: String((e as Error).message).slice(0, 150) }));
    return [200, errors ? JSON.stringify({ response_action: "errors", errors }) : ""];
  }
  // Answered at once (Slack wants a reply within 3 s); the work happens after.
  for (const h of interactionHandlers) void h({ appId: app.app_id, teammateId: app.teammate_id, payload }).catch((e) => console.error("slack interaction:", e));
  return [200, ""];
}

// /peeblo on Peeblo's own app: verified with its signing secret, acknowledged at once, answered through response_url.
async function handleCommand(body: string, req: IncomingMessage): Promise<[number, string]> {
  const f = new URLSearchParams(body);
  const app = await getApp(String(f.get("api_app_id") ?? ""));
  if (!app || !verifySlack(app.secrets.signing_secret, req.headers["x-slack-request-timestamp"] as string, body, req.headers["x-slack-signature"] as string)) return [401, "bad signature"];
  await appendEvent({ type: "slack.command", data: { app_id: app.app_id, user: f.get("user_id"), command: f.get("command"), text: f.get("text") } });
  const { handleCommand: run } = await import("../slack/commands.ts");
  void run(f).catch((e) => console.error("slack command:", e));
  return [200, ""];
}

// One-click install: Slack sends the person back here with a code; we trade it for the bot token.
async function handleOAuth(url: URL): Promise<[number, string]> {
  const code = url.searchParams.get("code");
  const appId = (url.searchParams.get("state") ?? "").replace(/^install:/, "");
  const app = await getApp(appId);
  if (!code || !app) return [400, page("That install link is not valid any more. Ask Peeblo for a new one.")];
  const r = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { authorization: "Basic " + Buffer.from(`${app.secrets.client_id}:${app.secrets.client_secret}`).toString("base64") },
    body: new URLSearchParams({ code, redirect_uri: `${config.publicUrl}/slack/oauth/callback` }),
  }).then((x) => x.json() as Promise<any>);
  if (!r.ok) return [400, page(`Slack said: ${r.error}. Try the link again.`)];
  await saveApp({ app_id: app.app_id, teammate_id: app.teammate_id, team_id: r.team?.id, bot_user_id: r.bot_user_id, secrets: { ...app.secrets, bot_token: r.access_token } });
  await appendEvent({ type: "slack.installed", data: { app_id: app.app_id, team_id: r.team?.id, bot_user_id: r.bot_user_id, installed_by: r.authed_user?.id } });
  // Straight into Slack, on the new teammate's own Messages tab (its welcome is there).
  return [302, `https://slack.com/app_redirect?app=${encodeURIComponent(app.app_id)}&team=${encodeURIComponent(r.team?.id ?? "")}`];
}

async function facePngFor(slug: string): Promise<Buffer | null> {
  // The same face as the app icon and the ID card (src/slack/profile.ts faceOf).
  const { getTeammate } = await import("../store/teammates.ts");
  const tm = await getTeammate(slug);
  const { facePng, pickFace } = await import("../slack/idcard.ts");
  const { faceOf } = await import("../slack/profile.ts");
  return facePng((tm ? await faceOf(tm) : pickFace(slug)) as any, 256).catch(() => null);
}

const page = (text: string) => `<!doctype html><meta charset="utf-8"><title>Peeblo</title><body style="font:16px system-ui;padding:3rem"><p>${text.replace(/</g, "&lt;")}</p>`;

export function startIngress(): Promise<Server> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://ingress");
    try {
      let out: [number, string] = [404, "not found"];
      let type = "text/plain";
      if (req.method === "POST" && url.pathname === "/slack/events") out = await handleEvents(await rawBody(req), req);
      else if (req.method === "POST" && url.pathname === "/slack/interactions") { out = await handleInteraction(await rawBody(req), req); if (out[1].startsWith("{")) type = "application/json"; }
      else if (req.method === "POST" && url.pathname === "/slack/commands") out = await handleCommand(await rawBody(req), req);
      else if (req.method === "GET" && url.pathname === "/slack/oauth/callback") { out = await handleOAuth(url); type = "text/html"; }
      else if (req.method === "POST" && /^\/hooks\/[a-z0-9-]{2,31}\/sc_[a-z0-9]+$/.test(url.pathname)) {
        const [, , slug, id] = url.pathname.split("/");
        const { handleHook } = await import("../triggers.ts");
        out = await handleHook(slug, id, req.headers, await rawBody(req));
      }
      else if (req.method === "GET" && /^\/cards\/[0-9a-f]{32}\.png$/.test(url.pathname)) {
        const { readFile } = await import("node:fs/promises");
        const png = await readFile(`${config.dataDir}/cards/${url.pathname.slice(7)}`).catch(() => null);
        if (png) return void res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" }).end(png);
      }
      else if (req.method === "GET" && /^\/faces\/[a-z0-9-]{2,31}\.png$/.test(url.pathname)) {
        // A teammate's face (public, like any Slack avatar): Slack fetches it for posts made before its own app exists.
        const png = await facePngFor(url.pathname.slice(7, -4));
        if (png) return void res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" }).end(png);
      }
      if (out[0] === 302) return void res.writeHead(302, { location: out[1] }).end();
      res.writeHead(out[0], { "content-type": type }).end(out[1]);
    } catch (error) {
      console.error("ingress error:", error);
      res.writeHead(500).end("error");
    }
  });
  return new Promise((resolve) => server.listen(config.ingressPort, config.ingressHost, () => resolve(server)));
}
