// First contact: the first time a person opens a teammate's Messages tab (and for whoever
// installed it), code draws the frame (its face card) and starts a short run in which the teammate writes its own
// welcome with slack_post, from facts code gives it. Then its starter prompts are set on the Messages tab.
import { pool } from "../db.ts";
import { startRun } from "../durable/runs.ts";
import { appendEvent } from "../store/events.ts";
import { personForSlack } from "../store/people.ts";
import { openSession, submit } from "../store/sessions.ts";
import { getTeammate, type Teammate } from "../store/teammates.ts";
import { displayName, slack } from "./api.ts";
import type { SlackPlace } from "./inbound.ts";

async function facts(tm: Teammate, who: string, why: Why, budget?: string | null): Promise<string> {
  const c = tm.config;
  if (tm.slug === "peeblo") return peebloFacts(who, why, budget);
  const owner = tm.owner_person
    ? (await pool.query("SELECT display_name FROM people WHERE id = $1", [tm.owner_person])).rows[0]?.display_name
    : null;
  return [
    `<peeblo_event>first contact: ${why === "installed" ? `${who} just installed you, so from now on you post as yourself, from your own Slack app.` : `${who} opened your DM for the first time.`}`,
    `Facts: your owner is ${owner ?? "not set"}; you run on ${c.model.default}; your budget is $${c.budget.monthly_usd} a month; approvals: ${c.mode} mode; tools: ${[...c.tools, ...c.connectors].join(", ") || "none"}.`,
    `Write a short welcome to ${who} with slack_post: who you are and what you do for them, two or three concrete things they can ask you, and that you ask before acting on anything that matters.${why === "installed" ? " Say you're installed and will post as yourself from now on." : ""} A few lines, in your own words. Then stop.</peeblo_event>`,
  ].join("\n");
}

type Where = { channel: string; thread_ts?: string | null; channel_type: string };
// installed: they added its app; opened: they opened its DM; joined: they just joined the workspace (Peeblo only).
export type Why = "installed" | "opened" | "joined";

// Starts the welcome in a place (the person's DM with the teammate, or the hire thread for a channel hire).
async function firstContact(tm: Teammate, appId: string, team: string, slackUser: string, why: Why, where?: Where): Promise<void> {
  let place = where;
  if (!place) {
    const dm: any = await slack(appId, "conversations.open", { users: slackUser }).catch(() => null);
    if (!dm?.channel?.id) return;
    place = { channel: dm.channel.id, channel_type: "im" };
  }
  // The frame: its face card, drawn by code. The run threads its welcome under it.
  const { hireCard } = await import("./install.ts");
  const card = await hireCard(tm, appId, team, null);
  const frame: any = await slack(appId, "chat.postMessage", {
    channel: place.channel,
    ...(place.thread_ts ? { thread_ts: place.thread_ts } : {}),
    text: `${tm.config.name} · ${tm.config.role}`,
    blocks: [{ ...card, actions: card.actions.filter((a: any) => a.action_id !== "open_dm") }],
  }).catch((e) => {
    console.error("welcome frame:", (e as Error).message);
    return null;
  });
  if (!frame?.ts) return;
  const thread = place.thread_ts ?? frame.ts;
  const p: SlackPlace = {
    app_id: appId,
    team,
    channel: place.channel,
    channel_type: place.channel_type,
    thread_ts: thread,
    trigger_ts: frame.ts,
    user: slackUser,
    direct: true,
  };
  const person = await personForSlack(team, slackUser, { displayName: (await displayName(appId, slackUser)) ?? undefined });
  // Someone new to the workspace gets their Otari budget now, so the welcome can say what it is.
  const budget =
    why === "joined"
      ? await joinBudget(person).catch((e) => {
          console.error("join budget:", (e as Error).message);
          return null;
        })
      : null;
  const session = await openSession(tm.id, place.channel_type === "im" ? "dm" : "thread", `${place.channel}:${thread}`, { slack: p });
  const { run, created } = await submit({
    sessionId: session.id,
    personId: person.id,
    requestId: `welcome:${appId}:${slackUser}:${why}`,
    text: await facts(tm, person.display_name ?? "someone", why, budget),
    source: "welcome",
  });
  if (created) await startRun(run.id);
  await appendEvent({
    sessionId: session.id,
    runId: run.id,
    type: "slack.welcome",
    data: { teammate_id: tm.id, app_id: appId, user: slackUser, why },
  });
  if (place.channel_type === "im") await setPrompts(tm, appId, place.channel);
}

// The teammate's starter prompts at the top of its Messages tab (agent_view: no thread needed).
export async function setPrompts(tm: Teammate, appId: string, channel: string): Promise<void> {
  const prompts = tm.config.profile?.starter_prompts ?? [];
  if (!prompts.length) return;
  await slack(appId, "assistant.threads.setSuggestedPrompts", { channel_id: channel, prompts }).catch((e) =>
    console.error("suggested prompts:", (e as Error).message),
  );
}

// Once per person per teammate.
export async function welcomeOnce(
  appId: string,
  teammateId: string,
  team: string,
  slackUser: string,
  why: Why,
  where?: Where,
): Promise<boolean> {
  const ins = await pool.query("INSERT INTO welcomes (app_id, slack_user) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1", [
    appId,
    slackUser,
  ]);
  if (!ins.rowCount) return false;
  const tm = await getTeammate(teammateId);
  if (!tm) return false;
  await firstContact(tm, appId, team, slackUser, why, where);
  return true;
}

// Peeblo's first words to a new owner: where setup stands (from Otari and the crew, read now) and the next steps.
async function peebloFacts(who: string, why: Why, budget?: string | null): Promise<string> {
  const { listTeammates } = await import("../store/teammates.ts");
  const { serverList } = await import("../connectors/mcp.ts");
  const { session } = await import("../otari/admin.ts");
  const { links } = await import("../otari/links.ts");
  const { serviceName } = await import("./look.ts");
  const crew = (await listTeammates()).filter((t) => t.slug !== "peeblo" && !(t as any).hidden);
  const tools = ((await serverList().catch(() => [])) as any[]).map((s) => serviceName(s.name));
  const connected = Boolean(await session().catch(() => null));
  if (why === "joined") {
    const { config } = await import("../config.ts");
    return [
      `<peeblo_event>first contact: ${who} just joined this Slack workspace.`,
      `Facts: the crew is ${crew.map((t) => `${t.config.name} (${t.config.role})`).join("; ") || "empty so far"}; ${budget ? `their own AI budget is ${budget}, set when they joined` : "their AI budget is set by an admin"}; ${config.memberWrites ? "they can ask teammates to read and change the connected tools" : "they can ask any teammate to read the connected tools, while changes to those tools run only for admins (teammates show what they would have done)"}; they can hire a teammate of their own by describing the job to you${config.memberHires ? ` (up to ${config.memberHires})` : ""}; DMs are private, and channels show others' examples.`,
      `Write ${who} a short welcome with slack_post: one line on who you are; their budget in a line; then three things to try, as a short list: DM a teammate (name two from the crew, with a real question each could answer), tag a teammate in a channel, and ask you to hire one. Plain words, a few lines, no setup talk.</peeblo_event>`,
    ].join("\n");
  }
  return [
    `<peeblo_event>first contact: ${why === "installed" ? `${who} just added you to Slack` : `${who} opened your DM for the first time`}.`,
    `Facts: the crew has ${crew.length ? `${crew.length} teammate${crew.length === 1 ? "" : "s"} (${crew.map((t) => t.config.name).join(", ")})` : "no teammates yet"}; connectors in Otari: ${tools.length ? tools.join(", ") : "none yet"}; Otari dashboard ${connected ? "connected (routing, budgets and guardrail are set up)" : "not connected yet (the console's setup does it)"}; add connectors at ${links.mcpServers()}.`,
    `Write ${who} a short welcome with slack_post, as their new chief of staff: one line on what you do; then where things stand in a line (the tools you can already reach, by name); then, ${crew.length ? "what the crew can do for them" : 'as a short numbered list, the next steps: tell you about the company (or let you read the connected tools and draft company notes for their approval), hire a first teammate by describing the job ("I need a teammate who…"), and add more connectors in Otari, then give them to a teammate by asking you'}. Plain words, no setup jargon, a few lines.</peeblo_event>`,
  ].join("\n");
}

// Registers a new person in Otari on the starting tier and says it in words ("$0.50 a day").
async function joinBudget(person: { end_user_id: string | null; display_name: string | null }): Promise<string | null> {
  const { config } = await import("../config.ts");
  if (!person.end_user_id || config.otariKeyKind !== "service") return null;
  const { ensureEndUser, endUser, tiers } = await import("../otari/people.ts");
  await ensureEndUser(person.end_user_id, person.display_name, config.otariEndUserBudget || undefined);
  const mine = await endUser(person.end_user_id);
  const t = (await tiers()).find((x) => x.budget_id === mine?.budget_id);
  if (!t?.max_budget) return null;
  const per = t.budget_duration_sec ?? 0;
  const span =
    per === 86400
      ? "a day"
      : per === 604800
        ? "a week"
        : per >= 2419200 && per <= 2678400
          ? "a month"
          : per
            ? `every ${Math.round(per / 3600)} hours`
            : "in total";
  return `$${t.max_budget.toFixed(2)} ${span}`;
}
