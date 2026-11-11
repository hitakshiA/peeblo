import type { ConnectorTool } from "../src/connectors/mcp.ts";

// A connector tool as the catalog describes it; only server, tool and the read-only hints matter to the rules.
export function tool(server: string, name: string, readOnlyHint: boolean | null = null, serverReadOnly = false): ConnectorTool {
  return { name: `${server}__${name}`, server, serverId: "srv", revision: "1", tool: name, description: "", inputSchema: {}, readOnlyHint, serverReadOnly };
}
