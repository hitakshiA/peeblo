// Schedules, webhook triggers and watches (K11): the teammate writes the prompt each run follows, including how to
// decide whether anything is worth reporting. Code holds the rails (src/triggers.ts).
import { pool } from "../db.ts";
import { getSession } from "../store/sessions.ts";
import { createSchedule, cronProblem, hookUrl, outputPlace } from "../triggers.ts";
import { object } from "./schema.ts";
import type { AgentTool, ToolContext } from "./types.ts";

const origin = async (ctx: ToolContext) => ((await getSession(ctx.sessionId))?.place as any)?.slack ?? null;
const promptHelp = "What to do each run, how to tell whether anything is worth reporting (if not, post nothing), and when to stop or ask.";
async function list(ctx: ToolContext): Promise<string> {
  const { rows } = await pool.query("SELECT id, kind, name, cron, run_at, enabled, last_run_at FROM schedules WHERE teammate_id = $1 ORDER BY created_at DESC LIMIT 20", [ctx.teammate.id]);
  return rows.map((r) => `- ${r.id} ${r.kind} "${r.name ?? ""}" ${r.cron ?? r.run_at?.toISOString?.() ?? ""} ${r.enabled ? "on" : "paused"}${r.last_run_at ? `, last ran ${new Date(r.last_run_at).toISOString().slice(0, 16)}` : ""}`).join("\n") || "No schedules.";
}
async function setEnabled(ctx: ToolContext, id: string, on: boolean | null): Promise<string> {
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
      cron: { type: ["string", "null"], description: "5-field cron in UTC, e.g. '0 21 * * *' for 21:00 every day; at most hourly." },
      once_at: { type: ["string", "null"], description: "An ISO time for a single run." },
      prompt: { type: ["string", "null"], description: promptHelp },
      channel: { type: ["string", "null"], description: "A public channel id for the results; empty for this conversation." },
      budget_usd: { type: ["number", "null"], minimum: 0, maximum: 1 },
    }),
    kind: "local",
    async run(ctx, a) {
      if (a.action === "list") return { text: await list(ctx) };
      if (a.action !== "create") return { text: a.id ? await setEnabled(ctx, a.id, a.action === "remove" ? null : a.action === "resume") : "Which schedule? Give its id (list shows them).", isError: !a.id };
      if (!a.prompt?.trim() || !a.name) return { text: "A schedule needs a name and a prompt.", isError: true };
      if (!a.cron && !a.once_at) return { text: "Give a cron or a once_at time.", isError: true };
      if (a.cron) { const p = cronProblem(a.cron); if (p) return { text: p, isError: true }; }
      if (a.once_at && !(new Date(a.once_at).getTime() > Date.now())) return { text: "once_at must be a time in the future.", isError: true };
      const out = await outputPlace(ctx.teammate, await origin(ctx), a.channel ?? null);
      if ("problem" in out) return { text: out.problem, isError: true };
      const s = await createSchedule(ctx.teammate, ctx.person?.id ?? null, { kind: a.cron ? "cron" : "once", name: a.name, prompt: a.prompt, cron: a.cron, runAt: a.once_at, place: out.place, budgetUsd: a.budget_usd ?? 0.05 });
      return { text: `Scheduled "${a.name}" (${s.id}) ${a.cron ? `on ${a.cron} (UTC)` : `for ${a.once_at}`}, with a budget of $${(a.budget_usd ?? 0.05).toFixed(2)} a run. Writes it makes still need the usual approvals.`, data: { id: s.id } };
    },
  },
  {
    name: "webhook_trigger",
    description: "Run a job when a service sends an event (e.g. 'after every deploy': GitHub deployment_status). Returns the URL to give the service; a filter keeps only the events you want.",
    input_schema: object({
      action: { type: "string", enum: ["create", "list", "remove"] },
      id: { type: ["string", "null"] },
      name: { type: ["string", "null"] },
      prompt: { type: ["string", "null"], description: promptHelp },
      filter: { type: ["object", "null"], description: "Fields the event must match, e.g. {event: 'deployment_status', 'deployment_status.state': 'success'}.", additionalProperties: true } as any,
      channel: { type: ["string", "null"] },
      budget_usd: { type: ["number", "null"], minimum: 0, maximum: 1 },
    }),
    kind: "local",
    async run(ctx, a) {
      if (a.action === "list") return { text: await list(ctx) };
      if (a.action === "remove") return { text: a.id ? await setEnabled(ctx, a.id, null) : "Which trigger?", isError: !a.id };
      if (!a.prompt?.trim() || !a.name) return { text: "A trigger needs a name and a prompt.", isError: true };
      const out = await outputPlace(ctx.teammate, await origin(ctx), a.channel ?? null);
      if ("problem" in out) return { text: out.problem, isError: true };
      const s = await createSchedule(ctx.teammate, ctx.person?.id ?? null, { kind: "webhook", name: a.name, prompt: a.prompt, place: out.place, budgetUsd: a.budget_usd ?? 0.05, filter: a.filter ?? {} });
      return { text: `Trigger "${a.name}" (${s.id}) is ready. Give the service this URL: ${hookUrl(ctx.teammate, s.id)}\nIts signing secret is shown to admins in the console (Triggers); for GitHub, use it as the webhook secret.`, data: { id: s.id, url: hookUrl(ctx.teammate, s.id) } };
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
    async run(ctx, a) {
      if (a.action === "list") return { text: await list(ctx) };
      if (a.action === "remove") return { text: a.id ? await setEnabled(ctx, a.id, null) : "Which watch?", isError: !a.id };
      if (!a.name || !a.server || !a.tool || !a.prompt) return { text: "A watch needs a name, a connector (server), its read tool, and a prompt.", isError: true };
      if (!ctx.teammate.config.connectors.includes(a.server)) return { text: `${a.server} isn't one of your connectors.`, isError: true };
      const out = await outputPlace(ctx.teammate, await origin(ctx), a.channel ?? null);
      if ("problem" in out) return { text: out.problem, isError: true };
      const s = await createSchedule(ctx.teammate, ctx.person?.id ?? null, { kind: "watch", name: a.name, prompt: a.prompt, place: out.place, filter: { every_hours: Math.max(1, a.every_hours ?? 1) }, watch: { server: a.server, tool: a.tool, arguments: a.arguments ?? {} } });
      return { text: `Watching ${a.server}.${a.tool} every ${Math.max(1, a.every_hours ?? 1)} h as "${a.name}" (${s.id}); you'll be woken only when it changes.`, data: { id: s.id } };
    },
  },
];
