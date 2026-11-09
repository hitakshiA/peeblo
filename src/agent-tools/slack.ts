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
    name: "channel_watch",
    description: "Start or stop keeping an eye on a Slack channel: while watching, you read every message there and step in only when it helps. Only when a person asks (\"keep an eye on #support\", \"stop watching\"); by default you answer only when tagged.",
    input_schema: object({
      channel: { type: ["string", "null"], description: "The channel's name (#support) or id; leave out for this conversation's channel." },
      watch: { type: "boolean", description: "true to start watching, false to stop." },
    }),
    kind: "local",
    async authorize(ctx) { return ctx.teammate.slug === "peeblo" ? null : "Only Peeblo watches channels; teammates answer when tagged."; },
    async run(ctx, a) {
      const place = await placeOf(ctx);
      if (!place) return { text: "This conversation isn't in Slack, so there's no channel to watch.", isError: true };
      let channel = place.channel;
      const want = String(a.channel ?? "").trim().replace(/^#/, "");
      if (want) {
        if (/^[CG][A-Z0-9]{6,}$/.test(want)) channel = want;
        else {
          let cursor: string | undefined;
          let found: string | null = null;
          for (let i = 0; i < 10 && !found; i++) {
            const r: any = await slack(place.app_id, "conversations.list", { types: "public_channel,private_channel", limit: 200, exclude_archived: true, ...(cursor ? { cursor } : {}) }).catch(() => null);
            found = r?.channels?.find((c: any) => c.name === want.toLowerCase())?.id ?? null;
            cursor = r?.response_metadata?.next_cursor || undefined;
            if (!cursor) break;
          }
          if (!found) return { text: `There's no channel called #${want} that Peeblo can see. Invite Peeblo to it first (/invite @Peeblo).`, isError: true };
          channel = found;
        }
      }
      if (place.channel_type === "im" && !want) return { text: "Name the channel to watch, e.g. #support.", isError: true };
      await pool.query(
        `INSERT INTO channel_settings (team_id, channel, attention) VALUES ($1, $2, $3)
         ON CONFLICT (team_id, channel) DO UPDATE SET attention = EXCLUDED.attention, updated_at = now()`, [place.team, channel, a.watch ? "listen" : "mentions"]);
      await appendEvent({ sessionId: ctx.sessionId, runId: ctx.runId, type: "channel.attention", data: { channel, attention: a.watch ? "listen" : "mentions", by: ctx.person?.id ?? null } });
      return { text: a.watch ? `Watching <#${channel}> now: you'll read every message there and step in only when it helps.` : `Stopped watching <#${channel}>: you'll answer there only when tagged.` };
    },
  },
  {
    name: "slack_post",
    description: "Reply in this Slack conversation (your thread or DM); your final text is not shown to anyone. Posting your answer ends your turn, so post it last and on its own (not alongside other tool calls). Set more: true only for a progress note when you will keep working. Slack markdown; for a table or other layout, pass Block Kit blocks.",
    input_schema: object({
      text: { type: "string", description: "What to say (Slack markdown). Also the fallback text when blocks are given." },
      blocks: { type: ["array", "null"], description: "Optional Block Kit blocks, e.g. [{type: 'table', rows: [...]}].", items: { type: "object", additionalProperties: true } as any },
      more: { type: ["boolean", "null"], description: "true if you will keep working after this post (a progress note). Leave it out for your answer." },
      private: { type: ["boolean", "null"], description: "true to show this reply only to the person who asked (\"only you can see this\"), e.g. numbers asked for in a busy channel. Ignored in a DM, which is already private." },
      thread_title: { type: ["string", "null"], description: "A short title for this conversation in the person's sidebar (under 60 characters), on your first reply." },
    }),
    kind: "read", // it posts only into the conversation the person started; no approval
    async run(ctx, a) {
      const place = await placeOf(ctx);
      const text = String(a.text ?? "").replace(/&amp;/g, "&").replace(/&lt;(?![@#!])/g, "<").replace(/&gt;/g, ">").slice(0, 12_000);
      if (!text.trim()) return { text: "Nothing to post.", isError: true };
      // Outside Slack (the API, a test) the post is the reply: recorded the same way, so nothing is retried.
      const endTurn = a.more !== true;
      // The conversation's title in the sidebar, in the agent's words.
      if (place && a.thread_title) await slack(place.app_id, "agents.sessions.rename", { channel_id: place.channel, thread_ts: place.thread_ts, title: String(a.thread_title).slice(0, 60) }).catch(() => null);
      // "Only you can see this": an ephemeral reply to the asker; nothing public is posted for this turn.
      // In a DM (and its assistant threads) everything is already private: post it as the normal reply.
      if (place && a.private && place.channel_type !== "im") {
        const who = ctx.person?.slack_user ?? place.user;
        const r: any = await slack(place.app_id, "chat.postEphemeral", { channel: place.channel, user: who, thread_ts: place.channel_type === "im" ? undefined : place.thread_ts, text, ...(a.blocks?.length ? { blocks: a.blocks } : {}) }).catch((e) => ({ ok: false, error: (e as Error).message }));
        if (r.ok === false) return { text: `Slack refused the private reply (${r.error}).`, isError: true };
        await appendEvent({ sessionId: ctx.sessionId, runId: ctx.runId, type: "slack.post", data: { text, private: true } });
        return { text: "Posted privately.", endTurn };
      }
      if (!place) { await appendEvent({ sessionId: ctx.sessionId, runId: ctx.runId, type: "slack.post", data: { text, outside_slack: true } }); return { text: "Posted.", endTurn }; }
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
      // A hand-made table wraps its columns, so no cell is cut mid-word.
      if (a.blocks?.length) for (const b of a.blocks) if (b?.type === "table" && Array.isArray(b.rows) && !b.column_settings) b.column_settings = (b.rows[0] ?? []).map(() => ({ is_wrapped: true }));
      if (a.blocks?.length) {
        // Blocks can't go into a live stream; they post as their own message in the thread.
        const r = await slack(place.app_id, "chat.postMessage", { channel: place.channel, thread_ts: place.thread_ts, text, blocks: a.blocks }).catch((e) => ({ ok: false, error: (e as Error).message }));
        await appendEvent({ sessionId: ctx.sessionId, runId: ctx.runId, type: "slack.post.blocks", data: { ok: (r as any).ok !== false, ts: (r as any).ts ?? null } });
        if ((r as any).ok === false) return { text: `Slack refused the blocks (${(r as any).error}); post plain text instead.`, isError: true };
        return { text: "Posted.", endTurn };
      }
      await appendEvent({ sessionId: ctx.sessionId, runId: ctx.runId, type: "slack.post", data: { text } });
      return { text: "Posted.", endTurn };
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
