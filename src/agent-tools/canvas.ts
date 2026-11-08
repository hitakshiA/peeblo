// canvas_write: a long deliverable (a brief, a close pack, release notes, a plan) as a Slack canvas, shared with the
// conversation and linked from the reply. The reply stays short; the canvas holds the detail. Updating the same
// canvas later replaces its content (canvas_id from the first call).
import { getSession } from "../store/sessions.ts";
import { appendEvent } from "../store/events.ts";
import { slack } from "../slack/api.ts";
import type { SlackPlace } from "../slack/inbound.ts";
import { object } from "./schema.ts";
import type { AgentTool } from "./types.ts";

export const canvasTool: AgentTool = {
  name: "canvas_write",
  description: "Put a long deliverable (a brief, a report, release notes, a plan; more than a screen of text) in a Slack canvas shared with this conversation, then link it in a one-line reply. Markdown with headings, lists and tables. Pass canvas_id to replace a canvas you made earlier.",
  input_schema: object({
    title: { type: "string" },
    markdown: { type: "string", description: "The canvas content in Markdown." },
    canvas_id: { type: ["string", "null"], description: "To update a canvas you made earlier." },
  }),
  kind: "read", // it shares only into the conversation the person started
  async run(ctx, a) {
    const place = ((await getSession(ctx.sessionId))?.place as any)?.slack as SlackPlace | undefined;
    if (!place) return { text: "This conversation isn't in Slack, so there's nowhere to put a canvas. Reply with the content instead.", isError: true };
    const content = { type: "markdown", markdown: String(a.markdown).slice(0, 100_000) };
    try {
      let id = a.canvas_id as string | null;
      if (id) await slack(place.app_id, "canvases.edit", { canvas_id: id, changes: [{ operation: "replace", document_content: content }] });
      else {
        const r: any = await slack(place.app_id, "canvases.create", { title: String(a.title).slice(0, 150), document_content: content });
        id = r.canvas_id;
        // Everyone in the conversation can read it: the channel, or the person in a DM.
        await slack(place.app_id, "canvases.access.set", { canvas_id: id, access_level: "read", ...(place.channel_type === "im" ? { user_ids: [ctx.person?.slack_user ?? place.user] } : { channel_ids: [place.channel] }) }).catch(() => null);
      }
      const url = `https://app.slack.com/docs/${place.team}/${id}`;
      await appendEvent({ sessionId: ctx.sessionId, runId: ctx.runId, type: "slack.canvas", data: { canvas_id: id, title: a.title, url, updated: Boolean(a.canvas_id) } });
      return { text: `Canvas ${a.canvas_id ? "updated" : "made"}: ${url} (canvas_id ${id}). Link it in a one-line reply: <${url}|${a.title}>.` };
    } catch (e) {
      const msg = (e as Error).message;
      return { text: /missing_scope|not_allowed|invalid_auth/.test(msg) ? `Slack won't let this app make canvases yet (${msg}); the app needs re-installing with canvas access. Reply with a short summary instead.` : `The canvas failed: ${msg.slice(0, 200)}`, isError: true };
    }
  },
};
