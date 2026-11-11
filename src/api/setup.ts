// The console's first-run setup: everything a new owner gives (Otari key, public address, Slack token) and does
// (connect Otari, make and add Peeblo's Slack app) in the browser, with live state from Otari and Slack at each step.
// Settings go to settings.json (src/settings.ts); the Slack token is kept sealed in the database.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { pool } from "../db.ts";
import { guardMode } from "../guard.ts";
import { restartSoon, saveSettings } from "../settings.ts";
import { bad, type Router } from "./http.ts";

const ASSETS = join(import.meta.dirname, "..", "..", "assets");

// Slow facts (Otari, Slack, the public address) are cached briefly, so polling the state stays cheap.
const cache = new Map<string, { at: number; v: any }>();
async function cached<T>(key: string, ms: number, fn: () => Promise<T>): Promise<T> {
  const c = cache.get(key);
  if (c && Date.now() - c.at < ms) return c.v;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  return v;
}
const forget = (...keys: string[]) => { for (const k of keys) cache.delete(k); };

const baseUrl = (region: string) => (region === "eu" ? "https://eu.api.otari.ai/api/v1" : "https://api.otari.ai/api/v1");
async function keyBudget(key: string, region: string): Promise<{ ok: boolean; error?: string; used?: number; limit?: number }> {
  const r = await fetch(`${baseUrl(region)}/key/budget`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }) as any);
  if (!r.ok) return { ok: false, error: r.status === 401 || r.status === 403 ? "Otari didn't accept that key" : r.status === 421 ? "That key is for the other region" : `Otari answered ${r.status}` };
  const j: any = await r.json().catch(() => ({}));
  // A plain key works for model calls but can't name the people it bills; Otari says so on end-user budgets.
  const s = await fetch(`${baseUrl(region)}/end-user-budgets`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) }).catch(() => null);
  if (s?.status === 403) return { ok: false, error: "That's a plain key. Peeblo needs a service key: in Otari, API keys → Create key → Advanced → tick Service key" };
  return { ok: true, used: j.limits?.[0]?.used_usd, limit: j.limits?.[0]?.limit_usd };
}
async function reachable(url: string): Promise<{ ok: boolean; error?: string }> {
  if (!/^https:\/\//.test(url)) return { ok: false, error: "It must start with https://" };
  const r = await fetch(`${url.replace(/\/+$/, "")}/slack/events`, { method: "POST", headers: { "content-type": "application/json", "user-agent": "peeblo-check" }, body: JSON.stringify({ type: "url_verification", challenge: "peeblo-check" }), signal: AbortSignal.timeout(10_000) }).catch((e) => ({ ok: false, status: 0, text: async () => (e as Error).message }) as any);
  const text = await r.text().catch(() => "");
  return text === "peeblo-check" ? { ok: true } : { ok: false, error: r.status ? `It answered ${r.status}, but not as this Peeblo (point it at port ${config.ingressPort})` : "Nothing answered at that address" };
}

async function peebloApp(): Promise<{ app_id: string; team_id: string | null; bot_user_id: string | null } | null> {
  return (await pool.query("SELECT a.app_id, a.team_id, a.bot_user_id FROM slack_apps a JOIN teammates t ON t.id = a.teammate_id WHERE t.slug = 'peeblo' LIMIT 1")).rows[0] ?? null;
}

export async function setupState(): Promise<any> {
  const { links } = await import("../otari/links.ts");
  const { session } = await import("../otari/admin.ts");
  const region = process.env.OTARI_REGION === "eu" || config.otariBaseUrl.includes("eu.api") ? "eu" : "us";
  const otariKey = config.otariKey ? await cached("key", 20_000, () => keyBudget(config.otariKey, region)) : null;
  const s = config.otariKey ? await session().catch(() => null) : null;
  const pub = config.publicUrl ? await cached("pub", 20_000, () => reachable(config.publicUrl)) : null;
  const token = (await pool.query("SELECT 1 FROM slack_config WHERE id = 1")).rows.length > 0;
  const tokenOk = token ? await cached("slack", 60_000, async () => { const { configTokenWorks } = await import("../slack/admin.ts"); return configTokenWorks().then(() => true, () => false); }) : null;
  const app = await peebloApp();
  let installUrl: string | null = null;
  if (app && !app.bot_user_id && config.publicUrl) {
    const { getApp } = await import("../ingress/apps.ts");
    const { installUrl: url } = await import("../slack/admin.ts");
    const a: any = await getApp(app.app_id);
    if (a?.secrets?.client_id) installUrl = url(app.app_id, a.secrets.client_id);
  }
  const admins = config.admins.length ? (await pool.query("SELECT slack_user, display_name FROM people WHERE slack_user = ANY($1)", [config.admins])).rows : [];
  // The readiness list is ./peeblo check's Otari part, so the console and the CLI never disagree.
  const readiness = otariKey?.ok ? await cached("ready", 30_000, async () => {
    const { runChecks } = await import("../check.ts");
    const all = await runChecks();
    const pick = (name: string, id: string, label: string, fix_url?: string, fix_text?: string) => {
      const r = all.find((x) => x.name === name);
      // Connectors and per-teammate access are worth fixing but never block setup (an unhealthy server is a warning).
      return r ? { id, label, ok: r.ok, required: !OPTIONAL.includes(id), detail: r.detail, ...(r.ok ? {} : { fix_url, fix_text }) } : null;
    };
    return [
      pick("Otari service key (bills each person)", "tier", "A default budget for each person", links.budgets(), "Sign in again on Connect Otari (it sets one), or Budgets → make a tier, then API keys → your key → default end-user budget"),
      pick("Otari web search and code execution", "tools", "Web search and code execution", `${links.webSearch()}`, "Tools → turn on web search and code execution"),
      guardItem(pick("Otari guardrail", "guardrail", guardMode() === "open" ? "The guardrail (open guard model)" : "The Lakera guardrail", links.guardrails(), "Guardrails → add Lakera Guard with the profile name peeblo-lakera (needs a Lakera account)")),
      pick("Otari MCP connectors", "connectors", "Connectors (MCP servers)", links.mcpServers(), "Tools → MCP servers → add the services your team uses"),
      pick("Otari routing policies", "routing", "Routing for each role", links.routing(), "Connect the dashboard above; Peeblo makes these itself"),
      pick("Otari connector access per teammate", "access", "Connector access per teammate", links.mcpServers(), "Set each server's default access to read tools"),
    ].filter(Boolean);
  }) : [];
  const steps: [string, boolean][] = [
    ["password", Boolean(config.consolePassword)],
    ["otari", Boolean(otariKey?.ok)],
    ["connect", Boolean(s)],
    ["readiness", readiness.length > 0 && readiness.every((r: any) => r.ok || OPTIONAL.includes(r.id))],
    ["public_url", Boolean(pub?.ok)],
    ["slack", Boolean(app?.bot_user_id)],
  ];
  return {
    signed_in: true,
    password_set: Boolean(config.consolePassword),
    mode: config.otariKey ? "running" : "setup",
    otari: {
      key_set: Boolean(config.otariKey), key_ok: otariKey ? otariKey.ok : null, ...(otariKey?.error ? { key_error: otariKey.error } : {}), region,
      used_usd: otariKey?.used ?? null, limit_usd: otariKey?.limit ?? null,
      connected: Boolean(s), signed_in_as: s?.signedInAs ?? null, session_expires_at: s?.expiresAt ?? null,
      links: { dashboard: links.usage(), keys: links.keys(), budgets: links.budgets(), guardrails: links.guardrails(), tools: links.webSearch(), mcp: links.mcpServers(), set_password: links.setPassword() },
    },
    public_url: { value: config.publicUrl || null, reachable: pub ? pub.ok : null, ...(pub?.error ? { error: pub.error } : {}),
      hint: "On a server, a domain with HTTPS in front of port 8787 (Caddy does it in two lines). On a Mac, a tunnel to port 8787: a reserved zrok share without its warning page, a Cloudflare named tunnel, or Tailscale Funnel." },
    slack: { token_set: token, token_ok: tokenOk, app_created: Boolean(app), install_url: installUrl, installed: Boolean(app?.bot_user_id),
      workspace: app?.team_id ?? null, peeblo_dm_url: app?.bot_user_id && app.team_id ? `https://slack.com/app_redirect?app=${app.app_id}&team=${app.team_id}` : null },
    admins,
    readiness,
    next: steps.find(([, done]) => !done)?.[0] ?? "done",
  };
}

const OPTIONAL = ["access", "connectors"];
// The guardrail item offers the other guard: Lakera needs its own account, the open guard model runs on Otari alone.
function guardItem(i: any): any {
  if (!i) return i;
  if (guardMode() === "lakera" && !i.ok) return { ...i, alt: { mode: "open", text: "No Lakera account? Use an open guard model" } };
  if (guardMode() === "open") return { ...i, alt: { mode: "lakera", text: "Use Lakera instead" } };
  return i;
}

export function addSetupRoutes(router: Router): void {
  router
    // Which guard screens outside text: Lakera (through Otari's org guardrail) or an open guard model through Otari.
    .add("POST", "/v1/setup/guard", async ({ body }) => {
      const mode = body?.mode === "open" ? "open" : body?.mode === "lakera" ? "lakera" : null;
      if (!mode) throw bad("mode is open or lakera");
      saveSettings({ PEEBLO_GUARD: mode === "lakera" ? null : mode });
      forget("ready");
      restartSoon();
      return { ok: true, restarting: true };
    })
    .add("GET", "/v1/setup/state", async () => setupState())
    .add("POST", "/v1/setup/otari", async ({ body }) => {
      const key = String(body?.key ?? "").trim();
      if (!key) throw bad("Paste the service key from Otari.");
      // Otari keys name their region (otk_v1_us_…); the menu is only for keys that don't.
      const region = key.match(/^otk_v\d+_(us|eu)_/)?.[1] ?? (body?.region === "eu" ? "eu" : "us");
      const r = await keyBudget(key, region);
      if (!r.ok) return { ok: false, error: r.error, restarting: false };
      saveSettings({ OTARI_SERVICE_KEY: key, OTARI_REGION: region === "eu" ? "eu" : null });
      forget("key", "ready");
      restartSoon();
      return { ok: true, restarting: true, region, used: r.used, limit: r.limit };
    })
    .add("POST", "/v1/setup/public-url", async ({ body }) => {
      const url = String(body?.url ?? "").trim().replace(/\/+$/, "");
      const r = await reachable(url);
      if (!/^https:\/\//.test(url)) return { ok: false, reachable: false, error: r.error, restarting: false };
      saveSettings({ PEEBLO_PUBLIC_URL: url });
      forget("pub");
      restartSoon();
      return { ok: true, reachable: r.ok, ...(r.error ? { error: r.error } : {}), restarting: true };
    })
    .add("POST", "/v1/setup/slack", async ({ body }) => {
      const access = String(body?.access_token ?? "").trim(), refresh = String(body?.refresh_token ?? "").trim();
      if (!refresh.startsWith("xoxe-")) return { ok: false, error: "The refresh token starts with xoxe-; copy both from api.slack.com/apps → Your App Configuration Tokens." };
      // Rotating proves the pair works and gives a fresh one with its expiry; the old pair stops working.
      const r: any = await (await fetch("https://slack.com/api/tooling.tokens.rotate", { method: "POST", body: new URLSearchParams({ refresh_token: refresh }) })).json().catch(() => ({ ok: false, error: "Slack didn't answer" }));
      if (!r.ok) return { ok: false, error: r.error === "invalid_refresh_token" ? "Slack didn't accept that refresh token (they work once: generate a new pair)" : `Slack said: ${r.error}` };
      void access;
      const { storeToken } = await import("../slack/admin.ts");
      await storeToken({ access_token: r.token, refresh_token: r.refresh_token, exp: r.exp });
      forget("slack");
      return { ok: true };
    })
    .add("POST", "/v1/setup/slack-app", async () => {
      if (!config.publicUrl) throw bad("Set the public address first: Slack sends Peeblo's events there.");
      const { ensureManager, MANAGER } = await import("../manager.ts");
      await ensureManager();
      const existing = await peebloApp();
      if (existing) { const st = await setupState(); return { install_url: st.slack.install_url, installed: st.slack.installed }; }
      const { getTeammate } = await import("../store/teammates.ts");
      const { createTeammateApp } = await import("../slack/admin.ts");
      const { facePng } = await import("../slack/idcard.ts");
      const tm = (await getTeammate(MANAGER))!;
      const face = { shape: "peeblo", color: "#2E7D5B" };
      const app = await createTeammateApp(tm, face.color, await facePng(face));
      return { install_url: app.installUrl, installed: false };
    })
    // Otari's connectors (MCP servers), with their icon, health, and which teammate uses them.
    .add("GET", "/v1/connectors", async () => {
      const { links } = await import("../otari/links.ts");
      const { mcpServers, session } = await import("../otari/admin.ts");
      const { serviceName } = await import("../slack/look.ts");
      const { listTeammates } = await import("../store/teammates.ts");
      const s = await session().catch(() => null);
      let servers: any[] = [];
      if (s) { const l: any = await mcpServers(); servers = Array.isArray(l) ? l : l.servers ?? l.data ?? []; }
      else { const { serverList } = await import("../connectors/mcp.ts"); servers = (await serverList().catch(() => [])) as any[]; }
      const crew = (await listTeammates()).filter((t) => !(t as any).hidden);
      return {
        otari_connected: Boolean(s), add_url: links.mcpServers(),
        servers: servers.map((x: any) => ({
          name: x.name, label: serviceName(x.name), purpose: x.purpose_hint ?? null,
          icon_url: existsSync(join(ASSETS, "services", `${x.name}.png`)) ? `/v1/icons/${x.name}.png` : null,
          healthy: x.health ? x.health.status === "healthy" : null, tools: x.health?.tool_count ?? null,
          used_by: crew.filter((t) => t.config.connectors.includes(x.name) || t.config.connectors.includes("all")).map((t) => ({ slug: t.slug, name: t.config.name, read_only: (t.config.read_only ?? []).includes(x.name) })),
        })),
      };
    })
    .add("GET", "/v1/icons/:file", async ({ params }) => {
      if (!/^[a-z0-9-]+\.png$/.test(params.file)) throw bad("no such icon");
      const f = join(ASSETS, "services", params.file);
      if (!existsSync(f)) throw Object.assign(new Error("no such icon"), { status: 404 });
      return { __raw: readFileSync(f), __type: "image/png" };
    })
    .add("GET", "/v1/avatars/:file", async ({ params }) => {
      if (!/^[a-z0-9-]+\.json$/.test(params.file)) throw bad("no such avatar");
      const f = join(ASSETS, "avatars", params.file);
      if (!existsSync(f)) throw Object.assign(new Error("no such avatar"), { status: 404 });
      return { __raw: readFileSync(f), __type: "application/json" };
    });
}
