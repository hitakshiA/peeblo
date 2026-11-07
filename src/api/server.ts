// The core API: the one way in for the console, Peeblo's own tools and scripts. It listens on loopback
// (or the compose-internal network) only, never on the public URL, and every call needs the admin token.
import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { config } from "../config.ts";
import { pool } from "../db.ts";
import { answerApproval } from "../durable/approvals.ts";
import { startRun } from "../durable/runs.ts";
import { syncSchedules } from "../durable/schedules.ts";
import { newId } from "../ids.ts";
import { runEvents } from "../store/events.ts";
import { getRun, getSession, openSession, submit, type SessionKind } from "../store/sessions.ts";
import { createTeammate, getTeammate, listTeammates, teammateVersions, updateTeammate } from "../store/teammates.ts";
import { listApps, saveApp } from "../ingress/apps.ts";
import { exec as vmExec, sleep as vmSleep } from "../environment/controller.ts";
import { readJson, Router, send } from "./http.ts";

const notFound = (what: string) => Object.assign(new Error(`no ${what}`), { status: 404 });
const bad = (msg: string) => Object.assign(new Error(msg), { status: 400 });

export const router = new Router()
  .add("GET", "/healthz", async () => ({ ok: true }))
  .add("GET", "/v1/teammates", async () => ({ teammates: await listTeammates() }))
  .add("POST", "/v1/teammates", async ({ body }) => {
    const { slug, ...config } = body ?? {};
    return createTeammate(String(slug ?? ""), config, { personId: body?.owner_person ?? null, label: "api" });
  })
  .add("GET", "/v1/teammates/:slug", async ({ params }) => (await getTeammate(params.slug)) ?? Promise.reject(notFound("teammate")))
  .add("PATCH", "/v1/teammates/:slug", async ({ params, body }) => {
    const { note, ...patch } = body ?? {};
    return updateTeammate(params.slug, patch, { label: "api" }, note);
  })
  .add("GET", "/v1/teammates/:slug/versions", async ({ params }) => ({ versions: await teammateVersions(params.slug) }))
  .add("POST", "/v1/teammates/:slug/sessions", async ({ params, body }) => {
    const tm = await getTeammate(params.slug);
    if (!tm) throw notFound("teammate");
    const kind = (body?.kind ?? "api") as SessionKind;
    if (!["desk", "channel", "thread", "dm", "api"].includes(kind)) throw bad("kind must be desk, channel, thread, dm or api");
    return openSession(tm.id, kind, String(body?.place_key ?? `api:${newId("k")}`), body?.place ?? {});
  })
  .add("POST", "/v1/sessions/:id/submissions", async ({ params, body }) => {
    if (!(await getSession(params.id))) throw notFound("session");
    if (!body?.text?.trim()) throw bad("text is required");
    const { submissionId, run, created } = await submit({
      sessionId: params.id, personId: body.person_id ?? null, requestId: String(body.request_id ?? newId("rq")), text: body.text, source: "api",
    });
    if (created) await startRun(run.id);
    return { submission_id: submissionId, run_id: run.id, created };
  })
  .add("GET", "/v1/runs/:id", async ({ params }) => {
    const run = await getRun(params.id);
    if (!run) throw notFound("run");
    return { run, events: await runEvents(run.id) };
  })
  .add("POST", "/v1/approvals/:id", async ({ params, body }) => {
    if (!["approved", "denied"].includes(body?.decision)) throw bad("decision must be approved or denied");
    return answerApproval(params.id, { decision: body.decision, scope: body.scope ?? "once", personId: body.person_id ?? null });
  })
  .add("POST", "/v1/teammates/:slug/computer/exec", async ({ params, body }) => {
    const tm = await getTeammate(params.slug);
    if (!tm) throw notFound("teammate");
    if (!Array.isArray(body?.argv) || !body.argv.length) throw bad("argv (array of strings) is required");
    return vmExec(tm.id, body.argv.map(String), { timeoutMs: Number(body.timeout_ms ?? 60_000) });
  })
  .add("POST", "/v1/teammates/:slug/computer/sleep", async ({ params }) => {
    const tm = await getTeammate(params.slug);
    if (!tm) throw notFound("teammate");
    await vmSleep(tm.id, "admin");
    return { ok: true };
  })
  .add("GET", "/v1/slack/apps", async () => ({ apps: await listApps() }))
  .add("POST", "/v1/slack/apps", async ({ body }) => {
    const s = body?.secrets ?? {};
    if (!body?.app_id || !s.signing_secret || !s.client_id || !s.client_secret) throw bad("app_id and secrets.signing_secret, client_id, client_secret are required");
    let teammateId: string | null = null;
    if (body.teammate) { const tm = await getTeammate(String(body.teammate)); if (!tm) throw notFound("teammate"); teammateId = tm.id; }
    await saveApp({ app_id: body.app_id, teammate_id: teammateId, team_id: body.team_id ?? null, bot_user_id: body.bot_user_id ?? null, secrets: s });
    return { app_id: body.app_id, teammate_id: teammateId };
  })
  .add("POST", "/v1/schedules", async ({ body }) => {
    const tm = await getTeammate(String(body?.teammate ?? ""));
    if (!tm) throw notFound("teammate");
    if (!body?.cron || !body?.prompt) throw bad("cron and prompt are required");
    const session = await openSession(tm.id, "desk", `desk:${tm.id}`);
    const id = newId("sc");
    await pool.query("INSERT INTO schedules (id, teammate_id, session_id, cron, prompt, created_by) VALUES ($1, $2, $3, $4, $5, $6)", [id, tm.id, session.id, body.cron, body.prompt, body.person_id ?? null]);
    await syncSchedules();
    return { id, session_id: session.id };
  });

function authorized(header: string | undefined): boolean {
  const given = Buffer.from((header ?? "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(config.adminToken);
  return given.length === want.length && timingSafeEqual(given, want);
}

export function startApi(): Promise<Server> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://core");
    const route = router.match(req.method ?? "GET", url.pathname);
    if (!route) return send(res, 404, { error: "not found" });
    if (url.pathname !== "/healthz" && !authorized(req.headers.authorization)) return send(res, 401, { error: "admin token required" });
    try {
      const body = req.method === "GET" ? {} : await readJson(req);
      const out = await route.handler({ method: req.method!, path: url.pathname, params: route.params, query: url.searchParams, body, headers: req.headers });
      send(res, 200, out);
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      if (status >= 500) console.error("api error:", error);
      send(res, status, { error: status >= 500 ? "internal error" : (error as Error).message });
    }
  });
  return new Promise((resolve) => server.listen(config.apiPort, config.apiHost, () => resolve(server)));
}
