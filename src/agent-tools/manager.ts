// Peeblo's own tools as the crew's manager (K2–K6, K17, K18). The asker, payer, thread and owner come from the
// session (K6); authority is checked in code. Hiring is the hiring-a-teammate skill plus these tools: the agent
// talks and drafts, and the ID card is the one approval, on the finished result (K4).
import { config } from "../config.ts";
import { pool } from "../db.ts";
import { callTeammate } from "../chains.ts";
import { isOtariAdmin, mayManageTeammate } from "../authority.ts";
import { teammateSpend, usd } from "../otari/spend.ts";
import { appendEvent } from "../store/events.ts";
import { openSession, submit, getSession } from "../store/sessions.ts";
import { createTeammate, getTeammate, listTeammates, updateTeammate, validateConfig, type Teammate, type TeammateConfig } from "../store/teammates.ts";
import { slack } from "../slack/api.ts";
import { getApp } from "../ingress/apps.ts";
import { createTeammateApp } from "../slack/admin.ts";
import { COLORS, facePng, idCardPng, pickFace, publishCard, SHAPES } from "../slack/idcard.ts";
import type { SlackPlace } from "../slack/inbound.ts";
import { object } from "./schema.ts";
import type { AgentTool, ToolContext } from "./types.ts";

const MODES = ["ask", "auto", "trusted", "yolo"] as const;
// A teammate by slug or by name (people and models say "Moss", not "moss").
export async function findTeammate(nameOrSlug: string): Promise<Teammate | null> {
  const direct = await getTeammate(nameOrSlug.toLowerCase().trim());
  if (direct) return direct;
  const all = await listTeammates();
  return all.find((t) => t.config.name.toLowerCase() === nameOrSlug.toLowerCase().trim()) ?? null;
}
// The teammate's own Slack app, if it is installed in this workspace.
async function ownApp(teammateId: string, team?: string): Promise<string | null> {
  const ids = (await pool.query("SELECT app_id FROM slack_apps WHERE teammate_id = $1", [teammateId])).rows.map((r) => r.app_id);
  for (const id of ids) { const a = await getApp(id); if (a?.secrets.bot_token && (!team || a.team_id === team)) return id; }
  return null;
}
const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 31) || "teammate";
const placeOf = async (ctx: ToolContext): Promise<SlackPlace | null> => ((await getSession(ctx.sessionId))?.place as any)?.slack ?? null;
const hireSpec = {
  name: { type: "string", description: "A short first name, e.g. Ledger." },
  role: { type: "string", description: "What it does, for whom, e.g. 'Watches Stripe refunds for Maya'." },
  instructions: { type: ["string", "null"], description: "Standing instructions, in the person's words." },
  model: { type: ["string", "null"], description: "An open-weight model id from routing_recommend; empty for the worker default." },
  budget_usd: { type: "number", minimum: 0, maximum: 500, description: "Monthly budget in USD." },
  tools: { type: "array", items: { type: "string", enum: ["web", "code", "computer"] }, maxItems: 3 },
  connectors: { type: "array", items: { type: "string" }, maxItems: 10, description: "Otari MCP server names, e.g. linear, posthog, stripe." },
  mode: { type: ["string", "null"], enum: [...MODES, null] },
  computer_size: { type: ["string", "null"], enum: ["small", "large", null], description: "large only for teammates that browse websites." },
  face: { type: ["string", "null"], enum: [...SHAPES, null] },
  color: { type: ["string", "null"], enum: [...COLORS, null] },
};
function configFrom(a: any): Partial<TeammateConfig> {
  return {
    name: a.name, role: a.role, instructions: a.instructions ?? "", model: { default: a.model || "deepseek/deepseek-v4.1-flash-1017", fallback: "xiaomi/mimo-v2.6-pro" },
    budget: { monthly_usd: a.budget_usd }, tools: a.tools ?? [], connectors: a.connectors ?? [], mode: a.mode ?? "auto",
    computer: { size: a.computer_size ?? "small", allowed_hosts: [] } as any,
  };
}

// Posts as a teammate that has no app of its own yet, through Peeblo's app with its name and face.
export async function postAs(place: SlackPlace, tm: Teammate, text: string, blocks?: any[]): Promise<void> {
  const face = config.publicUrl ? `${config.publicUrl}/faces/${tm.slug}.png` : undefined;
  await slack(place.app_id, "chat.postMessage", { channel: place.channel, thread_ts: place.thread_ts, text, ...(blocks ? { blocks } : {}), username: tm.config.name, ...(face ? { icon_url: face } : {}) });
}

export const managerTools: AgentTool[] = [
  {
    name: "crew_status",
    description: "The crew right now: each teammate's role, model, budget used, approval mode, Slack app, and its latest job.",
    input_schema: object({}),
    kind: "read",
    async run() {
      const tms = (await listTeammates()).filter((t) => t.slug !== "peeblo" && !t.slug.startsWith("eval-") && !t.slug.startsWith("vm-") && !t.slug.endsWith("-check"));
      const lines: string[] = [];
      for (const t of tms) {
        const s = await teammateSpend(t).catch(() => null);
        const app = { installed: Boolean(await ownApp(t.id)) };
        const last = (await pool.query("SELECT r.status, r.created_at FROM runs r JOIN sessions s ON s.id = r.session_id WHERE s.teammate_id = $1 ORDER BY r.created_at DESC LIMIT 1", [t.id])).rows[0];
        lines.push(`- ${t.config.name} (${t.slug}): ${t.config.role}. ${t.config.model.default}. ${s ? `${usd(s.spent)} of ${usd(s.cap)}` : `$${t.config.budget.monthly_usd}/mo`}. ${t.config.mode} mode. ${app?.installed ? "In Slack" : "No Slack app yet"}. Last job: ${last ? `${last.status} ${new Date(last.created_at).toISOString().slice(0, 16)}` : "none"}.`);
      }
      return { text: lines.join("\n") || "No teammates yet." };
    },
  },
  {
    name: "ask_human",
    description: "Ask the person a clarifying question you need answered before you can do the work (at most 2 at once). Their reply arrives as their next message; end your turn after asking.",
    input_schema: object({ questions: { type: "array", items: { type: "string" }, maxItems: 2 } }),
    kind: "read",
    async run(ctx, a) {
      const text = a.questions.length === 1 ? a.questions[0] : a.questions.map((q: string, i: number) => `${i + 1}. ${q}`).join("\n");
      await appendEvent({ sessionId: ctx.sessionId, runId: ctx.runId, type: "slack.post", data: { text } });
      return { text: "Asked. End your turn now; their answer comes as the next message." };
    },
  },
  {
    name: "teammate_hire",
    description: "Hire a teammate: shows the person its ID card for one approval, then creates it (its config, Otari key and budget, Slack app and face) and introduces it. Draft first in conversation; call this with the finished spec.",
    input_schema: object(hireSpec),
    kind: "write",
    authorize(ctx, a) {
      if (!ctx.person) return "Hiring needs a person to own the teammate.";
      try { validateConfig(configFrom(a)); } catch (e) { return `The spec isn't valid: ${(e as Error).message}`; }
      return null;
    },
    async describe(ctx, a) {
      // The approval card is the finished ID card.
      const place = await placeOf(ctx);
      const fake = { id: "tm_preview", slug: slugOf(a.name), owner_person: ctx.person?.id ?? null, version: 1, config: validateConfig(configFrom(a)), created_at: new Date() } as Teammate;
      const face = pickFace(fake.slug, a.face, a.color);
      const card = await publishCard(await idCardPng(fake, face, ctx.person?.display_name ?? "you")).catch(() => null);
      void place;
      return { kind: "hire", approvers: ctx.person ? [ctx.person.id] : [], id_card_url: card, summary: `${a.name} · ${a.role} · ${fake.config.model.default} · $${a.budget_usd}/month · ${fake.config.mode} mode · tools: ${[...(a.tools ?? []), ...(a.connectors ?? [])].join(", ") || "none"}` };
    },
    async run(ctx, a) {
      let slug = slugOf(a.name);
      if (await getTeammate(slug)) slug = `${slug}-${Math.random().toString(36).slice(2, 5)}`;
      const tm = await createTeammate(slug, configFrom(a), { personId: ctx.person?.id ?? null, label: `hired by ${ctx.person?.display_name ?? "a person"} through Peeblo` });
      const face = pickFace(slug, a.face, a.color);
      const place = await placeOf(ctx);
      await pool.query("INSERT INTO hires (teammate_id, hired_by, place, avatar) VALUES ($1, $2, $3, $4)", [tm.id, ctx.person?.id ?? null, place ? { slack: place } : {}, face]);
      let install: string | null = null;
      let appNote = "";
      try {
        const app = await createTeammateApp(tm, face.color, await facePng(face));
        install = app.installUrl;
        await pool.query("UPDATE hires SET app_id = $2, install_url = $3 WHERE teammate_id = $1", [tm.id, app.appId, install]);
      } catch (e) { appNote = ` Its own Slack app couldn't be made yet (${(e as Error).message.slice(0, 120)}); it works through Peeblo meanwhile.`; }
      await appendEvent({ sessionId: ctx.sessionId, runId: ctx.runId, type: "teammate.hired", data: { teammate_id: tm.id, slug, by: ctx.person?.id ?? null, app: Boolean(install) } });
      if (place) {
        await postAs(place, tm, `Hi! I'm ${tm.config.name}, ${tm.config.role}. I start now and work right here; ask me anything in this thread.`, [
          { type: "section", text: { type: "mrkdwn", text: `*Hi! I'm ${tm.config.name}*, ${tm.config.role}.\nI run on ${tm.config.model.default}, with a budget of $${tm.config.budget.monthly_usd} a month, in ${tm.config.mode} mode. Every reply I give is signed with what it cost.` } },
          ...(install ? [{ type: "actions", elements: [{ type: "button", style: "primary", text: { type: "plain_text", text: `Add ${tm.config.name} to Slack` }, url: install, action_id: "install" }] }] : []),
          { type: "context", elements: [{ type: "mrkdwn", text: install ? "Adding me gives me my own name in the sidebar and my own DMs. Until then I answer here, through Peeblo." : "I answer here, through Peeblo." }] },
        ]).catch(() => null);
      }
      return { text: `Hired ${tm.config.name} (${slug}).${install ? " Its Add to Slack button is in the thread." : ""}${appNote} To give it its first job, use delegate.`, data: { teammate: slug, install_url: install, app_error: appNote || null } };
    },
  },
  {
    name: "teammate_update",
    description: "Change a teammate's setup by talking: instructions, model, mode (ask/auto/trusted/yolo), tools, connectors, budget or computer size. Lowering applies at once; raising a capability asks first. Only its owner or an admin can change it.",
    input_schema: object({
      teammate: { type: "string" },
      field: { type: "string", enum: ["instructions", "model", "mode", "tools", "connectors", "budget_usd", "computer_size"] },
      value: { type: "string", description: "The new value; lists comma-separated." },
      reason: { type: "string" },
    }),
    kind: "local",
    async authorize(ctx, a) {
      const t = await findTeammate(a.teammate);
      if (!t) return `There's no teammate called ${a.teammate}; crew_status lists them.`;
      if (!mayManageTeammate(t, ctx.person)) return `Only ${t.config.name}'s owner or an admin can change it.`;
      if (a.field === "mode" && a.value === "yolo" && !isOtariAdmin(ctx.person)) return "Only an admin can set YOLO mode.";
      return null;
    },
    async gate(ctx, a) {
      const t = (await findTeammate(a.teammate))!;
      const c = t.config;
      const list = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);
      const raises = a.field === "mode" ? MODES.indexOf(a.value) > MODES.indexOf(c.mode)
        : a.field === "budget_usd" ? Number(a.value) > c.budget.monthly_usd
        : a.field === "tools" ? list(a.value).some((x) => !c.tools.includes(x))
        : a.field === "connectors" ? list(a.value).some((x) => !c.connectors.includes(x))
        : a.field === "computer_size" ? a.value === "large" && c.computer?.size !== "large"
        : a.field === "model";
      return raises ? { ask: `${ctx.person?.display_name ?? "Someone"} wants to change ${c.name}'s ${a.field.replace("_usd", "")} to ${a.value} (${a.reason}).` } : null;
    },
    async run(ctx, a) {
      const t = (await findTeammate(a.teammate))!;
      const list = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);
      const patch: any = a.field === "instructions" ? { instructions: a.value } : a.field === "model" ? { model: { default: a.value } }
        : a.field === "mode" ? { mode: a.value } : a.field === "tools" ? { tools: list(a.value) } : a.field === "connectors" ? { connectors: list(a.value) }
        : a.field === "budget_usd" ? { budget: { monthly_usd: Number(a.value) } } : { computer: { ...t.config.computer, size: a.value } };
      const next = await updateTeammate(t.slug, patch, { label: `${ctx.person?.display_name ?? "a person"} via Peeblo` }, a.reason);
      return { text: `${t.config.name} is now at version ${next.version}: ${a.field} = ${a.value}. Running conversations keep their setup; new ones use it (a lower mode applies at once).` };
    },
  },
  {
    name: "delegate",
    description: "Hand a job to a teammate: say what and why, never how. It works in this same thread, billed to the person who asked.",
    input_schema: object({
      teammate: { type: "string" },
      objective: { type: "string", description: "What done looks like, and why it matters." },
      context: { type: ["string", "null"], description: "Links and facts it needs." },
      constraints: { type: ["string", "null"] },
      output_shape: { type: ["string", "null"], description: "What to hand back, e.g. 'a 3-line summary with a table'." },
    }),
    kind: "local",
    async authorize(_ctx, a) { return (await findTeammate(a.teammate)) ? null : `There's no teammate called ${a.teammate}; crew_status lists them.`; },
    async run(ctx, a) {
      const t = (await findTeammate(a.teammate))!;
      const spec = [`Job from ${ctx.teammate.config.name}, for ${ctx.person?.display_name ?? "the person in this thread"}:`, `Objective: ${a.objective}`, a.context ? `Context: ${a.context}` : "", a.constraints ? `Constraints: ${a.constraints}` : "", a.output_shape ? `Hand back: ${a.output_shape}` : "", "Post your result with slack_post in this thread."].filter(Boolean).join("\n");
      const r = await callTeammate({ runId: ctx.runId, sessionId: ctx.sessionId, caller: ctx.teammate, personId: ctx.person?.id ?? null, toolCallId: ctx.toolCallId }, t, spec, "delegate");
      if ("refused" in r) return { text: r.refused, isError: true };
      return { text: `Handed to ${t.config.name}; it's working in this thread now.`, data: r };
    },
  },
];
