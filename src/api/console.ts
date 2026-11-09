// The console's side of the API (console/API.md): a password login (an httpOnly cookie), the read views every screen
// needs, and the actions that mirror Slack. Actions are made as the console's admin person (the first of
// PEEBLO_ADMINS): the server fills it in, the browser never sends one.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "../config.ts";
import { pool } from "../db.ts";
import { buildReceipt, receiptLine } from "../receipts.ts";
import { getTeammate, listTeammates } from "../store/teammates.ts";
import type { Router } from "./http.ts";

const COOKIE = "peeblo_console";
const DAY = 24 * 3600_000;

// A sign-in is a signed cookie (expiry + HMAC over it and the password), so it survives core restarts (setup restarts
// core) and a new password signs everyone out.
const sign = (exp: number) => createHmac("sha256", config.secretKey).update(`${exp}:${config.consolePassword}`).digest("hex");
export function consoleCookie(req: IncomingMessage): boolean {
  const c = /(?:^|;\s*)peeblo_console=(\d+)\.([a-f0-9]{64})/.exec(String(req.headers.cookie ?? ""));
  if (!c || !config.consolePassword || Number(c[1]) < Date.now()) return false;
  const want = Buffer.from(sign(Number(c[1])), "hex"), got = Buffer.from(c[2], "hex");
  return want.length === got.length && timingSafeEqual(want, got);
}
export async function consolePerson(): Promise<{ id: string; display_name: string | null } | null> {
  const admin = config.admins[0];
  if (!admin) return null;
  return (await pool.query("SELECT id, display_name FROM people WHERE slack_user = $1 LIMIT 1", [admin])).rows[0] ?? null;
}

// The login: one password (PEEBLO_CONSOLE_PASSWORD), compared in constant time; a wrong one waits a second.
export async function login(req: IncomingMessage, res: ServerResponse, body: any): Promise<void> {
  const want = createHash("sha256").update(config.consolePassword).digest();
  const got = createHash("sha256").update(String(body?.password ?? "")).digest();
  if (!config.consolePassword || !timingSafeEqual(want, got)) {
    await new Promise((r) => setTimeout(r, 1000));
    return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "wrong password" }));
  }
  const exp = Date.now() + 7 * DAY;
  res.writeHead(200, { "content-type": "application/json", "set-cookie": `${COOKIE}=${exp}.${sign(exp)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 24 * 3600}` }).end(JSON.stringify({ ok: true }));
}
export function logout(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { "content-type": "application/json", "set-cookie": `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` }).end(JSON.stringify({ ok: true }));
}

// The built console (console/dist), served at /console/.
// What the console shows for a job's ask: a person's words, or a plain name for an event Peeblo started itself.
function askedLabel(text: string | null): string {
  const t = String(text ?? "");
  const ev = /^<peeblo_event>\s*([^:.\n]+)/.exec(t);
  if (!ev) return t;
  const kind = ev[1].trim();
  return /first contact/.test(kind) ? "Welcome message (first contact)" : `${kind[0].toUpperCase()}${kind.slice(1)} (started by Peeblo)`;
}
// Where a session lives, in words: a DM, or a thread in a channel.
const whereLabel = (kind: string, placeKey: string) => /^D/.test(placeKey) || kind === "dm" ? "Direct message" : /^[CG]/.test(placeKey) ? "Channel thread" : kind;

const DIST = join(import.meta.dirname, "..", "..", "console", "dist");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
export function serveConsole(path: string, res: ServerResponse): boolean {
  if (!path.startsWith("/console")) return false;
  const rel = normalize(path.replace(/^\/console\/?/, "")).replace(/^(\.\.(\/|$))+/, "");
  // A real file inside dist, else the app's page (its routes are client-side).
  const asked = join(DIST, rel);
  const isFile = (f: string) => { try { return statSync(f).isFile(); } catch { return false; } };
  const file = rel && rel !== "." && asked.startsWith(DIST + "/") && isFile(asked) ? asked : join(DIST, "index.html");
  if (!isFile(file)) { res.writeHead(404).end("console not built: run pnpm --dir console build"); return true; }
  res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": file.endsWith("index.html") ? "no-cache" : "public, max-age=3600" }).end(readFileSync(file));
  return true;
}

const notFound = (what: string) => Object.assign(new Error(`no ${what}`), { status: 404 });
const bad = (why: string) => Object.assign(new Error(why), { status: 400 });

export function addConsoleRoutes(router: Router): void {
  router
    .add("GET", "/v1/console/me", async () => ({ person: await consolePerson() }))
    // A hire from the console form does what a hire through Peeblo does: the config, the Slack app with its face, and
    // the install link (the form is its approval).
    .add("GET", "/v1/setup", async () => {
      const { runChecks } = await import("../check.ts");
      return { checks: await runChecks() };
    })
    .add("GET", "/v1/teammates/:slug/overview", async ({ params }) => {
      const tm = await getTeammate(params.slug);
      if (!tm) throw notFound("teammate");
      const { teammateSpend } = await import("../otari/spend.ts");
      const { getApp } = await import("../ingress/apps.ts");
      const spend = await teammateSpend(tm).catch(() => null);
      const appId = (await pool.query("SELECT app_id FROM slack_apps WHERE teammate_id = $1 LIMIT 1", [tm.id])).rows[0]?.app_id ?? null;
      const app = appId ? await getApp(appId) : null;
      const hire = (await pool.query("SELECT install_url FROM hires WHERE teammate_id = $1", [tm.id])).rows[0];
      const recent = (await pool.query(`SELECT r.id, r.status, r.created_at, left(s.text, 140) AS asked FROM runs r JOIN submissions s ON s.id = r.submission_id JOIN sessions se ON se.id = r.session_id WHERE se.teammate_id = $1 ORDER BY r.created_at DESC LIMIT 10`, [tm.id])).rows;
      const schedules = (await pool.query("SELECT id, kind, name, cron, run_at, enabled, last_run_at FROM schedules WHERE teammate_id = $1 ORDER BY created_at DESC", [tm.id])).rows;
      const env = (await pool.query("SELECT size, state, pins, l2_reset_at FROM environments WHERE teammate_id = $1", [tm.id])).rows[0] ?? null;
      const { notesIn } = await import("../memory/store.ts");
      const dir = join(config.dataDir, "teammates", tm.slug, "memory");
      const banks = existsSync(dir) ? readdirSync(dir).filter((b) => !b.startsWith(".") && !b.endsWith(".md")) : [];
      const notes = notesIn(tm.slug, banks).filter((n) => n.bank !== "company");
      for (const r of recent) r.asked = askedLabel(r.asked);
      return { teammate: tm, spend: spend ? { spent: spend.spent, cap: spend.cap } : null, app: appId ? { app_id: appId, installed: Boolean(app?.secrets.bot_token), install_url: hire?.install_url ?? null } : null, recent_runs: recent, schedules, computer: env ? { teammate: tm.slug, ...env } : null, memory: { notes: notes.length, unverified: notes.filter((n) => !n.verified).length } };
    })
    .add("GET", "/v1/teammates/:slug/face.png", async ({ params }) => {
      const { facePng, pickFace } = await import("../slack/idcard.ts");
      const row = (await pool.query("SELECT h.avatar FROM hires h JOIN teammates t ON t.id = h.teammate_id WHERE t.slug = $1", [params.slug])).rows[0];
      const png = await facePng(row?.avatar?.shape ? row.avatar : pickFace(params.slug), 256);
      return { __raw: png, __type: "image/png" };
    })
    .add("GET", "/v1/people", async () => {
      const { personSpend } = await import("../otari/spend.ts");
      const rows = (await pool.query("SELECT id, display_name, slack_user, end_user_id FROM people ORDER BY display_name NULLS LAST")).rows;
      const people = [];
      for (const p of rows) { const s = p.end_user_id ? await personSpend(p.end_user_id).catch(() => null) : null; people.push({ id: p.id, display_name: p.display_name, slack_user: p.slack_user, spend: s?.spent ?? null, cap: s?.cap ?? null, tier: s?.tier ?? null }); }
      return { people };
    })
    .add("GET", "/v1/sessions", async ({ query }) => {
      const slug = query.get("teammate");
      const { rows } = await pool.query(
        `SELECT s.id, s.kind, s.place_key, s.created_at, s.last_active_at, count(r.id)::int AS runs FROM sessions s JOIN teammates t ON t.id = s.teammate_id LEFT JOIN runs r ON r.session_id = s.id
          WHERE ($1::text IS NULL OR t.slug = $1) GROUP BY s.id ORDER BY s.last_active_at DESC LIMIT 100`, [slug]);
      for (const r of rows) r.where = whereLabel(r.kind, r.place_key);
      return { sessions: rows };
    })
    .add("GET", "/v1/sessions/:id", async ({ params }) => {
      const s = (await pool.query("SELECT id, teammate_id, kind, place_key, created_at, last_active_at FROM sessions WHERE id = $1", [params.id])).rows[0];
      if (!s) throw notFound("session");
      const runs = (await pool.query("SELECT r.id, r.status, r.created_at, left(s.text, 300) AS asked FROM runs r JOIN submissions s ON s.id = r.submission_id WHERE r.session_id = $1 ORDER BY r.created_at DESC LIMIT 50", [params.id])).rows;
      for (const r of runs) {
        r.asked = askedLabel(r.asked);
        r.receipt = r.status === "done" || r.status === "failed" ? receiptLine(await buildReceipt(r.id).catch(() => null as any)) : null;
        // A job that ended on a stop (budget, guardrail, stuck) says so instead of a plain "done".
        const stop = (await pool.query("SELECT data->>'stop_reason' AS s FROM events WHERE run_id = $1 AND type = 'turn.finished' ORDER BY id DESC LIMIT 1", [r.id])).rows[0]?.s;
        if (r.status === "done" && stop && ["budget_blocked", "guard_blocked", "guard_unavailable", "stuck", "error", "aborted", "length"].includes(stop)) r.status = `stopped: ${stop.replace(/_/g, " ")}`;
      }
      return { session: s, runs };
    })
    .add("GET", "/v1/approvals", async ({ query }) => {
      const status = query.get("status") ?? "pending";
      const { rows } = await pool.query(
        `SELECT a.id, a.run_id, a.action, a.created_at, a.expires_at, a.status, t.slug AS teammate FROM approvals a JOIN runs r ON r.id = a.run_id JOIN sessions s ON s.id = r.session_id JOIN teammates t ON t.id = s.teammate_id
          WHERE ($1 = 'all' OR a.status = $1) AND (a.status <> 'pending' OR a.expires_at > now()) ORDER BY a.created_at DESC LIMIT 100`, [status]);
      return { approvals: rows };
    })
    .add("GET", "/v1/otari", async () => {
      // A mirror of Otari for this Peeblo: what is set, what is missing, and where to change it in Otari's dashboard.
      const { links } = await import("../otari/links.ts");
      const { lakeraMandate } = await import("../guard.ts");
      const { rolePoliciesInOtari, ROLES, rolePoliciesReady } = await import("../otari/routing.ts");
      const { webSearch, session } = await import("../otari/admin.ts");
      const s = await session();
      const g = s ? await lakeraMandate().catch(() => null) : null;
      const ws = s ? await webSearch().catch(() => null) : null;
      return {
        session: s ? { signed_in_as: s.signedInAs, expires_at: s.expiresAt } : null,
        web_search: { enabled: ws?.enabled ?? null },
        guardrail: { enabled: g?.enabled ?? null, profile: config.guardProfile, mode: config.guard },
        trace_content: config.traceContent,
        routing_policies: s ? await rolePoliciesInOtari().catch(() => []) : [], roles: Object.keys(ROLES), policies_ready: rolePoliciesReady(),
        links: { dashboard: links.usage(), keys: links.keys(), budgets: links.budgets(), guardrails: links.guardrails(), routing: links.routing(), web_search: links.webSearch(), mcp: links.mcpServers(), sessions: links.sessionsFor({ q: "peeblo" }) },
      };
    })
    // Connect Otari: the admin signs in once (the password is used for this call only, never stored); Peeblo keeps
    // the session sealed and sets itself up: role routing policies, and a key with a spend ceiling per teammate.
    .add("POST", "/v1/otari/session", async ({ body }) => {
      if (!body?.email || !body?.password) throw bad("email and password are required");
      const { signIn } = await import("../otari/admin.ts");
      const r = await signIn(String(body.email), String(body.password));
      const { ensureDefaultTier } = await import("../otari/people.ts");
      const tier = await ensureDefaultTier().catch((e) => { console.error("default tier:", (e as Error).message); return null; });
      const { syncRolePolicies } = await import("../otari/routing.ts");
      const policies = await syncRolePolicies().catch(() => false);
      const { listTeammates } = await import("../store/teammates.ts");
      const { teammateKey } = await import("../otari/spend.ts");
      let keys = 0;
      for (const t of await listTeammates()) if (await teammateKey(t).catch(() => null)) keys++;
      return { ok: true, expires_at: r.expiresAt, policies, teammate_keys: keys, ...(tier ? { default_tier: tier } : {}) };
    })
    .add("DELETE", "/v1/otari/session", async () => {
      const { signOut } = await import("../otari/admin.ts");
      await signOut();
      return { ok: true };
    })
    .add("GET", "/v1/computers", async () => {
      const { awake } = await import("../environment/controller.ts");
      const up = new Set(awake().map((a) => a.teammateId));
      const { rows } = await pool.query("SELECT e.teammate_id, t.slug, e.size, e.state, e.pins, e.l2_reset_at FROM environments e JOIN teammates t ON t.id = e.teammate_id ORDER BY t.slug");
      const out = [];
      for (const r of rows) {
        const builds = (await pool.query("SELECT id, status, purpose, created_at, error FROM recipe_builds WHERE teammate_id = $1 ORDER BY created_at DESC LIMIT 5", [r.teammate_id])).rows;
        out.push({ teammate: r.slug, size: r.size, state: up.has(r.teammate_id) ? "awake" : r.state === "awake" ? "asleep" : r.state, pins: r.pins, l2_reset_at: r.l2_reset_at, builds });
      }
      return { computers: out };
    })
    .add("POST", "/v1/teammates/:slug/computer/reset", async ({ params }) => {
      const tm = await getTeammate(params.slug);
      if (!tm) throw notFound("teammate");
      const { diskOf, isAwake, sleep } = await import("../environment/controller.ts");
      if (isAwake(tm.id)) await sleep(tm.id, "reset from the console");
      const size = (tm.config.computer?.size ?? "small") as "small" | "large";
      rmSync(diskOf(tm.slug, size), { force: true });
      await pool.query("UPDATE environments SET l2 = l2 - $2::text, l2_reset_at = now() WHERE teammate_id = $1", [tm.id, size]);
      return { ok: true };
    })
    .add("POST", "/v1/teammates/:slug/computer/rebuild", async ({ params }) => {
      const tm = await getTeammate(params.slug);
      if (!tm) throw notFound("teammate");
      const { queueBuild } = await import("../environment/recipes.ts");
      return { ok: true, build: await queueBuild(tm.id, (tm.config.computer?.size ?? "small") as any, "config") };
    })
    .add("GET", "/v1/teammates/:slug/memory", async ({ params }) => {
      const tm = await getTeammate(params.slug);
      if (!tm) throw notFound("teammate");
      const { notesIn } = await import("../memory/store.ts");
      const dir = join(config.dataDir, "teammates", tm.slug, "memory");
      const banks = existsSync(dir) ? readdirSync(dir).filter((b) => !b.startsWith(".") && !b.endsWith(".md")) : [];
      return { notes: notesIn(tm.slug, banks).map(({ body: _b, ...n }) => n) };
    })
    .add("GET", "/v1/teammates/:slug/memory/note", async ({ params, query }) => {
      const { notesIn } = await import("../memory/store.ts");
      const n = notesIn(params.slug, [String(query.get("bank"))]).find((x) => x.bank === query.get("bank") && x.path === query.get("path"));
      if (!n) throw notFound("note");
      return { note: n };
    })
    .add("PUT", "/v1/teammates/:slug/memory/note", async ({ params, body }) => {
      const { writeNote } = await import("../memory/store.ts");
      const b = String(body?.bank ?? "ws");
      const place = b.startsWith("dm-") ? { kind: "dm" as const, user: b.slice(3) } : b.startsWith("ch-") ? { kind: "private" as const, channel: b.slice(3) } : { kind: "public" as const };
      return { note: await writeNote(params.slug, place, { path: body.path, title: body.title, body: body.body, source: "edited in the console", runId: null, tainted: false }) };
    })
    .add("POST", "/v1/teammates/:slug/memory/verify", async ({ params, body }) => {
      const { verifyNote } = await import("../memory/store.ts");
      return { ok: verifyNote(params.slug, String(body.bank), String(body.path)) };
    })
    .add("PATCH", "/v1/schedules/:id", async ({ params, body }) => {
      await pool.query("UPDATE schedules SET enabled = $2 WHERE id = $1", [params.id, Boolean(body?.enabled)]);
      const { syncSchedules } = await import("../durable/schedules.ts");
      await syncSchedules();
      return { ok: true };
    })
    .add("GET", "/v1/schedules/:id/hook", async ({ params }) => {
      const s = (await pool.query("SELECT s.secret, t.slug FROM schedules s JOIN teammates t ON t.id = s.teammate_id WHERE s.id = $1 AND s.kind = 'webhook'", [params.id])).rows[0];
      if (!s) throw notFound("webhook trigger");
      const { unseal } = await import("../crypto.ts");
      return { url: `${config.publicUrl}/hooks/${s.slug}/${params.id}`, secret: unseal<string>(s.secret) };
    })
    .add("GET", "/v1/feedback", async () => {
      const { rows } = await pool.query(
        `SELECT e.run_id, e.data->>'vote' AS vote, p.display_name AS by, e.at, t.slug AS teammate, left(sub.text, 200) AS asked
           FROM events e LEFT JOIN people p ON p.id = e.data->>'by' JOIN runs r ON r.id = e.run_id JOIN submissions sub ON sub.id = r.submission_id JOIN sessions s ON s.id = r.session_id JOIN teammates t ON t.id = s.teammate_id
          WHERE e.type = 'slack.feedback' ORDER BY e.id DESC LIMIT 200`);
      return { feedback: rows };
    });
  void listTeammates;
}
