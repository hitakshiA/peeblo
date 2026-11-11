// Facts added to a turn, after the stable system prompt: what ran in Otari last turn, the teammate's other live
// conversations, who is asking (their card, time zone and open promises), new 👍/👎, and who of the crew is in the
// channel. Each is a <peeblo_event> block the agent uses but doesn't quote.
import { pool } from "../db.ts";
import type { RunContext } from "../durable/runs.ts";
import { appendEvent } from "../store/events.ts";
import { getSession } from "../store/sessions.ts";
import type { Teammate } from "../store/teammates.ts";

// Otari runs web and code tools inside the model call, so Pi's history keeps only the answer, not what ran.
// The next turn gets a short note of the previous run's Otari tool calls, so the teammate knows its sandbox
// state and sources are real.
export async function otariToolNote(sessionId: string, runId: string): Promise<string> {
  const { rows } = await pool.query(
    `SELECT data FROM events WHERE session_id = $1 AND type = 'tool.call' AND data->>'by' = 'otari'
       AND run_id = (SELECT run_id FROM events WHERE session_id = $1 AND type = 'turn.finished' AND run_id <> $2 ORDER BY id DESC LIMIT 1)
     ORDER BY id`,
    [sessionId, runId],
  );
  if (!rows.length) return "";
  const lines = rows.map(({ data: d }) => {
    if (d.tool === "code_execution")
      return `- ran code (exit ${d.exit_code ?? "?"}${d.files?.length ? `, wrote ${d.files.length} file(s)` : ""}): ${String(d.code).slice(0, 300).replace(/\s+/g, " ")}`;
    if (d.tool === "web_search") return `- searched "${d.query}" (${d.status})`;
    if (d.tool === "web_fetch") return `- fetched ${d.url} (${d.status})`;
    return `- ${d.tool} (${d.status})`;
  });
  return `<peeblo_event kind="previous_tool_calls">Tools that ran for you in the previous turn (the sandbox keeps their variables and files):\n${lines.join("\n")}</peeblo_event>\n`;
}

// Facts about this teammate's other conversations running right now (facts, not strategy), added to a
// turn only when they changed since the session last heard.
const lastLive = new Map<string, string>();
function liveThreadLines(placeKey: string | null, rows: { place_key: string; status: string; asked: string }[]): string {
  const here = placeKey?.split(":")[0] ?? null;
  return rows
    .map((r) => {
      const same = here !== null && String(r.place_key).split(":")[0] === here;
      return same
        ? `- a thread in this channel (${r.status}): "${String(r.asked).replace(/"/g, "'")}"`
        : `- a conversation elsewhere (${r.status})`;
    })
    .join("\n");
}
export async function liveThreadsNote(sessionId: string, teammateId: string): Promise<string> {
  const { rows } = await pool.query(
    `SELECT s.id, s.kind, s.place_key, r.status, left(sub.text, 80) AS asked
       FROM runs r JOIN sessions s ON s.id = r.session_id JOIN submissions sub ON sub.id = r.submission_id
      WHERE s.teammate_id = $1 AND s.id <> $2 AND r.status IN ('running', 'waiting') ORDER BY r.created_at`,
    [teammateId, sessionId],
  );
  // What was asked shows only for threads in this conversation's own channel: a DM or another channel's text
  // never reaches this one.
  const text = liveThreadLines((await getSession(sessionId))?.place_key ?? null, rows);
  if ((lastLive.get(sessionId) ?? "") === text) return "";
  lastLive.set(sessionId, text);
  if (!text) return "";
  await appendEvent({ sessionId, runId: null, type: "note.live_threads", data: { others: rows.map((r) => r.id) } }).catch(() => {});
  return `<peeblo_event kind="live_threads">Your other live conversations right now (each is handled in its own thread; the message below is only about this one):\n${text}</peeblo_event>\n`;
}

// One turn: send the wrapped submission, wait for agent_settled, return the answer.
// 👍/👎 on this teammate's replies since it last heard about them, as a fact (it decides what to remember).
// Who's asking: their person card (how they like answers) and what this agent promised them and hasn't done yet.
export async function personNote(
  ctx: RunContext,
  tm: Teammate,
  person: { id: string; display_name: string | null } | null,
): Promise<string> {
  if (!person) return "";
  const { personCard, openPromises } = await import("../memory/work.ts");
  const { placeOfSession } = await import("../memory/store.ts");
  const card = personCard(person.id);
  const open = openPromises(tm.slug, placeOfSession(ctx.session), person.display_name);
  // Their time zone (from Slack): times are said in it, and recurring schedules run in it.
  const tz = (await pool.query<{ tz: string | null }>("SELECT tz FROM people WHERE id = $1", [person.id])).rows[0]?.tz ?? null;
  const local = tz
    ? new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit" }).format(new Date())
    : null;
  const zone =
    tz && local
      ? `${person.display_name ?? "They"} ${person.display_name ? "is" : "are"} on ${tz} (it's ${local} there now). Say times in their time zone; a recurring schedule's cron is written in their time zone too (one-off times are exact instants).\n`
      : "";
  if (!card && !open.length && !zone) return "";
  return `<peeblo_event kind="person">${zone}${card ? `How ${person.display_name ?? "they"} like answers:\n${card.slice(0, 800)}\n` : ""}${open.length ? `You promised ${person.display_name ?? "them"}: ${open.map((n) => `${n.title} (${n.path})`).join("; ")}.` : ""}</peeblo_event>\n`;
}

export async function feedbackNote(sessionId: string, runId: string, teammateId: string): Promise<string> {
  const { rows } = await pool.query(
    `SELECT f.id, f.data->>'vote' AS vote, left(sub.text, 120) AS asked FROM events f JOIN runs r ON r.id = f.run_id JOIN sessions s ON s.id = r.session_id JOIN submissions sub ON sub.id = r.submission_id
      WHERE f.type = 'slack.feedback' AND s.teammate_id = $1
        AND f.id > coalesce((SELECT max((data->>'upto')::bigint) FROM events WHERE type = 'feedback.noted' AND data->>'teammate_id' = $1), 0)
      ORDER BY f.id LIMIT 5`,
    [teammateId],
  );
  if (!rows.length) return "";
  await appendEvent({ sessionId, runId, type: "feedback.noted", data: { teammate_id: teammateId, upto: rows.at(-1).id } });
  return `<peeblo_event kind="feedback">People rated your recent replies: ${rows
    .map(
      (r) =>
        `${r.vote === "up" ? "👍" : "👎"} on "${String(r.asked)
          .replace(/<[^>]+>/g, "")
          .replace(/\s+/g, " ")
          .trim()}"`,
    )
    .join("; ")}. Decide whether anything is worth remembering about how they want answers.</peeblo_event>\n`;
}

// Who of the crew is in this channel, for a channel session (who to hand work to).
const rosters = new Map<string, { at: number; text: string }>();
export async function rosterNote(place: { app_id: string; channel: string }): Promise<string> {
  const hit = rosters.get(place.channel);
  if (hit && Date.now() - hit.at < 600_000) return hit.text;
  const { slack } = await import("../slack/api.ts");
  const members: string[] =
    (await slack(place.app_id, "conversations.members", { channel: place.channel, limit: 500 }).catch(() => null))?.members ?? [];
  const { rows } = await pool.query(
    "SELECT a.bot_user_id, t.slug, v.config->>'name' AS name, v.config->>'role' AS role FROM slack_apps a JOIN teammates t ON t.id = a.teammate_id JOIN teammate_versions v ON v.teammate_id = t.id AND v.version = t.version WHERE t.slug <> 'peeblo' AND NOT t.hidden AND a.bot_user_id = ANY($1)",
    [members],
  );
  const text = rows.length
    ? `<peeblo_event kind="roster">Teammates in this channel: ${rows.map((r) => `${r.name} (<@${r.bot_user_id}>, ${r.role})`).join("; ")}.</peeblo_event>\n`
    : "";
  rosters.set(place.channel, { at: Date.now(), text });
  return text;
}
