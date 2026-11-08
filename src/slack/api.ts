// Slack's Web API for one app (each teammate has its own app, so each speaks with its own name and face).
import { getApp } from "../ingress/apps.ts";

export class SlackError extends Error {
  method: string; code: string; detail?: unknown;
  constructor(method: string, code: string, detail?: unknown) { super(`${method}: ${code}`); this.method = method; this.code = code; this.detail = detail; }
}

const READS = /^(conversations\.(replies|history|info|members|list)|users\.(info|list|lookupByEmail)|reactions\.get|team\.info|auth\.test|chat\.getPermalink|files\.(getUploadURLExternal|completeUploadExternal))$/;

export async function slack<T = any>(appId: string, method: string, payload: Record<string, unknown>): Promise<T> {
  const app = await getApp(appId);
  const token = app?.secrets.bot_token;
  if (!token) throw new SlackError(method, "not_installed");
  for (let attempt = 0; ; attempt++) {
    // Read methods take form fields, not JSON.
    const form = READS.test(method);
    const r = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": form ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8" },
      body: form ? new URLSearchParams(Object.entries(payload).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)])) : JSON.stringify(payload),
    });
    if (r.status === 429 && attempt < 3) { await new Promise((x) => setTimeout(x, 1000 * Number(r.headers.get("retry-after") ?? 1))); continue; }
    const j: any = await r.json();
    if (!j.ok) throw new SlackError(method, j.error ?? `http_${r.status}`, j.response_metadata);
    return j as T;
  }
}

// Whether a user is a bot (a teammate's app, an integration). A message a person sends through an app with their
// own token carries a bot_id but is still theirs, so this asks about the user, not the message.
const bots = new Map<string, boolean>();
export async function isBotUser(appId: string, user: string): Promise<boolean> {
  if (bots.has(user)) return bots.get(user)!;
  const j = await slack(appId, "users.info", { user }).catch(() => null);
  const b = Boolean(j?.user?.is_bot || j?.user?.is_app_user);
  bots.set(user, b);
  return b;
}

// Names of people, cached (for receipts and the person record).
const names = new Map<string, { name: string; at: number }>();
export async function displayName(appId: string, user: string): Promise<string | null> {
  const c = names.get(user);
  if (c && Date.now() - c.at < 3600_000) return c.name;
  try {
    const j = await slack(appId, "users.info", { user });
    const name = j.user?.profile?.display_name || j.user?.real_name || j.user?.name || null;
    if (name) names.set(user, { name, at: Date.now() });
    return name;
  } catch { return null; }
}

export const react = (appId: string, channel: string, ts: string, name: string) => slack(appId, "reactions.add", { channel, timestamp: ts, name }).catch(() => null);
export const unreact = (appId: string, channel: string, ts: string, name: string) => slack(appId, "reactions.remove", { channel, timestamp: ts, name }).catch(() => null);
