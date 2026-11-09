// Schedules and triggers (K11). The agent writes them through tools; code fires them and holds the rails:
// - cron runs at most hourly; a watch polls at most hourly; webhooks are exempt (they're events);
// - at most PEEBLO_TRIGGER_RUNS_PER_HOUR triggered runs per teammate per hour;
// - each run has its own budget (proxy/relay.ts) and posts only where it was allowed to (the origin, or a public
//   channel the teammate is in);
// - code skips a run only on objective no-change: a webhook whose event doesn't match the filter, a watch whose
//   result hash is unchanged. Otherwise the teammate wakes and decides for itself whether anything is worth saying;
// - the stored prompt is never consent: writes in a triggered run still go through the gate, and an approval waits
//   12 h for the owner, then counts as no;
// - each run is logged with findings none | some; a failure tells the creator.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { seal, unseal } from "./crypto.ts";
import { config } from "./config.ts";
import { pool } from "./db.ts";
import { startRun } from "./durable/runs.ts";
import { newId } from "./ids.ts";
import { appendEvent, onEvent } from "./store/events.ts";
import { openSession, submit } from "./store/sessions.ts";
import { getTeammate, type Teammate } from "./store/teammates.ts";
import type { SlackPlace } from "./slack/inbound.ts";

const RUNS_PER_HOUR = Number(process.env.PEEBLO_TRIGGER_RUNS_PER_HOUR ?? 6);
export type Kind = "cron" | "once" | "webhook" | "watch";
export type Schedule = { id: string; teammate_id: string; session_id: string; kind: Kind; name: string | null; cron: string | null; run_at: Date | null; prompt: string; output_to: any; budget_usd: string; filter: any; watch: any; state_hash: string | null; created_by: string | null; enabled: boolean; last_run_at: Date | null };

// At most hourly: a fixed minute (no */n or lists in the minute field), five fields.
export function cronProblem(cron: string): string | null {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return "a schedule is a 5-field cron like '0 21 * * *' (21:00 every day)";
  if (!/^\d{1,2}$/.test(f[0]) || Number(f[0]) > 59) return "schedules run at most once an hour: the minute field must be one number";
  return null;
}

// Where a schedule may post: the conversation it was made in, or a public channel the teammate's app is in.
export async function outputPlace(tm: Teammate, origin: SlackPlace | null, channel: string | null): Promise<{ place: any } | { problem: string }> {
  if (!channel || (origin && channel === origin.channel)) {
    if (!origin) return { place: {} };
    return { place: { slack: { ...origin, thread_ts: undefined, trigger_ts: undefined, direct: false } } };
  }
  const { slack } = await import("./slack/api.ts");
  if (!origin) return { problem: "a schedule made outside Slack can't post to a channel" };
  const info = await slack(origin.app_id, "conversations.info", { channel }).catch(() => null);
  if (!info?.channel || info.channel.is_private || info.channel.is_im) return { problem: "results can go to this conversation or to a public channel only" };
  if (!info.channel.is_member) return { problem: `${tm.config.name} isn't in that channel; invite it first` };
  return { place: { slack: { ...origin, channel, channel_type: "channel", thread_ts: undefined, trigger_ts: undefined, direct: false } } };
}

export async function createSchedule(tm: Teammate, by: string | null, s: { kind: Kind; name: string; prompt: string; cron?: string | null; runAt?: string | null; place: any; budgetUsd?: number; filter?: any; watch?: any; originRequest?: string | null }): Promise<{ id: string; secret?: string }> {
  const id = newId("sc");
  const session = await openSession(tm.id, "api", `schedule:${id}`, { ...s.place, schedule_id: id });
  const secret = s.kind === "webhook" ? randomBytes(24).toString("hex") : null;
  await pool.query(
    `INSERT INTO schedules (id, teammate_id, session_id, kind, name, cron, run_at, prompt, output_to, budget_usd, filter, watch, created_by, secret)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [id, tm.id, session.id, s.kind, s.name, s.cron ?? null, s.runAt ?? null, s.prompt, s.place, Math.min(1, s.budgetUsd ?? 0.05), s.filter ?? {}, s.watch ?? null, by, secret ? seal(secret) : null]);
  if (s.originRequest) await pool.query("UPDATE schedules SET origin_request = $2 WHERE id = $1", [id, s.originRequest.slice(0, 4000)]);
  if (s.kind === "cron") { const { syncSchedules } = await import("./durable/schedules.ts"); await syncSchedules(); }
  await appendEvent({ type: "schedule.created", data: { schedule_id: id, teammate_id: tm.id, kind: s.kind, name: s.name, by } });
  return { id, ...(secret ? { secret } : {}) };
}
export const hookUrl = (tm: Teammate, id: string) => `${config.publicUrl}/hooks/${tm.slug}/${id}`;

// One triggered run. Returns null when a rail skipped it (the reason is logged).
export async function fire(s: Schedule, extra: string, source: "schedule" | "webhook", key: string): Promise<string | null> {
  const recent = (await pool.query("SELECT count(*)::int AS n FROM submissions sub JOIN sessions se ON se.id = sub.session_id WHERE se.teammate_id = $1 AND sub.source IN ('schedule', 'webhook') AND sub.created_at > now() - interval '1 hour'", [s.teammate_id])).rows[0].n;
  if (recent >= RUNS_PER_HOUR) { await appendEvent({ type: "schedule.skipped", data: { schedule_id: s.id, reason: `hourly cap (${RUNS_PER_HOUR})` } }); return null; }
  const text = `${s.prompt}\n\n(This is a ${s.kind === "webhook" ? "triggered" : "scheduled"} run of "${s.name ?? s.id}". First decide whether anything is worth reporting; if not, end without posting.)${extra}`;
  const { run, created } = await submit({ sessionId: s.session_id, personId: s.created_by, requestId: `${source}:${s.id}:${key}`, text, source });
  await pool.query("UPDATE schedules SET last_run_at = now() WHERE id = $1", [s.id]);
  if (created) await startRun(run.id);
  return run.id;
}

// Webhooks: a signed POST to /hooks/<teammate>/<id>. GitHub's X-Hub-Signature-256, or X-Peeblo-Signature (the same
// HMAC), or a Bearer secret. Then the event filter (code, objective). The payload reaches the teammate as untrusted.
export async function handleHook(slug: string, id: string, headers: Record<string, string | string[] | undefined>, body: string): Promise<[number, string]> {
  const tm = await getTeammate(slug);
  const s = tm ? ((await pool.query("SELECT * FROM schedules WHERE id = $1 AND teammate_id = $2 AND kind = 'webhook' AND enabled", [id, tm.id])).rows[0] as Schedule & { secret: Buffer }) : null;
  if (!tm || !s) return [404, "not found"];
  const secret = unseal<string>(s.secret);
  const sig = String(headers["x-hub-signature-256"] ?? headers["x-peeblo-signature"] ?? "");
  const mine = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const bearer = String(headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const ok = (sig && sig.length === mine.length && timingSafeEqual(Buffer.from(sig), Buffer.from(mine))) || (bearer && bearer.length === secret.length && timingSafeEqual(Buffer.from(bearer), Buffer.from(secret)));
  if (!ok) return [401, "bad signature"];
  let payload: any = {};
  try { payload = JSON.parse(body); } catch { return [400, "not json"]; }
  const event = String(headers["x-github-event"] ?? payload.event ?? payload.type ?? "");
  if (event === "ping") return [200, "pong"];
  const miss = filterMiss(s.filter ?? {}, event, payload);
  if (miss) { await appendEvent({ type: "schedule.skipped", data: { schedule_id: s.id, reason: `filter: ${miss}`, event } }); return [202, "skipped: doesn't match the trigger's filter"]; }
  const delivery = String(headers["x-github-delivery"] ?? createHash("sha256").update(body).digest("hex").slice(0, 16));
  const summary = JSON.stringify(payload).slice(0, 4000).replaceAll("</untrusted>", "</ untrusted>");
  const run = await fire(s, `\n\nEvent: ${event || "webhook"}\n<untrusted source="webhook:${slug}/${s.name ?? s.id}">\n${summary}\n</untrusted>`, "webhook", delivery);
  return [202, run ? `run ${run}` : "skipped"];
}

// Provider endpoints: one stable URL per service (POST /hooks/source/stripe, …/pagerduty),
// registered with the service once and checked with that service's own signing secret (PEEBLO_HOOK_SECRET_<NAME>).
// An event wakes every trigger an agent made with that source whose filter matches; code only wakes, the agent decides.
const SOURCES: Record<string, (secret: string, h: Record<string, string | string[] | undefined>, body: string) => boolean> = {
  // Stripe-Signature: t=<unix>,v1=<hex hmac of "t.body">; at most 5 minutes old.
  stripe: (secret, h, body) => {
    const parts = Object.fromEntries(String(h["stripe-signature"] ?? "").split(",").map((p) => p.split("=") as [string, string]));
    if (!parts.t || !parts.v1 || Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
    const mine = createHmac("sha256", secret).update(`${parts.t}.${body}`).digest("hex");
    return String(h["stripe-signature"]).split(",").filter((p) => p.startsWith("v1=")).some((p) => p.slice(3).length === mine.length && timingSafeEqual(Buffer.from(p.slice(3)), Buffer.from(mine)));
  },
  // X-PagerDuty-Signature: v1=<hex hmac of body> (several, comma-separated, during secret rotation).
  pagerduty: (secret, h, body) => {
    const mine = createHmac("sha256", secret).update(body).digest("hex");
    return String(h["x-pagerduty-signature"] ?? "").split(",").map((p) => p.trim()).filter((p) => p.startsWith("v1=")).some((p) => p.slice(3).length === mine.length && timingSafeEqual(Buffer.from(p.slice(3)), Buffer.from(mine)));
  },
};
const sourceEvent = (source: string, payload: any) => (source === "pagerduty" ? String(payload?.event?.event_type ?? "") : String(payload?.type ?? ""));

export async function handleSourceHook(source: string, headers: Record<string, string | string[] | undefined>, body: string): Promise<[number, string]> {
  const check = SOURCES[source];
  const secret = process.env[`PEEBLO_HOOK_SECRET_${source.toUpperCase()}`];
  if (!check || !secret) return [404, "not found"];
  if (!check(secret, headers, body)) return [401, "bad signature"];
  let payload: any = {};
  try { payload = JSON.parse(body); } catch { return [400, "not json"]; }
  const event = sourceEvent(source, payload);
  await appendEvent({ type: "hook.received", data: { source, event, id: payload?.id ?? payload?.event?.id ?? null } });
  const triggers = (await pool.query("SELECT * FROM schedules WHERE kind = 'webhook' AND enabled AND filter->>'source' = $1", [source])).rows as (Schedule & { filter: any })[];
  const fired: string[] = [];
  for (const s of triggers) {
    const { source: _src, ...rest } = s.filter ?? {};
    const miss = filterMiss(rest, event, payload);
    if (miss) { await appendEvent({ type: "schedule.skipped", data: { schedule_id: s.id, reason: `filter: ${miss}`, event } }); continue; }
    const summary = JSON.stringify(payload).slice(0, 4000).replaceAll("</untrusted>", "</ untrusted>");
    const run = await fire(s, `\n\nEvent from ${source}: ${event}\n<untrusted source="webhook:${source}">\n${summary}\n</untrusted>`, "webhook", `${source}:${payload?.id ?? payload?.event?.id ?? createHash("sha256").update(body).digest("hex").slice(0, 16)}:${s.id}`);
    if (run) fired.push(run);
  }
  return [200, fired.length ? `woke ${fired.length}` : "no matching trigger"];
}

// {event: "deployment_status", "deployment_status.state": "success", "deployment.environment": "production"}
export function filterMiss(filter: Record<string, unknown>, event: string, payload: any): string | null {
  for (const [k, want] of Object.entries(filter)) {
    const got = k === "event" ? event : k.split(".").reduce((o: any, p) => (o == null ? undefined : o[p]), payload);
    if (Array.isArray(want) ? !want.map(String).includes(String(got)) : String(got) !== String(want)) return `${k} is ${JSON.stringify(got)}, wants ${JSON.stringify(want)}`;
  }
  return null;
}

// Watches: run a connector read on a timer; wake the teammate only when the result changed. The first poll is a
// baseline. Reads only (a watch can never write).
export async function pollWatch(s: Schedule): Promise<"baseline" | "unchanged" | "changed" | "failed"> {
  const tm = await getTeammate(s.teammate_id);
  if (!tm || !s.watch) return "failed";
  const { catalogFor, classify, executeTool } = await import("./connectors/mcp.ts");
  const t = (await catalogFor(tm.config)).tools.find((x) => x.server === s.watch.server && x.tool === s.watch.tool);
  if (!t || classify(t, s.watch.arguments ?? {}) !== "read") return watchFailed(s, `${s.watch.server}.${s.watch.tool} isn't a read tool this teammate has any more`);
  let err = "";
  const { data } = await executeTool(t, s.watch.arguments ?? {}).catch((e) => { err = (e as Error).message; return { data: null }; });
  if (data === null) return watchFailed(s, err || "the read returned nothing");
  const text = JSON.stringify(data).slice(0, 200_000);
  const hash = createHash("sha256").update(text).digest("hex");
  await pool.query("UPDATE schedules SET last_run_at = now(), state_hash = $2, failures = 0 WHERE id = $1", [s.id, hash]);
  if (!s.state_hash) { await appendEvent({ type: "schedule.watch", data: { schedule_id: s.id, result: "baseline" } }); return "baseline"; }
  if (s.state_hash === hash) { await appendEvent({ type: "schedule.skipped", data: { schedule_id: s.id, reason: "watch: no change" } }); return "unchanged"; }
  await appendEvent({ type: "schedule.watch", data: { schedule_id: s.id, result: "changed" } });
  await fire(s, `\n\nThe watched data changed (${s.watch.server}.${s.watch.tool}). Latest:\n<untrusted source="watch:${s.watch.server}">\n${text.slice(0, 4000)}\n</untrusted>`, "schedule", hash.slice(0, 16));
  return "changed";
}

// A failed watch waits its normal interval before the next try; after 3 failures in a row it is turned off and its
// creator is told.
async function watchFailed(s: Schedule, why: string): Promise<"failed"> {
  const n = Number((await pool.query("UPDATE schedules SET last_run_at = now(), failures = failures + 1 WHERE id = $1 RETURNING failures", [s.id])).rows[0]?.failures ?? 0);
  await appendEvent({ type: "schedule.skipped", data: { schedule_id: s.id, reason: `watch failed (${n} in a row): ${why.slice(0, 200)}` } });
  if (n >= 3) {
    await pool.query("UPDATE schedules SET enabled = false WHERE id = $1", [s.id]);
    await appendEvent({ type: "notify.owner", data: { schedule_id: s.id, kind: "watch_off", text: `I turned off the watch "${s.name ?? s.id}": it failed 3 times in a row (${why.slice(0, 200)}). Ask its teammate to set it up again when that's fixed.` } });
  }
  return "failed";
}

// Owner notices go to a person as a DM from Peeblo: the schedule's creator, else the teammate's owner. At most one
// notice of a kind per thing per hour.
const noticed = new Map<string, number>();
async function deliverNotice(d: { schedule_id?: string; teammate_id?: string; kind?: string; text?: string }): Promise<void> {
  const key = `${d.kind}:${d.schedule_id ?? d.teammate_id}`;
  if ((noticed.get(key) ?? 0) > Date.now() - 3_600_000) return;
  const row = d.schedule_id
    ? (await pool.query("SELECT s.created_by, t.owner_person, t.id AS teammate_id FROM schedules s JOIN teammates t ON t.id = s.teammate_id WHERE s.id = $1", [d.schedule_id])).rows[0]
    : (await pool.query("SELECT NULL AS created_by, owner_person, id AS teammate_id FROM teammates WHERE id = $1", [d.teammate_id])).rows[0];
  const personId = row?.created_by ?? row?.owner_person;
  if (!personId || !d.text) return;
  const { getPerson } = await import("./store/people.ts");
  const who = await getPerson(personId);
  const app = config.managerAppId || (await pool.query("SELECT a.app_id FROM slack_apps a JOIN teammates t ON t.id = a.teammate_id WHERE t.slug = 'peeblo' AND a.bot_user_id IS NOT NULL LIMIT 1")).rows[0]?.app_id;
  if (!who?.slack_user || !app) return;
  const { slack } = await import("./slack/api.ts");
  const dm: any = await slack(app, "conversations.open", { users: who.slack_user }).catch(() => null);
  if (!dm?.channel?.id) return;
  noticed.set(key, Date.now());
  await slack(app, "chat.postMessage", { channel: dm.channel.id, text: d.text }).catch((e) => console.error("notice:", (e as Error).message));
}

// The ticker: one-time schedules that are due, and watches whose hour has come.
export function installTriggers(): void {
  let ticking = false;
  setInterval(() => void (async () => {
    if (ticking) return;
    ticking = true;
    try {
    const due = (await pool.query(`SELECT * FROM schedules WHERE enabled AND ((kind = 'once' AND run_at <= now() AND last_run_at IS NULL) OR (kind = 'watch' AND (last_run_at IS NULL OR last_run_at < now() - make_interval(hours => greatest(1, coalesce((filter->>'every_hours')::int, 1))))))`)).rows as Schedule[];
    for (const s of due) {
      if (s.kind === "once") { await fire(s, "", "schedule", "once"); await pool.query("UPDATE schedules SET enabled = false WHERE id = $1", [s.id]); }
      else await pollWatch(s).catch(() => null);
    }
    } finally { ticking = false; }
  })().catch((e) => console.error("triggers:", (e as Error).message)), 60_000).unref();

  onEvent(async (e) => {
    if (e.type === "notify.owner") await deliverNotice(e.data as any).catch((x) => console.error("notice:", (x as Error).message));
  });

  // Each triggered run is logged with whether it found anything; a failure tells whoever made the trigger.
  onEvent(async (e) => {
    if (e.type !== "run.finished" && e.type !== "run.failed") return;
    const src = (await pool.query("SELECT s.request_id, s.source FROM runs r JOIN submissions s ON s.id = r.submission_id WHERE r.id = $1", [e.run_id])).rows[0];
    if (!src || !["schedule", "webhook"].includes(src.source)) return;
    const id = String(src.request_id).split(":")[1];
    const posted = Number((await pool.query("SELECT count(*)::int AS n FROM events WHERE run_id = $1 AND type IN ('slack.post', 'slack.post.blocks')", [e.run_id])).rows[0].n);
    await appendEvent({ type: "schedule.ran", data: { schedule_id: id, run_id: e.run_id, findings: posted ? "some" : "none", ok: e.type === "run.finished" } });
    if (e.type === "run.failed") await appendEvent({ type: "notify.owner", data: { schedule_id: id, kind: "schedule_failed", text: `A scheduled job failed: ${String((e.data as any).error ?? "").slice(0, 200)}` } });
  });
}
