// Connectors Otari can't reach directly. Otari sends only `Authorization: Bearer` to a public HTTPS MCP
// server, so a vendor that needs OAuth refresh, a service-account login, or its own header is served by a
// small Peeblo bridge at <public URL>/mcp/<vendor>, which Otari stores as an ordinary Bearer server. Every
// call still goes through Otari (traced, access-ruled, on the receipt); the bridge only adds the vendor's
// credential and forwards to the vendor's MCP server (or an open-source one).
import { config } from "../config.ts";
import { mcpServers, registerMcpServer } from "../otari/admin.ts";

export type Bridge = { server: string; vendor: string; why: string; upstream: string; readOnly?: boolean };

export const BRIDGES: Bridge[] = [
  { server: "hubspot", vendor: "hubspot", why: "OAuth only (private-app token held by the bridge)", upstream: "@hubspot/mcp-server" },
  { server: "sheets", vendor: "sheets", why: "Google OAuth refresh tokens", upstream: "Google Sheets MCP (open source)" },
  { server: "grafana", vendor: "grafana", why: "Grafana Cloud service-account token in its own header", upstream: "grafana/mcp-grafana" },
  { server: "pagerduty", vendor: "pagerduty", why: "API key sent as `Token token=…`", upstream: "PagerDuty MCP server" },
  { server: "sentry", vendor: "sentry", why: "needs a Sentry-specific header Otari can't send", upstream: "@sentry/mcp-server", readOnly: true },
];

export const bridgeUrl = (b: Bridge) => `${config.publicUrl.replace(/\/+$/, "")}/mcp/${b.vendor}`;

export type BridgeStatus = { server: string; stored: boolean; url: string | null; urlMatches: boolean; healthy: boolean; tools: number | null };

// Whether each bridge is stored in Otari, at this Peeblo's public URL, and healthy (needs the dashboard session).
export async function bridgeStatus(): Promise<BridgeStatus[]> {
  const list = await mcpServers();
  const stored = (list.data ?? list) as { name: string; url: string; health?: { status?: string; tool_count?: number } }[];
  return BRIDGES.map((b) => {
    const s = stored.find((x) => x.name === b.server);
    return { server: b.server, stored: Boolean(s), url: s?.url ?? null, urlMatches: s?.url === bridgeUrl(b), healthy: s?.health?.status === "healthy", tools: s?.health?.tool_count ?? null };
  });
}

// Stores a bridge in Otari with the bearer token the bridge checks. Reads are open to every key; writes
// need a grant (or a person's approval in Peeblo) like any other connector.
export const registerBridge = (b: Bridge, bearer: string, readTools: string[] = []) =>
  registerMcpServer({ name: b.server, url: bridgeUrl(b), token: bearer, readTools, everyoneTools: ["@read"], purpose: `${b.server} for Peeblo teammates (via Peeblo's bridge)` });
