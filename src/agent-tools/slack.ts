// Speaking in Slack is a deliberate tool call (K2); a turn's final text is private. Both tools act only on the
// conversation the session belongs to (its own thread or DM): there is no channel argument to point elsewhere.
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
      if (!place) return { text: "This conversation isn't in Slack; your answer is your final text.", isError: true };
      const text = String(a.text ?? "").slice(0, 12_000);
      if (!text.trim()) return { text: "Nothing to post.", isError: true };
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
