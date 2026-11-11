// Making a teammate's Slack app (D1): from a manifest with the app configuration token (rotated before it expires),
// with its face (an Open Bot Avatar), and a one-click install link. The config token lives sealed in core; on first
// use it comes from the console's setup (or from PEEBLO_SLACK_CONFIG_FILE: {access_token, refresh_token, exp}).
import { existsSync, readFileSync } from "node:fs";
import { config } from "../config.ts";
import { seal, unseal } from "../crypto.ts";
import { pool } from "../db.ts";
import { saveApp } from "../ingress/apps.ts";
import { appendEvent } from "../store/events.ts";
import type { Teammate } from "../store/teammates.ts";

type ConfigToken = { access_token: string; refresh_token: string; exp: number };
const form = (p: Record<string, string>) => new URLSearchParams(p);

async function call(method: string, body: URLSearchParams | FormData, token?: string): Promise<any> {
  const r = await fetch(`https://slack.com/api/${method}`, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body });
  return r.json();
}

// The stored token wins, unless the file holds a newer one (an admin made a fresh token after the old one broke).
async function loadToken(): Promise<ConfigToken | null> {
  const { rows } = await pool.query("SELECT token FROM slack_config WHERE id = 1");
  const stored = rows[0] ? unseal<ConfigToken>(rows[0].token) : null;
  const f = process.env.PEEBLO_SLACK_CONFIG_FILE;
  let file: ConfigToken | null = null;
  try { if (f && existsSync(f)) file = JSON.parse(readFileSync(f, "utf8")) as ConfigToken; } catch { /* a broken file is ignored while a stored token exists */ }
  if (file?.access_token && (!stored || (file.access_token !== stored.access_token && Number(file.exp) > Number(stored.exp)))) { await storeToken(file); return file; }
  return stored;
}
export const storeToken = (t: ConfigToken) => pool.query("INSERT INTO slack_config (id, token) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET token = $1, updated_at = now()", [seal(t)]);

// The token rotates every 12 h. A refresh token works once, so rotation holds a database lock (check and core can
// both get here) and re-reads the token inside it; the new refresh token is saved before the access token is used.
export async function configToken(): Promise<string> {
  const t = await loadToken();
  if (!t) throw new Error("no Slack app configuration token; an admin creates one at api.slack.com/apps (Your App Configuration Tokens)");
  if (t.exp - Date.now() / 1000 > 600) return t.access_token;
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtext('peeblo.slack_config'))");
    const now = (await c.query("SELECT token FROM slack_config WHERE id = 1")).rows[0];
    const cur = now ? unseal<ConfigToken>(now.token) : t;
    if (cur.exp - Date.now() / 1000 > 600) { await c.query("COMMIT"); return cur.access_token; }
    const r = await call("tooling.tokens.rotate", form({ refresh_token: cur.refresh_token }));
    if (!r.ok) throw new Error(`Slack config token rotation failed (${r.error}): make a new one at api.slack.com/apps (Your App Configuration Tokens), and paste it in the console (Setup → Slack)`);
    await c.query("INSERT INTO slack_config (id, token) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET token = $1, updated_at = now()", [seal({ access_token: r.token, refresh_token: r.refresh_token, exp: r.exp })]);
    await c.query("COMMIT");
    return r.token;
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}

// A real call with the token: Slack checks the token before the manifest, so an auth error means the token is bad.
export async function configTokenWorks(): Promise<void> {
  const r = await call("apps.manifest.validate", form({ manifest: JSON.stringify({ display_information: { name: "peeblo check" } }) }), await configToken());
  if (["invalid_auth", "not_authed", "token_expired", "token_revoked", "account_inactive"].includes(r.error)) throw new Error(`Slack refused it (${r.error}): make a new one at api.slack.com/apps (Your App Configuration Tokens), and paste it in the console (Setup → Slack)`);
}

// The manifest and scopes live in profile.ts (built from the teammate's config and its agent-written profile).
import { BOT_SCOPES, manifestFor } from "./profile.ts";

// Creates the teammate's app and sets its face. Returns the app id and its one-click install link.
export async function createTeammateApp(tm: Teammate, color: string, png: Buffer): Promise<{ appId: string; installUrl: string }> {
  const token = await configToken();
  const display = tm.config.name;
  void display;
  const r = await call("apps.manifest.create", form({ manifest: JSON.stringify(await manifestFor(tm, color)) }), token);
  if (!r.ok) throw new Error(`Slack wouldn't create the app: ${r.error}${r.errors ? ` ${JSON.stringify(r.errors).slice(0, 300)}` : ""}`);
  await saveApp({ app_id: r.app_id, teammate_id: tm.id, secrets: { signing_secret: r.credentials.signing_secret, client_id: r.credentials.client_id, client_secret: r.credentials.client_secret } });
  const fd = new FormData();
  fd.append("app_id", r.app_id);
  fd.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "face.png");
  const icon = await call("apps.icon.set", fd, token);
  await appendEvent({ type: "slack.app_created", data: { teammate_id: tm.id, app_id: r.app_id, icon: icon.ok ? "set" : icon.error } });
  return { appId: r.app_id, installUrl: installUrl(r.app_id, r.credentials.client_id) };
}

export function installUrl(appId: string, clientId: string): string {
  const p = new URLSearchParams({ client_id: clientId, scope: BOT_SCOPES.join(","), redirect_uri: `${config.publicUrl}/slack/oauth/callback`, state: `install:${appId}` });
  return `https://slack.com/oauth/v2/authorize?${p}`;
}
