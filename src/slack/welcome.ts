// First contact (SLACK_UX_SPEC §3.2): the first time a person opens a teammate's Messages tab (and for whoever
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

async function facts(tm: Teammate, who: string, why: "installed" | "opened"): Promise<string> {
  const c = tm.config;
  const owner = tm.owner_person ? (await pool.query("SELECT display_name FROM people WHERE id = $1", [tm.owner_person])).rows[0]?.display_name : null;
  return [
    `<peeblo_event>first contact: ${why === "installed" ? `${who} just installed you, so from now on you post as yourself, from your own Slack app.` : `${who} opened your DM for the first time.`}`,
    `Facts: your owner is ${owner ?? "not set"}; you run on ${c.model.default}; your budget is $${c.budget.monthly_usd} a month; approvals: ${c.mode} mode; tools: ${[...c.tools, ...c.connectors].join(", ") || "none"}.`,
    `Write a short welcome to ${who} with slack_post: who you are and what you do for them, two or three concrete things they can ask you, and that you ask before acting on anything that matters.${why === "installed" ? " Say you're installed and will post as yourself from now on." : ""} A few lines, in your own words. Then stop.</peeblo_event>`,
  ].join("\n");
}

type Where = { channel: string; thread_ts?: string | null; channel_type: string };

// Starts the welcome in a place (the person's DM with the teammate, or the hire thread for a channel hire).
export async function firstContact(tm: Teammate, appId: string, team: string, slackUser: string, why: "installed" | "opened", where?: Where): Promise<void> {
  let place = where;
  if (!place) {
    const dm: any = await slack(appId, "conversations.open", { users: slackUser }).catch(() => null);
    if (!dm?.channel?.id) return;
    place = { channel: dm.channel.id, channel_type: "im" };
  }
  // The frame: its face card, drawn by code. The run threads its welcome under it.
  const { hireCard } = await import("./install.ts");
  const card = await hireCard(tm, appId, team, null);
  const frame: any = await slack(appId, "chat.postMessage", { channel: place.channel, ...(place.thread_ts ? { thread_ts: place.thread_ts } : {}), text: `${tm.config.name} · ${tm.config.role}`, blocks: [{ ...card, actions: card.actions.filter((a: any) => a.action_id !== "open_dm") }] }).catch((e) => { console.error("welcome frame:", (e as Error).message); return null; });
  if (!frame?.ts) return;
  const thread = place.thread_ts ?? frame.ts;
  const p: SlackPlace = { app_id: appId, team, channel: place.channel, channel_type: place.channel_type, thread_ts: thread, trigger_ts: frame.ts, user: slackUser, direct: true };
  const person = await personForSlack(team, slackUser, { displayName: (await displayName(appId, slackUser)) ?? undefined });
  const session = await openSession(tm.id, place.channel_type === "im" ? "dm" : "thread", `${place.channel}:${thread}`, { slack: p });
  const { run, created } = await submit({ sessionId: session.id, personId: person.id, requestId: `welcome:${appId}:${slackUser}:${why}`, text: await facts(tm, person.display_name ?? "someone", why), source: "welcome" });
  if (created) await startRun(run.id);
  await appendEvent({ sessionId: session.id, runId: run.id, type: "slack.welcome", data: { teammate_id: tm.id, app_id: appId, user: slackUser, why } });
  if (place.channel_type === "im") await setPrompts(tm, appId, place.channel);
}

// The teammate's starter prompts at the top of its Messages tab (agent_view: no thread needed).
export async function setPrompts(tm: Teammate, appId: string, channel: string): Promise<void> {
  const prompts = tm.config.profile?.starter_prompts ?? [];
  if (!prompts.length) return;
  await slack(appId, "assistant.threads.setSuggestedPrompts", { channel_id: channel, prompts }).catch((e) => console.error("suggested prompts:", (e as Error).message));
}

// Once per person per teammate.
export async function welcomeOnce(appId: string, teammateId: string, team: string, slackUser: string, why: "installed" | "opened", where?: Where): Promise<boolean> {
  const ins = await pool.query("INSERT INTO welcomes (app_id, slack_user) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1", [appId, slackUser]);
  if (!ins.rowCount) return false;
  const tm = await getTeammate(teammateId);
  if (!tm) return false;
  await firstContact(tm, appId, team, slackUser, why, where);
  return true;
}
