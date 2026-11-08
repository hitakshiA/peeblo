// Speaking in Slack is a deliberate tool call (K2); a turn's final text is private. Both tools act only on the
// conversation the session belongs to (its own thread or DM): there is no channel argument to point elsewhere.
import { pool } from "../db.ts";
import { appendEvent } from "../store/events.ts";
import { getSession } from "../store/sessions.ts";
import { react, slack } from "../slack/api.ts";
import type { SlackPlace } from "../slack/inbound.ts";
import { object } from "./schema.ts";
import type { AgentTool, ToolContext } from "./types.ts";

async function placeOf(ctx: ToolContext): Promise<SlackPlace | null> {
  return ((await getSession(ctx.sessionId))?.place as any)?.slack ?? null;
}
const EMOJI = /^[a-z0-9_+-]{1,40}$/;
const UNPROMPTED_PER_HOUR = Number(process.env.PEEBLO_UNPROMPTED_PER_HOUR ?? 3);

export const slackTools: AgentTool[] = [
  {
    name: "slack_post",
    description: "Say something in this Slack conversation (your thread or DM). This is how you reply: your final text is not shown to anyone. Use Slack markdown. For a table or other layout, pass Block Kit blocks (e.g. a table block).",
    input_schema: object({
      text: { type: "string", description: "What to say (Slack markdown). Also the fallback text when blocks are given." },
      blocks: { type: ["array", "null"], description: "Optional Block Kit blocks, e.g. [{type: 'table', rows: [...]}].", items: { type: "object", additionalProperties: true } as any },
    }),
    kind: "read", // it posts only into the conversation the person started; no approval
    async run(ctx, a) {
      const place = await placeOf(ctx);
      const text = String(a.text ?? "").slice(0, 12_000);
      if (!text.trim()) return { text: "Nothing to post.", isError: true };
      // Outside Slack (the API, a test) the post is the reply: recorded the same way, so nothing is retried.
      if (!place) { await appendEvent({ sessionId: ctx.sessionId, runId: ctx.runId, type: "slack.post", data: { text, outside_slack: true } }); return { text: "Posted." }; }
      // Unprompted posts (no one asked this teammate in this conversation) are rate-limited per channel, and a
      // thread someone marked 👎 gets none (K2).
      if (!place.direct) {
        const s = await getSession(ctx.sessionId);
        if ((s?.place as any)?.muted) return { text: "Someone marked a reply here as not helpful, so you stay quiet in this thread unless asked.", isError: true };
        const { rows } = await pool.query(
          `SELECT count(*)::int AS n FROM events e JOIN sessions s ON s.id = e.session_id
            WHERE e.type IN ('slack.post', 'slack.post.blocks') AND e.at > now() - interval '1 hour' AND s.teammate_id = $1 AND s.place->'slack'->>'channel' = $2 AND (s.place->'slack'->>'direct')::boolean IS NOT TRUE`,
          [ctx.teammate.id, place.channel]);
        if (rows[0].n >= UNPROMPTED_PER_HOUR) return { text: `You've already posted ${rows[0].n} times unprompted in this channel in the last hour; stay quiet unless someone asks you.`, isError: true };
      }
      if (a.blocks?.length) {
        // Blocks can't go into a live stream; they post as their own message in the thread.
        const r = await slack(place.app_id, "chat.postMessage", { channel: place.channel, thread_ts: place.thread_ts, text, blocks: a.blocks }).catch((e) => ({ ok: false, error: (e as Error).message }));
        await appendEvent({ sessionId: ctx.sessionId, runId: ctx.runId, type: "slack.post.blocks", data: { ok: (r as any).ok !== false, ts: (r as any).ts ?? null } });
        if ((r as any).ok === false) return { text: `Slack refused the blocks (${(r as any).error}); post plain text instead.`, isError: true };
        return { text: "Posted." };
      }
      await appendEvent({ sessionId: ctx.sessionId, runId: ctx.runId, type: "slack.post", data: { text } });
      return { text: "Posted." };
    },
  },
  {
    name: "slack_react",
    description: "React with an emoji to the message you were asked in (e.g. 'thumbsup', 'eyes', 'white_check_mark').",
    input_schema: object({ emoji: { type: "string" } }),
    kind: "read",
    async run(ctx, a) {
      const place = await placeOf(ctx);
      if (!place) return { text: "This conversation isn't in Slack.", isError: true };
      const name = String(a.emoji ?? "").replace(/:/g, "");
      if (!EMOJI.test(name)) return { text: "That isn't an emoji name.", isError: true };
      await react(place.app_id, place.channel, place.trigger_ts, name);
      return { text: "Reacted." };
    },
  },
];
