// Seam G: connectors through Otari's MCP plane: listing, per-call risk, scopes, execute with revision, bridges.
import { check, expect, save } from "./harness.ts";
import { pool } from "../../src/db.ts";
import { catalogFor, classify, executeTool, outOfScope, type ConnectorTool } from "../../src/connectors/mcp.ts";
import { bridgeStatus } from "../../src/connectors/bridges.ts";
import { OtariError } from "../../src/otari/client.ts";
import { validateConfig } from "../../src/store/teammates.ts";

const S = "G";
const cfg = validateConfig({ name: "Check", role: "checks", model: { default: "deepseek/deepseek-v4.1-flash-1017" }, connectors: ["posthog", "github", "linear", "hubspot"], connector_scopes: { github: ["hitakshiA/acme-*"] } });
const cat = await catalogFor(cfg);
const tool = (name: string) => { const t = cat.tools.find((x) => x.name === name); if (!t) throw new Error(`no ${name}`); return t; };

await check(S, "each call is classified from its own arguments", async (c) => {
  const exec = tool("posthog__exec");
  const cases: [ConnectorTool, Record<string, unknown>, string][] = [
    [exec, { command: "search insights" }, "read"],
    [exec, { command: 'call query-run {"query":{"kind":"HogQLQuery","query":"select 1"}}' }, "read"],
    [exec, { command: 'call dashboard-create {"name":"x"}' }, "write"],
    [exec, { command: 'call feature-flag-delete {"id":1}' }, "destructive"],
    [tool("linear__list_issues"), {}, "read"],
    [tool("linear__save_issue"), {}, "write"],
    [tool("github__issue_write"), {}, "write"],
    [tool("github__get_file_contents"), {}, "read"],
  ];
  for (const [t, a, want] of cases) expect(classify(t, a) === want, `${t.name} ${JSON.stringify(a)} → ${classify(t, a)}, want ${want}`);
  c.note("cases", cases.length);
  c.note("tools_listed", { posthog: cat.tools.filter((t) => t.server === "posthog").length, github: cat.tools.filter((t) => t.server === "github").length, linear: cat.tools.filter((t) => t.server === "linear").length, hubspot: cat.tools.filter((t) => t.server === "hubspot").length });
});

await check(S, "a repository outside the teammate's scope is refused", async () => {
  const w = tool("github__issue_write");
  expect(outOfScope(w, { owner: "hitakshiA", repo: "acme-checkout-api" }, cfg.connector_scopes) === null, "in-scope repo refused");
  expect(outOfScope(w, { owner: "mozilla-ai", repo: "otari" }, cfg.connector_scopes) !== null, "out-of-scope repo allowed");
});

await check(S, "a malformed scope is refused, not dropped", async () => {
  let refused = false;
  try { validateConfig({ ...cfg, connector_scopes: { github: ["not a repo"] } }); } catch { refused = true; }
  expect(refused, "a bad scope was accepted (that would allow every repository)");
});

await check(S, "PostHog code-mode read through /mcp/execute", async (c) => {
  const r = await executeTool(tool("posthog__exec"), { command: 'call query-run {"query":{"kind":"HogQLQuery","query":"select event, count() from events where timestamp > now() - interval 14 day group by event order by count() desc limit 3"}}' });
  c.ids.push(r.requestId!);
  expect(JSON.stringify(r.data).includes("pageview") || JSON.stringify(r.data).includes("signup"), `unexpected: ${JSON.stringify(r.data).slice(0, 200)}`);
});

await check(S, "GitHub read in scope", async (c) => {
  const r = await executeTool(tool("github__get_file_contents"), { owner: "hitakshiA", repo: "acme-checkout-api", path: "package.json" });
  c.ids.push(r.requestId!);
  expect(JSON.stringify(r.data).includes("checkout"), "package.json not returned");
});

await check(S, "a stale server_revision is refused, not run", async (c) => {
  const t = { ...tool("linear__save_issue"), revision: "stale-revision" };
  try { await executeTool(t, { team: "GRO", title: "must not be created" }); throw new Error("expected a refusal"); }
  catch (e) { const o = e as OtariError; expect(o.status === 409 || o.status === 400 || o.status === 422, `status ${o.status}: ${o.message}`); c.note("status", o.status); c.note("code", o.code); if (o.requestId) c.ids.push(o.requestId); }
});

await check(S, "bridged servers are stored in Otari and healthy", async (c) => {
  const st = await bridgeStatus();
  expect(st.every((b) => b.stored && b.healthy), JSON.stringify(st.filter((b) => !b.stored || !b.healthy)));
  c.note("bridges", st.map((b) => `${b.server}:${b.tools}`));
});

await check(S, "a read through a bridge", async (c) => {
  const t = cat.tools.find((x) => x.server === "hubspot" && /search|list|get/.test(x.tool) && !(x.inputSchema as any)?.required?.length);
  expect(t, "no argument-free hubspot read tool");
  const r = await executeTool(t, {});
  c.ids.push(r.requestId!);
  c.note("tool", t.tool);
});
await pool.end();
process.exit((await save(S)) ? 0 : 1);
