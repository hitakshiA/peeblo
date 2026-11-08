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
import { installBlocks, offerOnCard } from "../slack/install.ts";
import { configProblems } from "../hire-rules.ts";
import { changeModel } from "../model-change.ts";
import { ROLES } from "../otari/routing.ts";
import { COLORS, facePng, idCardHeroPng, idCardPng, pickFace, publishCard, SHAPES } from "../slack/idcard.ts";
import type { SlackPlace } from "../slack/inbound.ts";
import { object } from "./schema.ts";
import type { AgentTool, ToolContext } from "./types.ts";

const MODES = ["ask", "auto", "trusted", "yolo"] as const;
// A teammate by slug or by name (people and models say "Moss", not "moss").
export async function findTeammate(nameOrSlug: string): Promise<Teammate | null> {
  // The slug exactly, else the (unique) name.
  const direct = await getTeammate(nameOrSlug.trim()) ?? await getTeammate(nameOrSlug.trim().toLowerCase());
  if (direct) return direct;
  // Two teammates can share a name; the newest is the one people mean.
  const all = (await listTeammates()).filter((t) => t.config.name.toLowerCase() === nameOrSlug.toLowerCase().trim());
  return all.sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))[0] ?? null;
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
  profile: { type: ["object", "null"], description: "Its Slack profile, in your words: bio (2-4 sentences: what it does, for whom, how it works), agent_description (one function-first line, under 300 characters, e.g. 'Reconciles Stripe charges against Xero and flags mismatches for Priya'), starter_prompts (4 short things a person might ask it, each {title, message}).", properties: { bio: { type: "string" }, agent_description: { type: "string" }, starter_prompts: { type: "array", maxItems: 4, items: { type: "object", properties: { title: { type: "string" }, message: { type: "string" } }, required: ["title", "message"], additionalProperties: false } } }, required: ["bio", "agent_description", "starter_prompts"], additionalProperties: false },
};
function configFrom(a: any): Partial<TeammateConfig> {
  return {
    // The default model is the worker role's, from config/model-tiers.json.
    name: a.name, role: a.role, instructions: a.instructions ?? "", model: { default: a.model || ROLES["peeblo-worker"].default, fallback: ROLES["peeblo-worker"].fallback[0] },
    // Every teammate has its own computer (small unless it browses); code and data work run there.
    budget: { monthly_usd: a.budget_usd }, tools: [...new Set([...(a.tools ?? []), "computer"])], connectors: a.connectors ?? [], mode: a.mode ?? "auto",
    computer: { size: a.computer_size ?? "small", allowed_hosts: [] } as any,
    ...(a.profile ? { profile: a.profile } : {}),
  };
}

// Asking the person a question (K15): every teammate has it.
export const askHumanTool: AgentTool = {
    name: "ask_human",
    description: "Ask the person a clarifying question you need answered before you can do the work (at most 2 at once). Their reply arrives as their next message; end your turn after asking.",
    input_schema: object({ questions: { type: "array", items: { type: "string" }, maxItems: 2 } }),
    kind: "read",
    async run(ctx, a) {
      const text = a.questions.length === 1 ? a.questions[0] : a.questions.map((q: string, i: number) => `${i + 1}. ${q}`).join("\n");
      await appendEvent({ sessionId: ctx.sessionId, runId: ctx.runId, type: "slack.post", data: { text } });
      return { text: "Asked. End your turn now; their answer comes as the next message." };
    },
  };

export const managerTools: AgentTool[] = [
  {
    name: "teammate_retire",
    description: "Retire (fire) a teammate when its owner or an admin asks: its Otari key and budget are removed, its Slack app is uninstalled, its schedules stop. Its history is kept. A person approves it on a card first.",
    input_schema: object({ teammate: { type: "string" }, reason: { type: "string" } }),
    kind: "write",
    async authorize(ctx, a) {
      const t = await findTeammate(a.teammate);
      if (!t) return `There's no teammate called ${a.teammate}; crew_status lists them.`;
      if (t.slug === "peeblo") return "Peeblo can't be retired.";
      return mayManageTeammate(t, ctx.person) ? null : `Only ${t.config.name}'s owner or an admin can retire it.`;
    },
    describe: async (_ctx, a) => ({ summary: `Retire ${a.teammate}: ${String(a.reason).slice(0, 160)}`, risk: "destructive", per_action: true }),
    async run(ctx, a) {
      const t = (await findTeammate(a.teammate))!;
      const { retireTeammate } = await import("../retire.ts");
      const r = await retireTeammate(t.id, { personId: ctx.person?.id ?? null, label: `${ctx.person?.display_name ?? "someone"}: ${a.reason}` });
      return r.ok ? { text: `Retired ${t.config.name}: ${r.steps.join("; ")}.` } : { text: r.steps.join("; "), isError: true };
    },
  },
  askHumanTool,
  {
    name: "crew_status",
    description: "The crew right now: each teammate's role, model, budget used, approval mode, Slack app, and its latest job.",
    input_schema: object({}),
    kind: "read",
    async run() {
      const hidden = new Set((await pool.query("SELECT id FROM teammates WHERE hidden")).rows.map((r) => r.id));
      const tms = (await listTeammates()).filter((t) => t.slug !== "peeblo" && !hidden.has(t.id));
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
    name: "teammate_hire",
    description: "Hire a teammate: shows the person its ID card for one approval, then creates it (its config, Otari key and budget, Slack app and face) and introduces it. Draft first in conversation; call this with the finished spec.",
    input_schema: object(hireSpec),
    kind: "write",
    async authorize(ctx, a) {
      if (!ctx.person) return "Hiring needs a person to own the teammate.";
      try { validateConfig(configFrom(a)); } catch (e) { return `The spec isn't valid: ${(e as Error).message}`; }
      // The authority rules (src/hire-rules.ts): YOLO for admins, an allowed model, a budget within the hirer's tier.
      const bad = await configProblems(ctx.person, { mode: a.mode, model: a.model || null, budget_usd: a.budget_usd, tools: a.tools ?? [], connectors: a.connectors ?? [] });
      if (bad) return bad;
      // Names and slugs are unique, so a name always means one teammate.
      const all = await listTeammates();
      const name = String(a.name).toLowerCase().trim();
      if (all.some((t) => t.config.name.toLowerCase() === name || t.slug === slugOf(a.name))) {
        const variant = [2, 3, 4, 5, 6, 7, 8, 9].map((n) => `${a.name} ${n}`).find((v) => !all.some((t) => t.config.name.toLowerCase() === v.toLowerCase() || t.slug === slugOf(v)));
        return `There's already a teammate called ${a.name}. Pick another name${variant ? `, e.g. ${variant}, or a different word` : ""}.`;
      }
      return null;
    },
    async describe(ctx, a) {
      // The approval card is the finished ID card.
      const place = await placeOf(ctx);
      const fake = { id: "tm_preview", slug: slugOf(a.name), owner_person: ctx.person?.id ?? null, version: 1, config: validateConfig(configFrom(a)), created_at: new Date() } as Teammate;
      const face = pickFace(fake.slug, a.face, a.color);
      const png = await idCardPng(fake, face, ctx.person?.display_name ?? "you");
      const card = await publishCard(png).catch(() => null);
      // A wide version for the hired card's hero image (Slack crops a card block's hero).
      const hero = await publishCard(await idCardHeroPng(png)).catch(() => null);
      void place;
      return { kind: "hire", approvers: ctx.person ? [ctx.person.id] : [], id_card_url: card, id_card_hero: hero, summary: `${a.name} · ${a.role} · ${fake.config.model.default} · $${a.budget_usd}/month · ${fake.config.mode} mode · tools: ${[...(a.tools ?? []), ...(a.connectors ?? [])].join(", ") || "none"}` };
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
      } catch (e) { appNote = ` Its Slack app couldn't be made yet (${(e as Error).message.slice(0, 120)}), so it can't work until its app is set up.`; }
      await appendEvent({ sessionId: ctx.sessionId, runId: ctx.runId, type: "teammate.hired", data: { teammate_id: tm.id, slug, by: ctx.person?.id ?? null, app: Boolean(install) } });
      if (place) {
        // The install button goes on the ID card it was approved on and on its hello in the thread.
        const slackUser = ctx.person?.slack_user ?? null;
        if (install) await offerOnCard(tm, ctx.runId, install, slackUser).catch((e) => console.error("install card:", e));
        // Peeblo only hands over the button: the teammate works, and speaks, once its own app is installed.
        const hello: any = await slack(place.app_id, "chat.postMessage", { channel: place.channel, thread_ts: place.thread_ts, text: `${tm.config.name} is ready. Install it to start working with it.`, blocks: [
          { type: "section", text: { type: "mrkdwn", text: `*${tm.config.name} is ready.* Install it to start working with it, with the button on its ID card.` } },
        ] }).catch(() => null);
        if (hello?.ts) await pool.query("UPDATE hires SET hello = $2 WHERE teammate_id = $1", [tm.id, { app_id: place.app_id, channel: hello.channel ?? place.channel, ts: hello.ts }]);
      }
      return { text: `Hired ${tm.config.name} (${slug}).${install ? " Its install button is on its ID card in this thread (say 'the button on its ID card'; don't say above or below, the order depends on the screen). It starts working only once it's installed: until then don't delegate to it." : ""}${appNote}`, data: { teammate: slug, install_url: install, app_error: appNote || null } };
    },
  },
  {
    name: "teammate_update",
    description: "Change a teammate's setup by talking: instructions, model, mode (ask/auto/trusted/yolo), tools, connectors, budget or computer size. Lowering applies at once; raising a capability asks first. Only its owner or an admin can change it.",
    input_schema: object({
      teammate: { type: "string" },
      field: { type: "string", enum: ["instructions", "model", "mode", "tools", "connectors", "budget_usd", "computer_size", "profile"] },
      value: { type: "string", description: "The new value; lists comma-separated. For profile, a short summary of the change." },
      profile: { type: ["object", "null"], description: "Its Slack profile, in your words: bio (2-4 sentences: what it does, for whom, how it works), agent_description (one function-first line, under 300 characters, e.g. 'Reconciles Stripe charges against Xero and flags mismatches for Priya'), starter_prompts (4 short things a person might ask it, each {title, message}).", properties: { bio: { type: "string" }, agent_description: { type: "string" }, starter_prompts: { type: "array", maxItems: 4, items: { type: "object", properties: { title: { type: "string" }, message: { type: "string" } }, required: ["title", "message"], additionalProperties: false } } }, required: ["bio", "agent_description", "starter_prompts"], additionalProperties: false },
      reason: { type: "string" },
    }),
    kind: "local",
    async authorize(ctx, a) {
      const t = await findTeammate(a.teammate);
      if (!t) return `There's no teammate called ${a.teammate}; crew_status lists them.`;
      if (!mayManageTeammate(t, ctx.person)) return `Only ${t.config.name}'s owner or an admin can change it.`;
      const list = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);
      // The same authority rules as a hire (src/hire-rules.ts).
      return configProblems(ctx.person, {
        mode: a.field === "mode" ? a.value : null, model: a.field === "model" ? a.value : null,
        budget_usd: a.field === "budget_usd" ? Number(a.value) : null,
        tools: a.field === "tools" ? list(a.value) : [], connectors: a.field === "connectors" ? list(a.value) : [],
      });
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
      // A model change goes through changeModel: allowlist, authority and budget checked, the fallback kept, and a
      // running session told (K3).
      if (a.field === "model") {
        try {
          const r = await changeModel(t.slug, { model: a.value, fallback: t.config.model.fallback ?? null, personId: ctx.person!.id, why: a.reason });
          return { text: `${t.config.name} is now at version ${r.teammate.version}: model = ${a.value} (fallback ${t.config.model.fallback ?? "none"}). New conversations use it.` };
        } catch (e) { return { text: `Can't change the model: ${(e as Error).message}.`, isError: true }; }
      }
      if (a.field === "profile") {
        if (!a.profile) return { text: "Give the profile (bio, agent_description, starter_prompts).", isError: true };
        const next = await updateTeammate(t.slug, { profile: a.profile } as any, { label: `${ctx.person?.display_name ?? "a person"} via Peeblo` }, a.reason);
        return { text: `${t.config.name}'s Slack profile is updated (version ${next.version}); Slack shows it within a minute or two.` };
      }
      const patch: any = a.field === "instructions" ? { instructions: a.value }
        : a.field === "mode" ? { mode: a.value } : a.field === "tools" ? { tools: list(a.value) } : a.field === "connectors" ? { connectors: list(a.value) }
        : a.field === "budget_usd" ? { budget: { monthly_usd: Number(a.value) } } : { computer: { ...t.config.computer, size: a.value } };
      const next = await updateTeammate(t.slug, patch, { label: `${ctx.person?.display_name ?? "a person"} via Peeblo` }, a.reason);
      return { text: `${t.config.name} is now at version ${next.version}: ${a.field} = ${a.value}. Running conversations keep their setup; new ones use it (a lower mode applies at once).` };
    },
  },
  {
    name: "job",
    description: "See and steer the crew's jobs: status (what's running, waiting or just finished, optionally for one teammate), stop a job, reassign it to another teammate (it stops there and starts with the new one, same request), or add_detail (forward a new detail to the job already working on it, instead of starting new work).",
    input_schema: object({
      action: { type: "string", enum: ["status", "stop", "reassign", "add_detail"] },
      job: { type: ["string", "null"], description: "The job id from status (ru_…)." },
      teammate: { type: ["string", "null"], description: "For status: only this teammate. For reassign: who takes it over." },
      detail: { type: ["string", "null"], description: "For add_detail: the new detail, in the person's words, for the job already working on it." },
    }),
    kind: "local",
    async run(ctx, a) {
      if (a.action === "status") {
        const t = a.teammate ? await findTeammate(a.teammate) : null;
        const { rows } = await pool.query(
          `SELECT r.id, r.status, r.created_at, tm.slug, left(sub.text, 100) AS asked FROM runs r JOIN sessions s ON s.id = r.session_id JOIN teammates tm ON tm.id = s.teammate_id JOIN submissions sub ON sub.id = r.submission_id
            WHERE ($1::text IS NULL OR tm.id = $1) AND tm.slug <> 'peeblo' AND sub.source <> 'welcome' AND (r.status IN ('queued', 'running', 'waiting') OR r.created_at > now() - interval '2 hours')
            ORDER BY r.created_at DESC LIMIT 15`, [t?.id ?? null]);
        return { text: rows.map((r) => `- ${r.id} · ${r.slug} · ${r.status} · ${new Date(r.created_at).toISOString().slice(11, 16)} UTC · ${String(r.asked).replace(/\n/g, " ").replace(/<[^>]+>/g, "")}`).join("\n") || "No jobs running or in the last two hours." };
      }
      if (!a.job) return { text: "Which job? status lists them.", isError: true };
      const r = (await pool.query("SELECT r.session_id, r.status, sub.text, sub.person_id, s.teammate_id FROM runs r JOIN submissions sub ON sub.id = r.submission_id JOIN sessions s ON s.id = r.session_id WHERE r.id = $1", [a.job])).rows[0];
      if (!r) return { text: `No job ${a.job}.`, isError: true };
      const owner = await getTeammate(r.teammate_id);
      // Stopping or moving someone's job: the person who asked for it, the teammate's owner, or an admin.
      if (!(ctx.person && (ctx.person.id === r.person_id || (owner && mayManageTeammate(owner, ctx.person))))) return { text: "Only the person who asked for that job, the teammate's owner or an admin can stop or move it.", isError: true };
      if (a.action === "add_detail") {
        if (!a.detail?.trim()) return { text: "What's the new detail?", isError: true };
        // Into the job's own conversation, from the person who said it (the teammate reads it as their message).
        const { run, created } = await submit({ sessionId: r.session_id, personId: ctx.person?.id ?? r.person_id, requestId: `detail:${a.job}:${ctx.toolCallId}`, text: `(A new detail for this job, passed on by Peeblo) ${a.detail}`, source: "slack" });
        if (created) { const { startRun } = await import("../durable/runs.ts"); await startRun(run.id); }
        await appendEvent({ sessionId: ctx.sessionId, runId: ctx.runId, type: "job.detail_forwarded", data: { job: a.job, to_session: r.session_id, run: run.id } });
        return { text: `Passed it on to ${owner?.config.name ?? "the teammate"}'s job; it picks it up in that thread.`, data: { run: run.id } };
      }
      const { stopSession } = await import("../pi/supervisor.ts");
      if (["queued", "running", "waiting"].includes(r.status)) await stopSession(r.session_id);
      if (a.action === "stop") return { text: `Stopped ${a.job}.` };
      const to = a.teammate ? await findTeammate(a.teammate) : null;
      if (!to) return { text: "Reassign to whom? Name a teammate.", isError: true };
      const c = await callTeammate({ runId: ctx.runId, sessionId: ctx.sessionId, caller: ctx.teammate, personId: r.person_id ?? ctx.person?.id ?? null, toolCallId: ctx.toolCallId }, to, `Job moved to you from ${owner?.config.name ?? "another teammate"}:\n${r.text}`, "delegate", `Moved this job from ${owner?.config.name ?? "another teammate"} to ${to.config.name}.`);
      if ("refused" in c) return { text: c.refused, isError: true };
      return { text: `Stopped ${a.job} and handed it to ${to.config.name}.`, data: c };
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
      announce: { type: "string", description: "The one line you post in this thread so people see the hand-off, in your words, e.g. 'Asked Grove to pull this week's GRO issues for standup.'" },
    }),
    kind: "local",
    // Handing a job on acts through another teammate: the mode rule and the reviewer apply (Ask mode cards it).
    outward: () => "write",
    async authorize(_ctx, a) { return (await findTeammate(a.teammate)) ? null : `There's no teammate called ${a.teammate}; crew_status lists them.`; },
    async run(ctx, a) {
      const t = (await findTeammate(a.teammate))!;
      const spec = [`Job from ${ctx.teammate.config.name}, for ${ctx.person?.display_name ?? "the person in this thread"}:`, `Objective: ${a.objective}`, a.context ? `Context: ${a.context}` : "", a.constraints ? `Constraints: ${a.constraints}` : "", a.output_shape ? `Hand back: ${a.output_shape}` : "", "Post your result with slack_post in this thread."].filter(Boolean).join("\n");
      const r = await callTeammate({ runId: ctx.runId, sessionId: ctx.sessionId, caller: ctx.teammate, personId: ctx.person?.id ?? null, toolCallId: ctx.toolCallId }, t, spec, "delegate", a.announce);
      if ("refused" in r) return { text: r.refused, isError: true };
      // The hand-off ends this turn: the announce line is already in the thread, and the teammate posts its own result.
      return { text: r.inDm ? `Handed to ${t.config.name}; it's working in its own DM with the person (it can't post in this conversation). Tell them to look there.` : `Handed to ${t.config.name}; it's working in this thread now.`, data: r, endTurn: !r.inDm };
    },
  },
];
