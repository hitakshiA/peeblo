// Speaking in Slack is a deliberate tool call; a turn's final text is private. Both tools act only on the
// conversation the session belongs to (its own thread or DM): there is no channel argument to point elsewhere.
import { config } from "../config.ts";
import { pool } from "../db.ts";
import { appendEvent } from "../store/events.ts";
import { getSession, slackPlaceOf } from "../store/sessions.ts";
import { react, slack } from "../slack/api.ts";
import { object } from "./schema.ts";
import type { AgentTool } from "./types.ts";

const EMOJI = /^[a-z0-9_+-]{1,40}$/;
const UNPROMPTED_PER_HOUR = config.unpromptedPerHour;

export const slackTools: AgentTool[] = [
  {
    name: "channel_watch",
    description:
      'Start or stop keeping an eye on a Slack channel: while watching, you read every message there and step in only when it helps. Only when a person asks ("keep an eye on #support", "stop watching"); by default you answer only when tagged.',
    input_schema: object({
      channel: { type: ["string", "null"], description: "The channel's name (#support) or id; leave out for this conversation's channel." },
      watch: { type: "boolean", description: "true to start watching, false to stop." },
    }),
    kind: "local",
    async authorize(ctx) {
      return ctx.teammate.slug === "peeblo" ? null : "Only Peeblo watches channels; teammates answer when tagged.";
    },
    async run(ctx, a) {
      const place = await slackPlaceOf(ctx.sessionId);
      if (!place) return { text: "This conversation isn't in Slack, so there's no channel to watch.", isError: true };
      let channel = place.channel;
      const want = String(a.channel ?? "")
        .trim()
        .replace(/^#/, "");
      if (want) {
        if (/^[CG][A-Z0-9]{6,}$/.test(want)) channel = want;
        else {
          let cursor: string | undefined;
          let found: string | null = null;
          for (let i = 0; i < 10 && !found; i++) {
            const r: any = await slack(place.app_id, "conversations.list", {
              types: "public_channel,private_channel",
              limit: 200,
              exclude_archived: true,
              ...(cursor ? { cursor } : {}),
            }).catch(() => null);
            found = r?.channels?.find((c: any) => c.name === want.toLowerCase())?.id ?? null;
            cursor = r?.response_metadata?.next_cursor || undefined;
            if (!cursor) break;
          }
          if (!found)
            return {
              text: `There's no channel called #${want} that Peeblo can see. Invite Peeblo to it first (/invite @Peeblo).`,
              isError: true,
            };
          channel = found;
        }
      }
      if (place.channel_type === "im" && !want) return { text: "Name the channel to watch, e.g. #support.", isError: true };
      await pool.query(
        `INSERT INTO channel_settings (team_id, channel, attention) VALUES ($1, $2, $3)
         ON CONFLICT (team_id, channel) DO UPDATE SET attention = EXCLUDED.attention, updated_at = now()`,
        [place.team, channel, a.watch ? "listen" : "mentions"],
      );
      await appendEvent({
        sessionId: ctx.sessionId,
        runId: ctx.runId,
        type: "channel.attention",
        data: { channel, attention: a.watch ? "listen" : "mentions", by: ctx.person?.id ?? null },
      });
      return {
        text: a.watch
          ? `Watching <#${channel}> now: you'll read every message there and step in only when it helps.`
          : `Stopped watching <#${channel}>: you'll answer there only when tagged.`,
      };
    },
  },
  {
    name: "slack_post",
    description:
      "Post where this conversation lives: your thread or DM, or, for a routine, watch or trigger, the channel it was set up to post in (a new message there, which starts the thread). To tell another channel you're in (report an incident to #incidents, a heads-up in #eng), give channel: that's a new message there, and a person approves it first; then answer here as usual. Your final text is not shown to anyone, so anything people should see goes through here. Posting your answer ends your turn, so post it last and on its own (not alongside other tool calls). Set more: true only for a progress note when you will keep working. Slack markdown; for a table or other layout, pass Block Kit blocks.",
    input_schema: object({
      text: { type: "string", description: "What to say (Slack markdown). Also the fallback text when blocks are given." },
      blocks: {
        type: ["array", "null"],
        description: "Optional Block Kit blocks, e.g. [{type: 'table', rows: [...]}].",
        items: { type: "object", additionalProperties: true } as any,
      },
      more: {
        type: ["boolean", "null"],
        description: "true if you will keep working after this post (a progress note). Leave it out for your answer.",
      },
      private: {
        type: ["boolean", "null"],
        description:
          'true to show this reply only to the person who asked ("only you can see this"), e.g. numbers asked for in a busy channel. Ignored in a DM, which is already private.',
      },
      thread_title: {
        type: ["string", "null"],
        description: "A short title for this conversation in the person's sidebar (under 60 characters), on your first reply.",
      },
      channel: {
        type: ["string", "null"],
        description: "Another channel you're a member of, by name (#incidents) or id, for a new message there. Leave it out to post here.",
      },
    }),
    kind: "read", // into the conversation the person started: no approval. Another channel: see outward
    // A post in another channel speaks for the team outside this conversation: a person approves it first.
    outward: (_ctx, a) => (a.channel ? "outside_thread" : null),
    async run(ctx, a) {
      const place = await slackPlaceOf(ctx.sessionId);
      const text = String(a.text ?? "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;(?![@#!])/g, "<")
        .replace(/&gt;/g, ">")
        .slice(0, 12_000);
      if (!text.trim()) return { text: "Nothing to post.", isError: true };
      if (a.channel) {
        if (!place) return { text: "There's no Slack workspace here to post in.", isError: true };
        const want = String(a.channel).replace(/^#/, "").toLowerCase();
        const list: any = await slack(place.app_id, "conversations.list", {
          types: "public_channel,private_channel",
          exclude_archived: true,
          limit: 1000,
        }).catch(() => null);
        const ch = (list?.channels ?? []).find((c: any) => c.id.toLowerCase() === want || String(c.name).toLowerCase() === want);
        if (!ch) return { text: `There's no channel ${a.channel} in this workspace.`, isError: true };
        if (!ch.is_member) return { text: `You're not in #${ch.name}; ask someone there to add you.`, isError: true };
        const r: any = await slack(place.app_id, "chat.postMessage", {
          channel: ch.id,
          text,
          ...(a.blocks?.length ? { blocks: a.blocks } : {}),
        }).catch((e) => ({ ok: false, error: (e as Error).message }));
        if (r.ok === false) return { text: `Slack refused the post in #${ch.name} (${r.error}).`, isError: true };
        const link: any = await slack(place.app_id, "chat.getPermalink", { channel: ch.id, message_ts: r.ts }).catch(() => null);
        await appendEvent({ sessionId: ctx.sessionId, runId: ctx.runId, type: "slack.post.elsewhere", data: { text, channel: ch.id, ts: r.ts } });
        return { text: `Posted in #${ch.name}${link?.permalink ? `: ${link.permalink}` : ""}. Now answer here.` };
      }
      // Outside Slack (the API, a test) the post is the reply: recorded the same way, so nothing is retried.
      const endTurn = a.more !== true;
      // The conversation's title in the sidebar, in the agent's words.
      if (place && a.thread_title)
        await slack(place.app_id, "agents.sessions.rename", {
          channel_id: place.channel,
          thread_ts: place.thread_ts,
          title: String(a.thread_title).slice(0, 60),
        }).catch(() => null);
      // "Only you can see this": an ephemeral reply to the asker; nothing public is posted for this turn.
      // In a DM (and its assistant threads) everything is already private: post it as the normal reply.
      if (place && a.private && place.channel_type !== "im") {
        const who = ctx.person?.slack_user ?? place.user;
        const r: any = await slack(place.app_id, "chat.postEphemeral", {
          channel: place.channel,
          user: who,
          thread_ts: place.channel_type === "im" ? undefined : place.thread_ts,
          text,
          ...(a.blocks?.length ? { blocks: a.blocks } : {}),
        }).catch((e) => ({ ok: false, error: (e as Error).message }));
        if (r.ok === false) return { text: `Slack refused the private reply (${r.error}).`, isError: true };
        await appendEvent({ sessionId: ctx.sessionId, runId: ctx.runId, type: "slack.post", data: { text, private: true } });
        return { text: "Posted privately.", endTurn };
      }
      if (!place) {
        await appendEvent({ sessionId: ctx.sessionId, runId: ctx.runId, type: "slack.post", data: { text, outside_slack: true } });
        return { text: "Posted.", endTurn };
      }
      // Unprompted posts (no one asked this teammate in this conversation) are rate-limited per channel, and a
      // thread someone marked 👎 gets none.
      if (!place.direct) {
        const s = await getSession(ctx.sessionId);
        if ((s?.place as any)?.muted)
          return { text: "Someone marked a reply here as not helpful, so you stay quiet in this thread unless asked.", isError: true };
        const { rows } = await pool.query(
          `SELECT count(*)::int AS n FROM events e JOIN sessions s ON s.id = e.session_id
            WHERE e.type IN ('slack.post', 'slack.post.blocks') AND e.at > now() - interval '1 hour' AND s.teammate_id = $1 AND s.place->'slack'->>'channel' = $2 AND (s.place->'slack'->>'direct')::boolean IS NOT TRUE`,
          [ctx.teammate.id, place.channel],
        );
        if (rows[0].n >= UNPROMPTED_PER_HOUR)
          return {
            text: `You've already posted ${rows[0].n} times unprompted in this channel in the last hour; stay quiet unless someone asks you.`,
            isError: true,
          };
      }
      // A hand-made table wraps its columns, so no cell is cut mid-word.
      if (a.blocks?.length)
        for (const b of a.blocks)
          if (b?.type === "table" && Array.isArray(b.rows) && !b.column_settings)
            b.column_settings = (b.rows[0] ?? []).map(() => ({ is_wrapped: true }));
      if (a.blocks?.length) {
        // Blocks can't go into a live stream; they post as their own message in the thread.
        const r = await slack(place.app_id, "chat.postMessage", {
          channel: place.channel,
          thread_ts: place.thread_ts,
          text,
          blocks: a.blocks,
        }).catch((e) => ({ ok: false, error: (e as Error).message }));
        await appendEvent({
          sessionId: ctx.sessionId,
          runId: ctx.runId,
          type: "slack.post.blocks",
          data: { ok: (r as any).ok !== false, ts: (r as any).ts ?? null },
        });
        if ((r as any).ok === false)
          return { text: `Slack refused the blocks (${(r as any).error}); post plain text instead.`, isError: true };
        return { text: "Posted.", endTurn };
      }
      await appendEvent({ sessionId: ctx.sessionId, runId: ctx.runId, type: "slack.post", data: { text } });
      return { text: "Posted.", endTurn };
    },
  },
  {
    name: "slack_read_thread",
    description:
      "Read the Slack thread you're in (or another one, from its link): every message with who wrote it, people and teammates alike. Use it when someone refers to what was said or done in the thread, or before summing up others' work.",
    input_schema: object({
      link: { type: ["string", "null"], description: "A Slack message link, for another thread; leave out for this one." },
      limit: { type: ["integer", "null"], minimum: 1, maximum: 100 },
    }),
    kind: "read",
    async run(ctx, a) {
      const place = await slackPlaceOf(ctx.sessionId);
      if (!place) return { text: "This conversation isn't in Slack.", isError: true };
      let channel = place.channel,
        ts = place.thread_ts ?? place.trigger_ts;
      const m = /archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:.*thread_ts=(\d+\.\d+))?/.exec(String(a.link ?? ""));
      if (m) {
        channel = m[1];
        ts = m[4] ?? `${m[2]}.${m[3]}`;
      }
      // Someone else's DM (or group DM) with this teammate stays private: only the one you're in.
      if (channel !== place.channel && /^D/.test(channel))
        return {
          text: "That thread is in a direct message with someone else, which stays private. Ask them to share what matters in this conversation.",
          isError: true,
        };
      const r: any = await slack(place.app_id, "conversations.replies", { channel, ts, limit: Math.min(Number(a.limit ?? 50), 100) }).catch(
        (e: any) => ({ error: e.message }),
      );
      if (!r.messages)
        return {
          text: `Couldn't read that thread (${r.error ?? "no messages"}). It may be in a channel this app isn't in.`,
          isError: true,
        };
      const { displayName } = await import("../slack/api.ts");
      const lines: string[] = [];
      for (const x of r.messages) {
        const who = (x.user ? await displayName(place.app_id, x.user) : null) ?? x.bot_profile?.name ?? x.username ?? "someone";
        const at = new Date(Number(x.ts) * 1000).toISOString().slice(11, 16);
        lines.push(
          `${who} (${at} UTC): ${String(x.text ?? "")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .slice(0, 1500)}`,
        );
      }
      return { text: lines.join("\n\n"), untrusted: `slack:${channel}` } as any;
    },
  },
  {
    name: "slack_read_channel",
    description:
      'Read recent messages in a Slack channel you\'re a member of (this one by default, or another by name): who said what and when, with each thread\'s replies when you ask for them. Use it when someone refers to what was said in a channel ("what did Felix promise in #sales", "catch me up on #support"). Never reads anyone\'s DMs.',
    input_schema: object({
      channel: {
        type: ["string", "null"],
        description: "The channel's name (#sales) or id; leave out for the channel this conversation is in.",
      },
      limit: { type: ["integer", "null"], minimum: 1, maximum: 100, description: "How many recent top-level messages (default 40)." },
      with_replies: { type: ["boolean", "null"], description: "Also read the replies of threads among them (up to 10 threads)." },
    }),
    kind: "read",
    async run(ctx, a) {
      const place = await slackPlaceOf(ctx.sessionId);
      if (!place) return { text: "This conversation isn't in Slack.", isError: true };
      const want = String(a.channel ?? "")
        .trim()
        .replace(/^#/, "");
      let channel = place.channel;
      if (want) {
        if (/^[CG][A-Z0-9]{6,}$/.test(want)) channel = want;
        else {
          let cursor: string | undefined,
            found: string | null = null;
          for (let i = 0; i < 10 && !found; i++) {
            const r: any = await slack(place.app_id, "conversations.list", {
              types: "public_channel,private_channel",
              limit: 200,
              exclude_archived: true,
              ...(cursor ? { cursor } : {}),
            }).catch(() => null);
            found = r?.channels?.find((c: any) => c.name === want.toLowerCase())?.id ?? null;
            cursor = r?.response_metadata?.next_cursor || undefined;
            if (!cursor) break;
          }
          if (!found) return { text: `There's no channel called #${want} that you can see.`, isError: true };
          channel = found;
        }
      }
      if (/^D/.test(channel) || (channel === place.channel && /^(im|mpim)$/.test(place.channel_type)))
        return {
          text: "That's a direct message, not a channel; read this conversation with slack_read_thread. Other people's DMs stay private.",
          isError: true,
        };
      const r: any = await slack(place.app_id, "conversations.history", { channel, limit: Math.min(Number(a.limit ?? 40), 100) }).catch(
        (e: any) => ({ error: e.message }),
      );
      if (!r.messages)
        return {
          text: `Couldn't read <#${channel}> (${r.error ?? "no messages"}). ${/not_in_channel/.test(String(r.error)) ? "You're not a member there; someone can /invite you." : ""}`.trim(),
          isError: true,
        };
      const { displayName } = await import("../slack/api.ts");
      const clean = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      const line = async (x: any, indent = "") => {
        const who = (x.user ? await displayName(place.app_id, x.user) : null) ?? x.username ?? x.bot_profile?.name ?? "someone";
        const at = new Date(Number(x.ts) * 1000).toISOString().slice(0, 16).replace("T", " ");
        return `${indent}${who} (${at} UTC)${x.reply_count ? ` [${x.reply_count} replies]` : ""}: ${clean(String(x.text ?? "")).slice(0, 1200)}`;
      };
      const msgs = (r.messages as any[]).filter((x) => !/^(channel_join|channel_leave|tombstone)$/.test(x.subtype ?? "")).reverse();
      const lines: string[] = [];
      let threads = 0;
      for (const x of msgs) {
        lines.push(await line(x));
        if (a.with_replies && x.reply_count && threads < 10) {
          threads++;
          const t: any = await slack(place.app_id, "conversations.replies", { channel, ts: x.ts, limit: 30 }).catch(() => null);
          for (const y of (t?.messages ?? []).slice(1)) lines.push(await line(y, "    ↳ "));
        }
      }
      return { text: lines.join("\n") || "No messages there yet.", untrusted: `slack:${channel}` } as any;
    },
  },
  {
    name: "slack_react",
    description: "React with an emoji to the message you were asked in (e.g. 'thumbsup', 'eyes', 'white_check_mark').",
    input_schema: object({ emoji: { type: "string" } }),
    kind: "read",
    async run(ctx, a) {
      const place = await slackPlaceOf(ctx.sessionId);
      if (!place) return { text: "This conversation isn't in Slack.", isError: true };
      const name = String(a.emoji ?? "").replace(/:/g, "");
      if (!EMOJI.test(name)) return { text: "That isn't an emoji name.", isError: true };
      await react(place.app_id, place.channel, place.trigger_ts, name);
      return { text: "Reacted." };
    },
  },
];
