import { loadEnv, updateEnv } from "../../seed/lib/env.ts";
import { request } from "../../seed/lib/http.ts";

// Thin authenticated clients. Credentials never leave this module; tools receive data only.
export const env = loadEnv();
const basic = (u: string, p: string) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");

function cachedToken(fetchToken: () => Promise<{ token: string; ttlMs: number }>) {
  let cache: { token: string; exp: number } | undefined;
  let inflight: Promise<string> | undefined;
  return async () => {
    if (cache && cache.exp > Date.now()) return cache.token;
    inflight ??= fetchToken().then((t) => { cache = { token: t.token, exp: Date.now() + t.ttlMs - 60_000 }; inflight = undefined; return t.token; });
    return inflight;
  };
}

export const stripe = {
  call: (path: string, opts: { method?: string; form?: Record<string, string>; idempotencyKey?: string } = {}) =>
    request(`${process.env.STRIPE_API_BASE ?? "https://api.stripe.com"}/v1${path}`, { method: opts.method ?? (opts.form ? "POST" : "GET"), form: opts.form, headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY_OVERRIDE ?? env.STRIPE_SECRET_KEY}`, ...(opts.idempotencyKey ? { "Idempotency-Key": opts.idempotencyKey } : {}) } }),
};

// QuickBooks refresh tokens rotate: only this process refreshes, and it persists the newest token.
const qboToken = cachedToken(async () => {
  const t = await request("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", { form: { grant_type: "refresh_token", refresh_token: env.QUICKBOOKS_REFRESH_TOKEN }, headers: { Authorization: basic(env.QUICKBOOKS_CLIENT_ID, env.QUICKBOOKS_CLIENT_SECRET) } });
  if (t.refresh_token !== env.QUICKBOOKS_REFRESH_TOKEN) { env.QUICKBOOKS_REFRESH_TOKEN = t.refresh_token; updateEnv("QUICKBOOKS_REFRESH_TOKEN", t.refresh_token); }
  return { token: t.access_token, ttlMs: t.expires_in * 1000 };
});
const qboBase = () => `https://${env.QUICKBOOKS_ENVIRONMENT === "production" ? "" : "sandbox-"}quickbooks.api.intuit.com/v3/company/${env.QUICKBOOKS_REALM_ID}`;
export const qbo = {
  query: async (sql: string) => (await request(`${qboBase()}/query?minorversion=75&query=${encodeURIComponent(sql)}`, { headers: { Authorization: `Bearer ${await qboToken()}` } })).QueryResponse,
  get: async (entity: string, entityId: string) => (await request(`${qboBase()}/${entity.toLowerCase()}/${entityId}?minorversion=75`, { headers: { Authorization: `Bearer ${await qboToken()}` } }))[entity],
  post: async (entity: string, body: unknown, query = "") => (await request(`${qboBase()}/${entity.toLowerCase()}?minorversion=75${query}`, { headers: { Authorization: `Bearer ${await qboToken()}` }, json: body }))[entity],
  report: async (name: string, params: Record<string, string>) => request(`${qboBase()}/reports/${name}?minorversion=75&${new URLSearchParams(params)}`, { headers: { Authorization: `Bearer ${await qboToken()}` } }),
};

const sfToken = cachedToken(async () => {
  const t = await request(`${env.SALESFORCE_INSTANCE_URL}/services/oauth2/token`, { form: { grant_type: "client_credentials", client_id: env.SALESFORCE_CLIENT_ID, client_secret: env.SALESFORCE_CLIENT_SECRET } });
  return { token: t.access_token, ttlMs: 30 * 60_000 };
});
export const salesforce = {
  query: async (soql: string) => (await request(`${env.SALESFORCE_INSTANCE_URL}/services/data/v67.0/query?q=${encodeURIComponent(soql)}`, { headers: { Authorization: `Bearer ${await sfToken()}` } })).records,
  search: async (term: string) => (await request(`${env.SALESFORCE_INSTANCE_URL}/services/data/v67.0/parameterizedSearch?q=${encodeURIComponent(term)}&sobject=Account&sobject=Contact&Account.fields=Id,Name,Website,Description,ParentId&Contact.fields=Id,Name,Email,Title,AccountId`, { headers: { Authorization: `Bearer ${await sfToken()}` } })).searchRecords,
};

export const hubspot = {
  call: (path: string, json?: unknown, method?: string) => request(`https://api.hubapi.com${path}`, { method, json, headers: { Authorization: `Bearer ${env.HUBSPOT_ACCESS_TOKEN}` } }),
};

export const slack = {
  call: async (method: string, body: Record<string, unknown>, token = env.SLACK_BOT_TOKEN) => {
    const r = await request(`https://slack.com/api/${method}`, { json: body, headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`slack ${method}: ${r.error}`);
    return r;
  },
};

export const notion = {
  call: (path: string, json?: unknown, method?: string) => request(`https://api.notion.com/v1${path}`, { method, json, headers: { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": "2026-03-11" } }),
};

export const jira = {
  call: (path: string, json?: unknown, method?: string) => request(`${env.JIRA_BASE_URL}/rest/api/3${path}`, { method, json, headers: { Authorization: basic(env.JIRA_EMAIL, env.JIRA_API_TOKEN) } }),
};

const dropboxToken = cachedToken(async () => {
  const t = await request("https://api.dropboxapi.com/oauth2/token", { form: { grant_type: "refresh_token", refresh_token: env.DROPBOX_REFRESH_TOKEN }, headers: { Authorization: basic(env.DROPBOX_APP_KEY, env.DROPBOX_APP_SECRET) } });
  return { token: t.access_token, ttlMs: t.expires_in * 1000 };
});
const asciiArg = (o: unknown) => JSON.stringify(o).replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
export const dropbox = {
  rpc: async (path: string, json: unknown) => request(`https://api.dropboxapi.com/2${path}`, { json, headers: { Authorization: `Bearer ${await dropboxToken()}` } }),
  download: async (path: string, rev?: string): Promise<{ meta: any; bytes: Buffer }> => {
    const res = await fetch("https://content.dropboxapi.com/2/files/download", { method: "POST", headers: { Authorization: `Bearer ${await dropboxToken()}`, "Dropbox-API-Arg": asciiArg({ path: rev ? `rev:${rev}` : path }) } });
    if (!res.ok) throw new Error(`dropbox download ${res.status}: ${await res.text()}`);
    return { meta: JSON.parse(res.headers.get("dropbox-api-result") ?? "{}"), bytes: Buffer.from(await res.arrayBuffer()) };
  },
};

// Our seeded PDFs use uncompressed text operators, so text extraction is a simple parse.
export function pdfText(bytes: Buffer): string {
  const s = bytes.toString("latin1");
  const lines: string[] = [];
  for (const m of s.matchAll(/\((?:\\.|[^\\)])*\)\s*Tj/g)) lines.push(m[0].slice(1, m[0].lastIndexOf(")")).replace(/\\([()\\])/g, "$1"));
  return lines.join("\n") || "(no extractable text)";
}
