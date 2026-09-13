// Client for the Peeblo agent service (agent/src/main.ts).
export const PEEBLO_API = (import.meta.env.VITE_PEEBLO_API as string | undefined) ?? "https://api.peeblo.xyz";

export interface RoomEvent { seq: number; case_id: string; run_id?: string; type: string; data: any; at: string }
export interface CaseSummary { id: string; title: string; objective: string; status: string; summary: string | null; next_action: string | null; updated_at: string; created_at: string; active: boolean; apps: string[]; wakeup: { due_at: string; reason: string } | null }
export interface CaseDetail extends CaseSummary {
  evidence: { source: string; ref: string | null; fact: string; created_at: string }[];
  operations: { id: string; kind: string; params: any; amount: number | null; authority: string; status: string; verification: string | null; error: string | null }[];
  approvals: { id: string; operation_id: string; status: string; approver: string | null; decided_at: string | null }[];
  runs: { trigger: string; status: string; started_at: string }[];
  interrupt_armed: string | null;
  plan?: { step: string; status: string; note?: string }[];
}

const call = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(`${PEEBLO_API}${path}`, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json();
};

export const room = {
  cases: () => call<CaseSummary[]>("/api/cases"),
  case: (id: string) => call<CaseDetail>(`/api/cases/${id}`),
  assign: (objective: string) => call<CaseSummary>("/api/cases", { method: "POST", body: JSON.stringify({ objective }) }),
  decide: (approvalId: string, decision: "approved" | "rejected") => call(`/api/approvals/${approvalId}/decide`, { method: "POST", body: JSON.stringify({ decision }) }),
  resume: (id: string) => call(`/api/cases/${id}/resume`, { method: "POST", body: "{}" }),
  interrupt: (id: string, mode: "now" | "after_next_write") => call(`/api/cases/${id}/interrupt`, { method: "POST", body: JSON.stringify({ mode }) }),
  reset: (scenario: string) => call<{ code: number; output: string }>("/api/demo/reset", { method: "POST", body: JSON.stringify({ scenario }) }),
  // Replay mode (for recordings): streams a finished run's stored events with real gaps compressed to watchable pacing.
  replay: (id: string, onEvent: (e: RoomEvent) => void, speed = 1) => {
    let stop = false;
    call<RoomEvent[]>(`/api/cases/${id}/events`).then(async (evts) => {
      for (let i = 0; i < evts.length && !stop; i++) {
        const gap = i ? Date.parse(evts[i].at) - Date.parse(evts[i - 1].at) : 0;
        const wait = evts[i].type === "thinking" ? 18 : Math.min(Math.max(gap, 120), 1400);
        await new Promise((r) => setTimeout(r, wait / speed));
        if (!stop) onEvent(evts[i]);
      }
    });
    return () => { stop = true; };
  },
  // Recording mode: the event log is pushed by a driver script (window.__room.pushTo) instead of a timer.
  director: (id: string, onEvent: (e: RoomEvent) => void) => {
    let stop = false, next = 0;
    call<RoomEvent[]>(`/api/cases/${id}/events`).then((evts) => {
      (window as any).__room = {
        total: evts.length,
        pushTo: async (end: number, ms = 0, skip: number[] = []) => {
          const batch = [];
          for (; next <= Math.min(end, evts.length - 1); next++) if (!skip.includes(next)) batch.push(evts[next]);
          const gap = batch.length ? ms / batch.length : 0;
          for (const e of batch) { if (stop) return; onEvent(e); if (gap) await new Promise((r) => setTimeout(r, gap)); }
        },
      };
    });
    return () => { stop = true; };
  },
  stream: (id: string, onEvent: (e: RoomEvent) => void) => {
    const es = new EventSource(`${PEEBLO_API}/api/cases/${id}/stream`);
    const handler = (m: MessageEvent) => onEvent(JSON.parse(m.data));
    ["run.started", "thinking", "message", "tool.started", "tool.finished", "operation.submitted", "operation.verified", "operation.reconciled", "operation.step", "operation.resuming", "approval.requested", "approval.decided", "interrupt.armed", "plan.updated", "run.retry", "run.finished"].forEach((t) => es.addEventListener(t, handler));
    return () => es.close();
  },
};

export const usd = (n: number | null | undefined) => n == null ? "—" : `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 })}`;
