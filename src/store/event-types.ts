// The shapes of the events that are read back (receipts, the Slack view, the console, work memory). Each lists the
// fields readers use; writers may add more (the log keeps whatever was written).
type Open = Record<string, unknown>;

// Calls through the proxy carry every field; side calls (the guard, the vision model) only the first line's.
export type ModelCallEvent = Open & {
  status: number;
  request_id: string | null;
  requested_model: string | null;
  served_model?: string | null;
  cost_usd: number | null;
  ms: number;
  turn?: number;
  path?: string;
  provider?: string | null;
  attempts?: number | null;
  otari_fallback?: boolean;
  error_code?: string | null;
  guardrails?: string | null;
  prompt_tokens?: number | null;
  cached_tokens?: number | null;
  completion_tokens?: number | null;
  end_user?: string | null;
  key?: string;
  guard_mandate?: boolean | null;
  tools_declared?: number | null;
  failed?: boolean;
  error?: string;
  role?: string;
  peebloFallback?: boolean;
  firstChunkMs?: number | null;
};

type ToolCallEvent = Open & {
  turn?: number;
  by: "peeblo" | "otari";
  id: string;
  tool: string;
  status: string;
  kind?: string;
  via?: string;
  server?: string;
  summary?: string;
  error?: string | null;
  sources?: string[];
  result?: Open & { run_id?: string; cost_usd?: number | string | null };
  args_preview?: string;
};

export type EventMap = {
  "model.call": ModelCallEvent;
  "model.call.opened": Open & { turn?: number; request_id: string | null; status: number; requested_model: string | null };
  "tool.call": ToolCallEvent;
  "tool.cost": Open & { cost_usd: number | string | null };
  "slack.post": Open & { text: string; private?: boolean; outside_slack?: boolean };
  "turn.started": Open & { turn: number };
  "turn.finished": Open & { turn: number; text: string; stop_reason: string | null };
  "guard.checked": Open & { checked_by: string | null; safe: boolean; source?: string; score?: number | null };
  "guard.blocked": Open & { checked_by?: string };
  "budget.blocked": Open & {
    by: "peeblo" | "otari";
    scope?: string | null;
    spent?: number | null;
    cap?: number | null;
    estimate?: number | null;
    message?: string;
  };
  "approval.requested": Open & { approval_id: string; action?: Open };
  "approval.resolved": Open & { status: "approved" | "denied" | "expired"; approval_id?: string };
  "run.queued": Open & { ahead: number; max_running: number };
  "run.refused": Open & { reason: string; teammate_id: string };
  "plan.updated": Open & { steps: { step: string; status: string }[] };
  "job.model": Open & { model: string; by: "otari_router" | "escalation"; reason?: string | null };
  "run.merged": Open & { into: string; steered?: boolean };
};

export type KnownEvent = keyof EventMap;
// An event's data with the shape its type promises (a type the log doesn't describe stays open).
export type DataOf<T extends string> = T extends KnownEvent ? EventMap[T] : Open;
export const dataOf = <T extends KnownEvent>(e: { type: string; data: unknown }, _type: T): EventMap[T] => e.data as EventMap[T];
