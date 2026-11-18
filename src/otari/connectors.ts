// Connectors from Otari's MCP catalog: find one, ask an admin for it, add it, and sign it in with OAuth.
// Otari keeps the catalog (the public MCP registry plus a few it adds), the member requests, the OAuth sign-in and
// the token renewals; Peeblo only drives them. A connector added here is shared (one account for the whole
// workspace, as every connector Peeblo uses is), reads open to every key and everything to Peeblo's core key, so
// teammates get it through the access Peeblo already copies onto their own keys.
import { config } from "../config.ts";
import { admin } from "./admin.ts";
import { links } from "./links.ts";

export type CatalogServer = {
  name: string;
  title: string;
  description: string | null;
  url: string;
  requires_token: boolean;
  publisher_kind: string;
  website_url: string | null;
};
export type Server = {
  id: string;
  name: string;
  url: string;
  credential_mode: "shared" | "per_user";
  has_token: boolean;
  shared_account: { signed_in_by: string | null; signed_in_at: string; renewable: boolean } | null;
  needs_setup: boolean;
  health: { status?: string; error?: string | null; http_status?: number | null; tool_count?: number | null; checked_at?: string } | null;
};

const where = (u: string) => {
  try {
    const x = new URL(u);
    return (x.host + x.pathname).replace(/\/+$/, "").toLowerCase();
  } catch {
    return u.toLowerCase();
  }
};

export async function servers(): Promise<Server[]> {
  return (
    await admin<{ data: Server[] }>(
      "GET",
      "/workspaces/{workspace}/mcp-servers?limit=200",
      undefined,
      "listing MCP servers",
      links.mcpServers(),
    )
  ).data;
}

export async function findServer(nameOrId: string): Promise<Server | null> {
  const k = nameOrId.trim().toLowerCase();
  return (await servers()).find((s) => s.id === nameOrId || s.name.toLowerCase() === k) ?? null;
}

// The catalog lists tens of thousands of servers, many of them community copies and test probes. Servers named
// for the search come before ones that only mention it, a vendor's own server first; probes are left out.
// (No workspace_id: Otari would then hide the servers already added, and "already connected" is worth saying.)
export function rankCatalog(q: string, found: CatalogServer[]): CatalogServer[] {
  const real = found.filter((x) => !/(probe|shape|sensor)\b/i.test(`${x.title} ${x.url}`));
  const named = real.filter((x) => x.title.toLowerCase().includes(q.trim().toLowerCase()));
  const pick = named.length ? named : real;
  return [...pick.filter((x) => x.publisher_kind === "vendor"), ...pick.filter((x) => x.publisher_kind !== "vendor")].slice(0, 6);
}

export async function searchCatalog(q: string): Promise<(CatalogServer & { added_as: string | null })[]> {
  const found = (
    await admin<{ data: CatalogServer[] }>(
      "GET",
      `/mcp-catalog/servers?${new URLSearchParams({ q, limit: "25" })}`,
      undefined,
      "searching the MCP catalog",
      links.mcpServers(),
    )
  ).data;
  const have = new Map((await servers()).map((x) => [where(x.url), x.name]));
  return rankCatalog(q, found).map((x) => ({ ...x, added_as: have.get(where(x.url)) ?? null }));
}

export async function catalogEntry(name: string): Promise<CatalogServer | null> {
  const found = (
    await admin<{ data: CatalogServer[] }>(
      "GET",
      `/mcp-catalog/servers?${new URLSearchParams({ q: name, limit: "50" })}`,
      undefined,
      "reading the MCP catalog",
      "",
    )
  ).data;
  return found.find((x) => x.name === name) ?? null;
}

// A person (not an admin) asks for a catalog server; Otari keeps the request and approves it when an admin adds
// the server. The request is filed as the Otari user Peeblo signed in as, so the note says who really asked.
export async function requestServer(name: string, note: string): Promise<{ title: string; url: string }> {
  const c = await catalogEntry(name);
  if (!c) throw new Error(`"${name}" isn't in Otari's MCP catalog; use connector_find for its exact name`);
  await admin(
    "POST",
    "/workspaces/{workspace}/mcp-server-requests",
    { catalog_name: name, note: note.slice(0, 500) },
    "asking for an MCP server",
    links.mcpServers(),
  ).catch((e) => {
    // One pending request per server and caller: a second ask for the same server is already on file.
    if ((e as { status?: number }).status !== 409) throw e;
  });
  return { title: c.title, url: c.url };
}

export async function pendingRequests(): Promise<
  { catalog_name: string; title: string; requester_count: number; requesters: { note: string | null }[] }[]
> {
  return (
    await admin<{ data: any[] }>(
      "GET",
      "/workspaces/{workspace}/mcp-server-requests",
      undefined,
      "reading MCP server requests",
      links.mcpServers(),
    )
  ).data;
}

// Peeblo's core key id in Otari (keys show only a prefix and suffix).
async function coreKeyId(): Promise<string | null> {
  const r = await admin<any>("GET", "/organizations/me/keys?limit=200", undefined, "listing keys", "");
  const keys: any[] = r.data ?? r;
  return (
    keys.find((k) => k.key_prefix && k.key_suffix && config.otariKey.startsWith(k.key_prefix) && config.otariKey.endsWith(k.key_suffix))
      ?.id ?? null
  );
}

const slug = (t: string) =>
  t
    .toLowerCase()
    .replace(/\b(mcp|server|official)\b/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "connector";

// Adds a catalog server as a shared connector. Storing a server at the requested URL approves every pending
// request for it in Otari. When it needs an account, the result carries the sign-in link to hand an admin.
// A server whose sign-in won't start (it lets in only clients it knows, as Figma does) is still added; the admin
// then gives Otari an OAuth client id on the server's settings, or a token, and signs it in later.
export type SignIn = { link: string } | { refused: string } | null;
const trySignIn = async (s: Server): Promise<SignIn> => {
  if (!s.needs_setup) return null;
  try {
    return { link: await startSignIn(s.id) };
  } catch (e) {
    const b = (e as { body?: string }).body;
    let why = (e as Error).message;
    try {
      why = JSON.parse(b ?? "").detail ?? why;
    } catch {}
    return { refused: String(why) };
  }
};

export async function addServer(name: string, as?: string | null): Promise<{ server: Server; signIn: SignIn }> {
  const c = await catalogEntry(name);
  if (!c) throw new Error(`"${name}" isn't in Otari's MCP catalog; use connector_find for its exact name`);
  const existing = (await servers()).find((x) => where(x.url) === where(c.url));
  if (existing) return { server: existing, signIn: await trySignIn(existing) };
  const created = await admin<Server>(
    "POST",
    "/workspaces/{workspace}/mcp-servers",
    {
      name: slug(as || c.title),
      url: c.url,
      purpose_hint: (c.description ?? c.title).slice(0, 200),
      enabled: true,
      credential_mode: "shared",
      everyone_tools: ["@read"],
    },
    `adding ${c.title}`,
    links.mcpServers(),
  );
  const core = await coreKeyId();
  if (core)
    await admin(
      "POST",
      `/workspaces/{workspace}/mcp-servers/${created.id}/access/grants`,
      { api_key_ids: [core], tools: ["*"] },
      `letting Peeblo use ${c.title}`,
      "",
    );
  return { server: created, signIn: await trySignIn(created) };
}

// An admin signs the server in once, with the account the whole workspace acts as; Otari keeps and renews the
// token, and a pasted token, if the server had one, is dropped. The link is single-use and lasts 30 minutes.
export async function startSignIn(id: string): Promise<string> {
  const r = await admin<{ authorization_url: string }>(
    "POST",
    `/workspaces/{workspace}/mcp-servers/${id}/shared-account`,
    { return_to: "/tools/mcp-servers" },
    "starting a sign-in",
    links.mcpServers(),
  );
  return r.authorization_url;
}

// The address the admin's browser ended on after approving, when Otari's dashboard didn't finish the sign-in
// itself (otari.ai sends the browser to a dashboard address that doesn't). Its code is single-use and only
// the Otari user who started the sign-in (Peeblo's session) can spend it.
export function parseCallback(address: string): { code: string; state: string; iss?: string } | null {
  let u: URL;
  try {
    u = new URL(address.trim());
  } catch {
    return null;
  }
  if (!/mcp-connections\/callback/.test(u.pathname + u.hash)) return null;
  // The dashboard form keeps its query after the #: /dashboard/?region=us#/mcp-connections/callback?code=…
  const q = new URLSearchParams(u.hash.includes("mcp-connections/callback") ? (u.hash.split("?")[1] ?? "") : u.search);
  const code = q.get("code"),
    state = q.get("state");
  if (!code || !state) return null;
  return { code, state, ...(q.get("iss") ? { iss: q.get("iss")! } : {}) };
}

export async function finishSignIn(address: string): Promise<Server> {
  const p = parseCallback(address);
  if (!p) throw new Error("that isn't an Otari sign-in return address (it has mcp-connections/callback with a code and a state)");
  const done = await admin<{ server_id: string }>("POST", "/mcp-connections/complete", p, "finishing a sign-in", links.mcpServers());
  // Fresh health: Otari connects with the new account and lists its tools.
  return checkServer(done.server_id);
}

// Live: Otari connects with the stored account, lists the tools and records the outcome as the server's health.
async function checkServer(id: string): Promise<Server> {
  return admin<Server>("POST", `/workspaces/{workspace}/mcp-servers/${id}/check`, {}, "checking a connector", links.mcpServers());
}

export const healthLine = (s: Server) => {
  const h = s.health ?? {};
  const how = s.shared_account ? `signed in by ${s.shared_account.signed_in_by ?? "a former admin"}` : s.has_token ? "token" : "no account";
  if (s.needs_setup) return `${s.name}: needs an admin to sign in`;
  if (h.status === "healthy") return `${s.name}: working, ${h.tool_count ?? "?"} tools (${how})`;
  return `${s.name}: ${h.status ?? "unknown"}${h.error ? ` (${h.error}${h.http_status ? `, HTTP ${h.http_status}` : ""})` : ""} (${how})`;
};
