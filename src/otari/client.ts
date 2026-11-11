// The Otari client: the only module that talks to hosted Otari's management-ish routes with Peeblo's key.
// Model calls go through the proxy instead. Peeblo holds an org service key, so it can name the paying
// person on every call (end users) and keep each person on a budget.
import { config } from "../config.ts";

export class OtariError extends Error {
  status: number;
  requestId: string | null;
  code: string | null;
  headers: Headers;
  body: string;
  constructor(message: string, status: number, requestId: string | null, code: string | null, headers = new Headers(), body = "") {
    super(message);
    this.status = status;
    this.requestId = requestId;
    this.code = code;
    this.headers = headers;
    this.body = body;
  }
}

const RETRY_STATUS = new Set([429, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One call to hosted Otari with Peeblo's key (or another credential, e.g. a teammate's key or the
// dashboard session cookie). Reads and PUTs are retried on 429/5xx and network errors, honouring
// Retry-After; POSTs are not, since a repeat could run something twice.
export async function otari<T = any>(
  method: string,
  path: string,
  body?: unknown,
  opts: { auth?: Record<string, string>; retries?: number; timeoutMs?: number } = {},
): Promise<{ data: T; requestId: string | null; headers: Headers }> {
  // A role name before Otari holds the role policies goes out as that role's default model.
  if (method === "POST" && body && typeof (body as any).model === "string" && /\/(chat\/completions|messages|responses)$/.test(path)) {
    const { modelFor } = await import("./routing.ts");
    body = { ...(body as object), model: modelFor((body as any).model) };
  }
  const idempotent = method === "GET" || method === "PUT" || method === "DELETE" || method === "HEAD";
  const tries = idempotent ? (opts.retries ?? 3) : 1;
  for (let i = 1; ; i++) {
    let r: Response;
    try {
      r = await fetch(config.otariBaseUrl + path, {
        method,
        headers: {
          ...(opts.auth ?? { authorization: `Bearer ${config.otariKey}` }),
          "content-type": "application/json",
          "user-agent": "peeblo/0.1",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
    } catch (error) {
      if (i < tries) {
        await sleep(400 * 2 ** i);
        continue;
      }
      throw new OtariError(`Otari ${method} ${path} unreachable: ${(error as Error).message}`, 0, null, null);
    }
    const requestId = r.headers.get("otari-request-id");
    if (!r.ok && RETRY_STATUS.has(r.status) && i < tries) {
      const after = Number(r.headers.get("retry-after"));
      await r.body?.cancel();
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 10) * 1000 : 400 * 2 ** i);
      continue;
    }
    const text = await r.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!r.ok) {
      const code = r.headers.get("otari-error-code") ?? (typeof data?.detail === "object" ? (data.detail?.code ?? null) : null);
      throw new OtariError(
        `Otari ${method} ${path} → ${r.status}: ${typeof data === "object" ? JSON.stringify(data?.detail ?? data) : String(data).slice(0, 200)}`,
        r.status,
        requestId,
        code,
        r.headers,
        text,
      );
    }
    return { data, requestId, headers: r.headers };
  }
}

// The calling key's own caps and spend.
export async function keyBudget(): Promise<{ budgets_enforced: boolean; remaining_usd: number | null; limits: any[] }> {
  return (await otari("GET", "/key/budget")).data;
}

// The settled cost and tokens of one request (404 until Otari has settled it).
export async function requestUsage(
  requestId: string,
  auth?: Record<string, string>,
): Promise<{ cost_usd: string; prompt_tokens: number; completion_tokens: number; row_count: number } | null> {
  try {
    return (await otari("GET", `/usage/requests/${encodeURIComponent(requestId)}`, undefined, auth ? { auth } : {})).data;
  } catch (e) {
    if ((e as OtariError).status === 404) return null;
    throw e;
  }
}

// Spend over a period, optionally for one tag (teammate=scout) or broken down by a tag key.
// Otari counts the tags our proxy sends in Otari-Tags.
export type UsageSummary = {
  totals: { cost: number; request_count: number; total_tokens: number; error_count: number };
  by_tag?: { key: string | null; cost: number; requests: number; tokens: number }[];
  by_user?: any[];
  by_model?: any[];
};
export async function usageSummary(q: {
  start: Date;
  end?: Date;
  tag?: string;
  groupByTag?: string;
  auth?: Record<string, string>;
}): Promise<UsageSummary> {
  const p = new URLSearchParams({ start_date: q.start.toISOString() });
  if (q.end) p.set("end_date", q.end.toISOString());
  if (q.tag) p.set("tag", q.tag);
  if (q.groupByTag) p.set("group_by_tag", q.groupByTag);
  return (await otari<UsageSummary>("GET", `/key/usage/summary?${p}`, undefined, { auth: q.auth })).data;
}
