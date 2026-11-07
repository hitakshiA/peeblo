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

// First app to claim a human message wins; returns false for every later delivery of the same message.
export async function claimMessage(teamId: string, channel: string, ts: string, appId: string, eventType: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    "INSERT INTO slack_claims (team_id, channel, ts, app_id, event_type) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING",
    [teamId, channel, ts, appId, eventType],
  );
  return rowCount === 1;
}

type Handler = (e: { appId: string; teammateId: string | null; teamId: string; event: any; payload: any }) => Promise<void>;
const handlers: Handler[] = [];
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
  if (ev.bot_id && ev.bot_id === payload.authorizations?.[0]?.user_id) return [200, ""];
  if (ev.type === "message" || ev.type === "app_mention") {
    if (ev.user === app.bot_user_id) return [200, ""];                       // our own post echoed back
    const first = await claimMessage(payload.team_id, ev.channel, ev.ts ?? ev.event_ts, app.app_id, ev.type);
    if (!first) return [200, ""];
    await appendEvent({ type: "slack.message", data: { app_id: app.app_id, team_id: payload.team_id, event_id: payload.event_id, event: ev } });
    for (const h of handlers) await h({ appId: app.app_id, teammateId: app.teammate_id, teamId: payload.team_id, event: ev, payload }).catch((e) => console.error("slack handler:", e));
    return [200, ""];
  }
  await appendEvent({ type: `slack.${ev.type ?? payload.type}`, data: { app_id: app.app_id, team_id: payload.team_id, event_id: payload.event_id, event: ev } });
  return [200, ""];
}

async function handleInteraction(body: string, req: IncomingMessage): Promise<[number, string]> {
  let payload: any;
  try { payload = JSON.parse(new URLSearchParams(body).get("payload") ?? ""); } catch { return [400, "bad body"]; }
  const app = await getApp(String(payload.api_app_id ?? payload.view?.app_id ?? ""));
  if (!app || !verifySlack(app.secrets.signing_secret, req.headers["x-slack-request-timestamp"] as string, body, req.headers["x-slack-signature"] as string)) return [401, "bad signature"];
  await appendEvent({ type: "slack.interaction", data: { app_id: app.app_id, type: payload.type, user: payload.user?.id, action: payload.actions?.[0]?.action_id, value: payload.actions?.[0]?.value, callback: payload.view?.callback_id } });
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
  return [200, page("Added to Slack. You can close this tab.")];
}

const page = (text: string) => `<!doctype html><meta charset="utf-8"><title>Peeblo</title><body style="font:16px system-ui;padding:3rem"><p>${text.replace(/</g, "&lt;")}</p>`;

export function startIngress(): Promise<Server> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://ingress");
    try {
      let out: [number, string] = [404, "not found"];
      let type = "text/plain";
      if (req.method === "POST" && url.pathname === "/slack/events") out = await handleEvents(await rawBody(req), req);
      else if (req.method === "POST" && url.pathname === "/slack/interactions") out = await handleInteraction(await rawBody(req), req);
      else if (req.method === "GET" && url.pathname === "/slack/oauth/callback") { out = await handleOAuth(url); type = "text/html"; }
      res.writeHead(out[0], { "content-type": type }).end(out[1]);
    } catch (error) {
      console.error("ingress error:", error);
      res.writeHead(500).end("error");
    }
  });
  return new Promise((resolve) => server.listen(config.ingressPort, config.ingressHost, () => resolve(server)));
}
