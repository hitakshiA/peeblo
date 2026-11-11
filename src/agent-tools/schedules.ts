// Schedules, webhook triggers and watches: the teammate writes the prompt each run follows, including how to
// decide whether anything is worth reporting. Code holds the rails (src/triggers.ts).
import { config } from "../config.ts";
import { pool } from "../db.ts";
import { getSession } from "../store/sessions.ts";
import { createSchedule, cronProblem, hookUrl, outputPlace } from "../triggers.ts";
import { object } from "./schema.ts";
import type { AgentTool, ToolContext } from "./types.ts";

// The person's own words behind this schedule (what the reviewer counts as intent for its runs).
const originRequest = async (ctx: ToolContext) => {
  if (!ctx.runId) return null;
  const { personWords } = await import("../approvers.ts");
  return (await personWords(ctx.runId)).asks.join("\n") || null;
};
const origin = async (ctx: ToolContext) => ((await getSession(ctx.sessionId))?.place as any)?.slack ?? null;
const promptHelp = "What to do each run, how to tell whether anything is worth reporting (if not, post nothing), and when to stop or ask.";
async function list(ctx: ToolContext): Promise<string> {
  const { rows } = await pool.query("SELECT id, kind, name, cron, run_at, enabled, last_run_at FROM schedules WHERE teammate_id = $1 ORDER BY created_at DESC LIMIT 20", [ctx.teammate.id]);
  return rows.map((r) => `- ${r.id} ${r.kind} "${r.name ?? ""}" ${r.cron ?? r.run_at?.toISOString?.() ?? ""} ${r.enabled ? "on" : "paused"}${r.last_run_at ? `, last ran ${new Date(r.last_run_at).toISOString().slice(0, 16)}` : ""}`).join("\n") || "No schedules.";
}
async function setEnabled(ctx: ToolContext, id: string, on: boolean | null): Promise<string> {
  // Only the person who set it up, the teammate's owner or an admin may pause, resume or remove a schedule.
  const sc = (await pool.query("SELECT created_by FROM schedules WHERE id = $1 AND teammate_id = $2", [id, ctx.teammate.id])).rows[0];
  if (!sc) return `No schedule ${id}.`;
  const { isOtariAdmin } = await import("../authority.ts");
  const p = ctx.person?.id ?? null;
  if (!p || !(p === sc.created_by || p === ctx.teammate.owner_person || isOtariAdmin(ctx.person))) return `Only the person who set up ${id}, ${ctx.teammate.config.name}'s owner or an admin can change it.`;
  const r = on === null
    ? await pool.query("DELETE FROM schedules WHERE id = $1 AND teammate_id = $2 RETURNING kind", [id, ctx.teammate.id])
    : await pool.query("UPDATE schedules SET enabled = $3 WHERE id = $1 AND teammate_id = $2 RETURNING kind", [id, ctx.teammate.id, on]);
  if (!r.rowCount) return `No schedule ${id}.`;
  if (r.rows[0].kind === "cron") { const { syncSchedules } = await import("../durable/schedules.ts"); await syncSchedules(); }
  return on === null ? `Removed ${id}.` : `${on ? "Resumed" : "Paused"} ${id}.`;
}

export const scheduleTools: AgentTool[] = [
  {
    name: "schedule",
    description: "Run a job on a schedule: every so often (cron, at most hourly) or once at a time. Results go to this conversation or a public channel you're in.",
    input_schema: object({
      action: { type: "string", enum: ["create", "list", "pause", "resume", "remove"] },
      id: { type: ["string", "null"] },
      name: { type: ["string", "null"] },
      cron: { type: ["string", "null"], description: "5-field cron in the person's own time zone (it runs in theirs, daylight saving included), e.g. '0 9 * * 1' for 9:00 every Monday their time; at most hourly." },
      once_at: { type: ["string", "null"], description: "An ISO time for a single run." },
      prompt: { type: ["string", "null"], description: promptHelp },
      channel: { type: ["string", "null"], description: "A public channel id for the results; empty for this conversation." },
      budget_usd: { type: ["number", "null"], minimum: 0, maximum: config.routineMaxUsd, description: `Per run; default $${config.routineBudgetUsd}. Hard work (a strong model, a long job) needs more.` },
    }),
    kind: "local",
    // Setting one up acts on this teammate's behalf later; results in a channel post outside this conversation.
    outward: (_ctx, a) => (a.action === "create" ? (a.channel ? "outside_thread" : "write") : null),
    async run(ctx, a) {
      if (a.action === "list") return { text: await list(ctx) };
      if (a.action !== "create") return { text: a.id ? await setEnabled(ctx, a.id, a.action === "remove" ? null : a.action === "resume") : "Which schedule? Give its id (list shows them).", isError: !a.id };
      if (!a.prompt?.trim() || !a.name) return { text: "A schedule needs a name and a prompt.", isError: true };
      if (!a.cron && !a.once_at) return { text: "Give a cron or a once_at time.", isError: true };
      if (a.cron) { const p = cronProblem(a.cron); if (p) return { text: p, isError: true }; }
      if (a.once_at && !(new Date(a.once_at).getTime() > Date.now())) return { text: "once_at must be a time in the future.", isError: true };
      const out = await outputPlace(ctx.teammate, await origin(ctx), a.channel ?? null);
      if ("problem" in out) return { text: out.problem, isError: true };
      const tz = ctx.person ? (await pool.query<{ tz: string | null }>("SELECT tz FROM people WHERE id = $1", [ctx.person.id])).rows[0]?.tz ?? null : null;
      const s = await createSchedule(ctx.teammate, ctx.person?.id ?? null, { tz, originRequest: await originRequest(ctx), kind: a.cron ? "cron" : "once", name: a.name, prompt: a.prompt, cron: a.cron, runAt: a.once_at, place: out.place, budgetUsd: a.budget_usd ?? config.routineBudgetUsd });
      return { text: `Scheduled "${a.name}" (id ${s.id}: for your tools only, never in a reply) ${a.cron ? `on ${a.cron} (${tz ?? "UTC"})` : `for ${a.once_at}`}, with a budget of $${(a.budget_usd ?? config.routineBudgetUsd).toFixed(2)} a run. Writes it makes still need the usual approvals.`, data: { id: s.id } };
    },
  },
  {
    name: "schedule_list",
    description: "List your schedules, triggers and watches: name, when it runs, and whether it's on.",
    input_schema: object({}),
    kind: "read",
    async run(ctx) {
      const rows = (await pool.query("SELECT kind, name, cron, run_at, enabled, last_run_at, tz AS cron_tz, filter AS source FROM schedules WHERE teammate_id = $1 ORDER BY created_at DESC LIMIT 20", [ctx.teammate.id])).rows;
      if (!rows.length) return { text: "You have no schedules, triggers or watches." };
      // One-off times in the asker's own time zone, worked out here (models get offsets wrong), with UTC beside them.
      const tz = ctx.person ? (await pool.query<{ tz: string | null }>("SELECT tz FROM people WHERE id = $1", [ctx.person.id])).rows[0]?.tz ?? null : null;
      const at = (d: Date) => `${tz ? `${new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(d)} ${tz} (` : ""}${d.toISOString().slice(0, 16).replace("T", " ")} UTC${tz ? ")" : ""}`;
      return { text: rows.map((r: any) => `- ${r.name ?? "(unnamed)"}: ${r.kind === "cron" ? `${r.cron} (cron, ${r.cron_tz ?? "UTC"})` : r.kind === "once" ? `once at ${at(new Date(r.run_at))}` : r.kind}${r.kind === "once" && r.last_run_at ? " (done: it ran)" : r.enabled ? "" : " (paused)"}`).join("\n") };
    },
  },
  {
    name: "webhook_trigger",
    description: "Run a job when a service sends an event, when a person asks (\"if we get a dispute, tell me in #finance\"). For Stripe and PagerDuty set source (an admin points the service at Peeblo once; the result says if that is still to do) and a filter on the event type, e.g. {type: 'charge.dispute.created'} or {event: 'incident.triggered'}; for others (GitHub) you get a URL to give the service. Tag only the people the person asked you to.",
    input_schema: object({
      action: { type: "string", enum: ["create", "list", "remove"] },
      id: { type: ["string", "null"] },
      name: { type: ["string", "null"] },
      prompt: { type: ["string", "null"], description: promptHelp },
      source: { type: ["string", "null"], enum: ["stripe", "pagerduty", null], description: "Stripe or PagerDuty (their events come to Peeblo once an admin sets up the webhook)." },
      filter: { type: ["object", "null"], description: "Fields the event must match, e.g. {event: 'deployment_status', 'deployment_status.state': 'success'}.", additionalProperties: true } as any,
      channel: { type: ["string", "null"] },
      budget_usd: { type: ["number", "null"], minimum: 0, maximum: config.routineMaxUsd, description: `Per run; default $${config.routineBudgetUsd}. Hard work (a strong model, a long job) needs more.` },
    }),
    kind: "local",
    outward: (_ctx, a) => (a.action === "create" ? "write" : null),
    async run(ctx, a) {
      if (a.action === "list") return { text: await list(ctx) };
      if (a.action === "remove") return { text: a.id ? await setEnabled(ctx, a.id, null) : "Which trigger?", isError: !a.id };
      if (!a.prompt?.trim() || !a.name) return { text: "A trigger needs a name and a prompt.", isError: true };
      const out = await outputPlace(ctx.teammate, await origin(ctx), a.channel ?? null);
      if ("problem" in out) return { text: out.problem, isError: true };
      const s = await createSchedule(ctx.teammate, ctx.person?.id ?? null, { originRequest: await originRequest(ctx), kind: "webhook", name: a.name, prompt: a.prompt, place: out.place, budgetUsd: a.budget_usd ?? config.routineBudgetUsd, filter: { ...(a.filter ?? {}), ...(a.source ? { source: a.source } : {}) } });
      if (a.source) {
        const on = `Trigger "${a.name}" (id ${s.id}: for your tools only, never in a reply) is on: ${a.source} events${a.filter ? ` matching ${JSON.stringify(a.filter)}` : ""} wake you with the event.`;
        // The service has to send its events to Peeblo once (an admin step); until then the trigger never fires.
        if (process.env[`PEEBLO_HOOK_SECRET_${a.source.toUpperCase()}`]) return { text: on, data: { id: s.id } };
        const where = a.source === "stripe" ? "Stripe → Developers → Webhooks → Add endpoint" : "PagerDuty → Integrations → Generic Webhooks (v3) → New webhook";
        return { text: `${on}
But ${a.source} isn't sending events to Peeblo yet, so it won't fire until an admin does this once: in ${where}, send events to ${config.publicUrl}/hooks/source/${a.source}, then put that webhook's signing secret in Peeblo's .env as PEEBLO_HOOK_SECRET_${a.source.toUpperCase()} and restart Peeblo. Tell the person this in plain words.`, data: { id: s.id } };
      }
      return { text: `Trigger "${a.name}" (id ${s.id}: for your tools only, never in a reply) is ready. Give the service this URL: ${hookUrl(ctx.teammate, s.id)}\nIts signing secret is shown to admins in the console (Triggers); for GitHub, use it as the webhook secret.`, data: { id: s.id, url: hookUrl(ctx.teammate, s.id) } };
    },
  },
  {
    name: "watch",
    description: "Watch something through one of your connectors (a read, e.g. error counts or a ticket queue) every few hours; you're woken only when the result changes.",
    input_schema: object({
      action: { type: "string", enum: ["create", "list", "remove"] },
      id: { type: ["string", "null"] },
      name: { type: ["string", "null"] },
      server: { type: ["string", "null"], description: "The connector, e.g. github, posthog, linear." },
      tool: { type: ["string", "null"], description: "Its read tool, e.g. list_issues." },
      arguments: { type: ["object", "null"], additionalProperties: true } as any,
      every_hours: { type: ["integer", "null"], minimum: 1, maximum: 168 },
      prompt: { type: ["string", "null"], description: promptHelp },
      channel: { type: ["string", "null"] },
    }),
    kind: "local",
    outward: (_ctx, a) => (a.action === "create" ? "write" : null),
    async run(ctx, a) {
      if (a.action === "list") return { text: await list(ctx) };
      if (a.action === "remove") return { text: a.id ? await setEnabled(ctx, a.id, null) : "Which watch?", isError: !a.id };
      if (!a.name || !a.server || !a.tool || !a.prompt) return { text: "A watch needs a name, a connector (server), its read tool, and a prompt.", isError: true };
      if (!ctx.teammate.config.connectors.includes(a.server)) return { text: `${a.server} isn't one of your connectors.`, isError: true };
      const out = await outputPlace(ctx.teammate, await origin(ctx), a.channel ?? null);
      if ("problem" in out) return { text: out.problem, isError: true };
      const s = await createSchedule(ctx.teammate, ctx.person?.id ?? null, { originRequest: await originRequest(ctx), kind: "watch", name: a.name, prompt: a.prompt, place: out.place, filter: { every_hours: Math.max(1, a.every_hours ?? 1) }, watch: { server: a.server, tool: a.tool, arguments: a.arguments ?? {} } });
      return { text: `Watching ${a.server}.${a.tool} every ${Math.max(1, a.every_hours ?? 1)} h as "${a.name}" (id ${s.id}: for your tools only, never in a reply); you'll be woken only when it changes.`, data: { id: s.id } };
    },
  },
];
