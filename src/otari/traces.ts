// Otari groups a Peeblo session's calls into one trace (from Otari-Conversation-Id), named after the session.
// Its trace id isn't derivable from ours, and only the dashboard session can read traces, so with a session
// Peeblo looks the trace up from any request id of the session (org usage → source_label) and links to it;
// without one, the receipt links to a dashboard search for the session instead.
import { admin, session } from "./admin.ts";
import { links } from "./links.ts";

const traceBySession = new Map<string, string>();

async function traceIdForRequest(requestId: string): Promise<string | null> {
  const r = await admin<any>(
    "GET",
    `/organizations/me/usage?request_group_id=${encodeURIComponent(requestId)}&limit=1`,
    undefined,
    "finding a request's trace",
    links.request(requestId),
  );
  return ((r.data ?? r) as { source_label?: string }[])[0]?.source_label ?? null;
}

// Links for a receipt: every request, and the session's trace (or a search for it).
export async function receiptLinks(
  sessionId: string,
  requestIds: string[],
): Promise<{ requests: Record<string, string>; session: string; trace_id: string | null }> {
  const requests = Object.fromEntries(requestIds.filter((id) => /^[0-9a-f-]{36}$/.test(id)).map((id) => [id, links.request(id)]));
  let traceId = traceBySession.get(sessionId) ?? null;
  const s = await session().catch(() => null);
  if (!traceId && s) {
    for (const id of Object.keys(requests)) {
      traceId = await traceIdForRequest(id).catch(() => null);
      if (traceId) {
        traceBySession.set(sessionId, traceId);
        break;
      }
    }
  }
  return { requests, session: traceId ? links.session(traceId, s?.workspaceId) : links.sessionsFor({ q: sessionId }), trace_id: traceId };
}
