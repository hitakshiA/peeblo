// Links into the Otari dashboard (hash routes), for receipts and for every admin task Peeblo can't do
// without a dashboard session. A link opens in whatever org and workspace the person last used.
const DASH = (process.env.OTARI_DASHBOARD_URL ?? "https://otari.ai").replace(/\/+$/, "");
const q = (p: Record<string, string | undefined>) => {
  const s = new URLSearchParams(Object.entries(p).filter(([, v]) => v) as [string, string][]).toString();
  return s ? `?${s}` : "";
};

export const links = {
  request: (requestId: string) => `${DASH}/#/requests${q({ request: requestId })}`,
  session: (traceId: string, workspaceId?: string) => `${DASH}/#/sessions${q({ peek: traceId, peek_workspace: workspaceId })}`,
  sessionsFor: (filter: { userId?: string; apiKeyId?: string; q?: string }) => `${DASH}/#/sessions${q({ user_id: filter.userId, api_key_id: filter.apiKeyId, q: filter.q })}`,
  usage: () => `${DASH}/#/organization/usage`,
  model: (id: string) => `${DASH}/#/models/${encodeURIComponent(id)}`,
  routing: () => `${DASH}/#/routing`,
  routingPolicy: (name: string) => `${DASH}/#/routing/${encodeURIComponent(name)}`,
  keys: () => `${DASH}/#/keys`,
  budgets: () => `${DASH}/#/budgets`,
  guardrails: () => `${DASH}/#/organization/guardrails`,
  webSearch: () => `${DASH}/#/tools/web-search`,
  codeExecution: () => `${DASH}/#/tools/code-execution`,
  mcpServers: () => `${DASH}/#/tools/mcp-servers`,
  mcpServer: (id: string) => `${DASH}/#/tools/mcp-servers/${encodeURIComponent(id)}`,
};
