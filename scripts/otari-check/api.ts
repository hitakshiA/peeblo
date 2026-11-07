// Drives the running core through its API, for checks that need a real teammate turn (Pi → proxy → Otari).
import { config } from "../../src/config.ts";

const base = `http://${config.apiHost === "0.0.0.0" ? "127.0.0.1" : config.apiHost}:${config.apiPort}`;
const H = { authorization: `Bearer ${config.adminToken}`, "content-type": "application/json" };

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(base + path, { method, headers: H, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${JSON.stringify(j)}`);
  return j as T;
}

export const OWNER = { slack_team: "T0CFKBN3YPM", slack_user: "U0CGL01BU72", display_name: "Hitakshi" };

export async function ensureTeammate(slug: string, config: Record<string, unknown>): Promise<void> {
  try { await api("POST", "/v1/teammates", { slug, ...config }); }
  catch (e) { if (!String(e).includes("409")) throw e; await api("PATCH", `/v1/teammates/${slug}`, { ...config, note: "otari-check" }); }
}

export const MAYA = { slack_team: "T0CFKBN3YPM", slack_user: "U0CFKNZLLSF", display_name: "Maya Okafor" };

export async function submit(slug: string, place: string, text: string, requestId: string, person = OWNER): Promise<{ sessionId: string; runId: string }> {
  const s = await api<{ id: string }>("POST", `/v1/teammates/${slug}/sessions`, { kind: "thread", place_key: place });
  const r = await api<{ run_id: string }>("POST", `/v1/sessions/${s.id}/submissions`, { text, request_id: requestId, person });
  return { sessionId: s.id, runId: r.run_id };
}

// Waits for the run to settle; answers any approval it asks for with `answer` (or leaves it).
export async function settle(runId: string, opts: { timeoutMs?: number; answer?: "approved" | "denied"; answerAs?: string | null } = {}): Promise<{ run: any; events: any[] }> {
  const until = Date.now() + (opts.timeoutMs ?? 300_000);
  const answered = new Set<string>();
  while (Date.now() < until) {
    const j = await api<{ run: any; events: any[] }>("GET", `/v1/runs/${runId}`);
    if (opts.answer) for (const e of j.events.filter((x) => x.type === "approval.requested")) {
      const id = e.data.approval_id;
      if (answered.has(id) || j.events.some((x) => x.type === "approval.resolved" && x.data.approval_id === id)) continue;
      answered.add(id);
      await api("POST", `/v1/approvals/${id}`, { decision: opts.answer, scope: "once", ...(opts.answerAs ? { person_id: opts.answerAs } : {}) });
    }
    if (["done", "failed", "cancelled"].includes(j.run.status)) return j;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`run ${runId} did not settle`);
}

export const calls = (events: any[]) => events.filter((e) => e.type === "model.call").map((e) => e.data);
export const tools = (events: any[]) => events.filter((e) => e.type === "tool.call").map((e) => e.data);
export const answer = (events: any[]) => events.filter((e) => e.type === "turn.finished").map((e) => e.data.text).pop() ?? "";
