export class HttpError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, label: string) {
    super(`${label} -> HTTP ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`.slice(0, 2000));
    this.status = status;
    this.body = body;
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  body?: BodyInit;
  retries?: number;
  label?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// fetch with JSON handling and backoff on 429/5xx. Never logs headers, so tokens stay out of output.
export async function request<T = any>(url: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
  let body = opts.body;
  if (opts.json !== undefined) {
    headers["Content-Type"] ??= "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(opts.form).toString();
  }
  const label = opts.label ?? `${opts.method ?? "GET"} ${url.split("?")[0]}`;
  const retries = opts.retries ?? 5;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method: opts.method ?? (body ? "POST" : "GET"), headers, body });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    if (res.ok) return parsed as T;
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt);
      continue;
    }
    throw new HttpError(res.status, parsed, label);
  }
}

export { sleep };
