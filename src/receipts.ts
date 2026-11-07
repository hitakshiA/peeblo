// A receipt is a fold over a run's model.call events: what it cost, which models and providers answered,
// how many calls and attempts, and whether anything fell back. Nothing here is stored separately.
import { requestUsage } from "./otari/client.ts";
import { runEvents } from "./store/events.ts";
import { receiptLinks } from "./otari/traces.ts";

export type Receipt = {
  run_id: string; calls: number; cost_usd: number; prompt_tokens: number; cached_tokens: number; completion_tokens: number;
  models: string[]; providers: string[]; fallbacks: number; failed_attempts: number; request_ids: string[]; people: string[];
  interrupted: { request_id: string; settled_cost_usd: number | null }[];
  otari_tools: Record<string, number>; // tool calls Otari ran inside model calls (web_search, web_fetch, …), cost included above
  connector_calls: Record<string, number>; // completed connector calls Otari executed for Peeblo, by server
  approvals: { approved: number; denied: number; expired: number };
  guard: { checked_by: string | null; checks: number; blocked: number }; // which guardrail checked this run
  links: { requests: Record<string, string>; session: string; trace_id: string | null } | null; // into the Otari dashboard
};

export async function buildReceipt(runId: string): Promise<Receipt> {
  const events = await runEvents(runId);
  const calls = events.filter((e) => e.type === "model.call").map((e) => e.data as any);
  // Calls Otari answered but that never finished here (core died mid-stream): take Otari's settled cost.
  const finished = new Set(calls.map((c) => c.request_id));
  const opened = events.filter((e) => e.type === "model.call.opened").map((e) => e.data as any).filter((o) => o.request_id && !finished.has(o.request_id));
  const interrupted = await Promise.all(opened.map(async (o) => {
    const u = await requestUsage(o.request_id).catch(() => null);
    return { request_id: o.request_id as string, settled_cost_usd: u ? Number(u.cost_usd) : null };
  }));
  const sessionId = (events[0] as any)?.session_id as string | undefined;
  const requestIds = [...calls.map((c) => c.request_id).filter(Boolean), ...interrupted.map((i) => i.request_id)];
  const links = sessionId ? await receiptLinks(sessionId, requestIds).catch(() => null) : null;
  const sum = (k: string) => calls.reduce((a, c) => a + (Number(c[k]) || 0), 0);
  const ok = calls.filter((c) => c.status >= 200 && c.status < 300);
  const work = calls.filter((c) => c.role !== "guard");
  const reported = work.filter((c) => typeof c.guardrails === "string" && c.guardrails.includes('"status":"evaluated"')).length;
  // Otari doesn't send the verdict header on streams; a streamed call made while the mandate was on was checked.
  const unreported = work.filter((c) => !c.guardrails && c.status === 200 && c.guard_mandate === true).length;
  const lakeraChecks = reported + unreported;
  const openChecks = events.filter((e) => e.type === "guard.checked");
  const blocked = events.filter((e) => e.type === "guard.blocked").length + openChecks.filter((e) => (e.data as any).safe === false).length;
  const guard = openChecks.length ? { checked_by: String((openChecks[0].data as any).checked_by), checks: openChecks.length, blocked }
    : lakeraChecks || blocked ? { checked_by: unreported ? "lakera (Otari org guardrail; streamed verdicts not reported)" : "lakera (Otari org guardrail)", checks: lakeraChecks + blocked, blocked } : { checked_by: null, checks: 0, blocked: 0 };
  return {
    run_id: runId,
    calls: ok.length,
    cost_usd: Math.round((sum("cost_usd") + interrupted.reduce((a, i) => a + (i.settled_cost_usd ?? 0), 0)) * 1e6) / 1e6,
    prompt_tokens: sum("prompt_tokens"),
    cached_tokens: sum("cached_tokens"),
    completion_tokens: sum("completion_tokens"),
    guard,
    models: [...new Set(ok.filter((c) => c.role !== "guard").map((c) => c.served_model ?? c.requested_model).filter(Boolean))],
    providers: [...new Set(ok.map((c) => c.provider).filter(Boolean))],
    fallbacks: calls.filter((c) => c.otari_fallback || c.peebloFallback).length,
    failed_attempts: calls.filter((c) => c.failed || c.status >= 400).length,
    request_ids: requestIds,
    links,
    people: [...new Set(calls.map((c) => c.end_user).filter(Boolean))],
    interrupted,
    otari_tools: events.filter((e) => e.type === "tool.call" && (e.data as any).by === "otari" && (e.data as any).status === "completed")
      .reduce((acc: Record<string, number>, e) => { const t = (e.data as any).tool; acc[t] = (acc[t] ?? 0) + 1; return acc; }, {}),
    connector_calls: events.filter((e) => e.type === "tool.call" && (e.data as any).via === "otari_mcp" && (e.data as any).status === "completed")
      .reduce((acc: Record<string, number>, e) => { const s = (e.data as any).server; acc[s] = (acc[s] ?? 0) + 1; return acc; }, {}),
    approvals: events.filter((e) => e.type === "approval.resolved").reduce((acc, e) => { const st = (e.data as any).status as "approved" | "denied" | "expired"; acc[st] = (acc[st] ?? 0) + 1; return acc; }, { approved: 0, denied: 0, expired: 0 }),
  };
}

export function receiptLine(r: Receipt): string {
  if (!r.models.length && r.guard.blocked) return `blocked by the guardrail (${r.guard.checked_by}) before the teammate ran · ${money(r.cost_usd)}`;
  const via = r.providers.length ? ` via ${r.providers.join(", ")}` : "";
  return `${r.models.join(" → ") || "no model"}${via} · ${r.calls} call${r.calls === 1 ? "" : "s"} · ${money(r.cost_usd)}${Object.entries(r.otari_tools).map(([t, n]) => ` · ${n} ${t.replace("_", " ")}`).join("")}${Object.entries(r.connector_calls).map(([s, n]) => ` · ${n} ${s}`).join("")}${r.approvals.approved ? ` · ${r.approvals.approved} approved` : ""}${r.approvals.denied ? ` · ${r.approvals.denied} declined` : ""}${r.fallbacks ? ` · ${r.fallbacks} fallback` : ""}${r.interrupted.length ? ` · ${r.interrupted.length} interrupted` : ""} · guard: ${r.guard.checked_by ?? "none"}${r.guard.blocked ? " (blocked)" : ""}`;
}

// Small runs cost fractions of a cent; show enough digits that a real cost never reads as $0.
const money = (usd: number) => (usd === 0 ? "$0" : usd < 0.01 ? `$${usd.toFixed(6)}` : `$${usd.toFixed(4)}`);
