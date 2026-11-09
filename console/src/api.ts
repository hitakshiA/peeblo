// The console's API client: same-origin JSON under /v1, with the login cookie.
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, { method, credentials: "same-origin", headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, (j as any).error ?? `${r.status}`);
  return j as T;
}
export const get = <T = any>(p: string) => api<T>("GET", p);
export const post = <T = any>(p: string, b: unknown = {}) => api<T>("POST", p, b);

// One friendly line for any failure: the server's sentence when it sent one, never a stack or a bare status.
export function friendly(e: unknown, fallback = "Something went wrong. Try again."): string {
  if (e instanceof ApiError) {
    if (e.status === 401) return "You're signed out. Sign in again.";
    const m = String(e.message ?? "").split("\n")[0].trim();
    if (!m || /^\d+$/.test(m)) return e.status >= 500 ? "Peeblo hit a problem. Try again in a moment." : fallback;
    return (m[0].toUpperCase() + m.slice(1)).slice(0, 200);
  }
  if (e instanceof TypeError) return "Can't reach Peeblo. Is it running?";
  return fallback;
}

export type Face = { shape: string; color: string };
export type Teammate = {
  id: string; slug: string; version: number; owner_person: string | null; face?: Face | null; hidden?: boolean;
  config: { name: string; role: string; instructions: string; model: { default: string; fallback?: string }; budget: { monthly_usd: number }; tools: string[]; connectors: string[]; mode: "ask" | "auto" | "trusted" | "yolo"; computer?: { size: "small" | "large" } };
};
export type RunEvent = { id: string; type: string; data: any; at: string };

// First-run setup (GET /v1/setup/state). `next` is the step to do now.
export const STEPS = ["password", "otari", "connect", "readiness", "public_url", "slack", "done"] as const;
export type StepId = (typeof STEPS)[number];
export type ReadinessItem = { id: string; label: string; ok: boolean | null; detail: string; fix_url?: string; fix_text?: string };
export type SetupState = {
  password_set: boolean;
  mode: "setup" | "running";
  otari: {
    key_set: boolean; key_ok: boolean; key_error?: string; region: string; org?: string; used_usd?: number; limit_usd?: number;
    connected: boolean; signed_in_as?: string; session_expires_at?: string;
    links: { dashboard: string; keys: string; budgets: string; guardrails: string; tools: string; mcp: string; set_password?: string };
  };
  public_url: { value: string | null; reachable: boolean; error?: string; hint: string };
  slack: { token_set: boolean; token_ok: boolean; app_created: boolean; install_url: string | null; installed: boolean; workspace?: string; peeblo_dm_url?: string };
  admins: { slack_user: string; display_name: string | null }[];
  readiness: ReadinessItem[];
  next: StepId;
};

export type Connector = {
  name: string; label: string; icon_url: string | null; purpose: string | null; healthy: boolean | null; tools: number | null;
  used_by: { slug: string; name: string; read_only: boolean }[];
};

export const money = (v: number | null | undefined) => (v == null ? "—" : v < 0.01 ? `$${Number(v).toFixed(4)}` : `$${Number(v).toFixed(2)}`);
export const when = (s?: string | null) => (s ? new Date(s).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
