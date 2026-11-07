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

export type Teammate = {
  id: string; slug: string; version: number; owner_person: string | null;
  config: { name: string; role: string; instructions: string; model: { default: string; fallback?: string }; budget: { monthly_usd: number }; tools: string[]; connectors: string[]; mode: "ask" | "auto" | "trusted" | "yolo"; computer?: { size: "small" | "large" } };
};
export type RunEvent = { id: string; type: string; data: any; at: string };

export const money = (v: number | null | undefined) => (v == null ? "—" : v < 0.01 ? `$${Number(v).toFixed(4)}` : `$${Number(v).toFixed(2)}`);
export const when = (s?: string | null) => (s ? new Date(s).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
