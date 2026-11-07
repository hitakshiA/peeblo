// Seam J: Otari admin through the dashboard session, and deep links when there is none.
// Needs OTARI_DASHBOARD_EMAIL and OTARI_DASHBOARD_PASSWORD (used to sign in, never stored).
import { check, expect, save } from "./harness.ts";
import { migrate, pool } from "../../src/db.ts";
import * as A from "../../src/otari/admin.ts";

const S = "J";
await migrate();
const id = () => A.lastAdminRequestId ?? "(no request id)";
await check(S, "sign in keeps a sealed session", async (c) => {
  const r = await A.signIn(process.env.OTARI_DASHBOARD_EMAIL!, process.env.OTARI_DASHBOARD_PASSWORD!);
  expect(r.workspaceId && r.expiresAt > new Date(), "no workspace or expiry");
  if (process.env.OTARI_EXPECT_WORKSPACE) expect(r.workspaceId === process.env.OTARI_EXPECT_WORKSPACE, `signed in to workspace ${r.workspaceId}, not the key's`);
  c.note("workspace", r.workspaceId);
  const { rows } = await pool.query("SELECT cookie FROM otari_session WHERE id = 1");
  expect(!rows[0].cookie.toString("utf8").includes("session"), "cookie stored in clear");
  c.note("expires_at", r.expiresAt.toISOString());
});
await check(S, "budget: create, change, delete", async (c) => {
  const b = await A.createBudget("peeblo-check-budget", 0.5); c.ids.push(id()!);
  await A.updateBudget(b.id, 0.75); c.ids.push(id()!);
  await A.deleteBudget(b.id); c.ids.push(id()!);
});
await check(S, "service key with its own spend ceiling", async (c) => {
  const b = await A.createBudget("peeblo-check-key-budget", 0.25);
  const k = await A.createServiceKey("peeblo-check-key", null); c.ids.push(id()!);
  expect(k.key?.startsWith("otari_") || k.key?.length > 20, "no secret returned");
  const ceil = await A.createKeyCeiling(k.id, b.id, "peeblo-check-key"); c.ids.push(id()!);
  const r = await fetch(`${process.env.OTARI_BASE_URL ?? "https://api.otari.ai/api/v1"}/key/budget`, { headers: { authorization: `Bearer ${k.key}` } });
  const kb = await r.json() as any;
  c.note("key_budget_limits", kb.limits?.map((l: any) => l.limit_usd));
  expect(kb.limits?.some((l: any) => Number(l.limit_usd) === 0.25), `ceiling not visible to the key: ${JSON.stringify(kb).slice(0, 200)}`);
  await A.deleteCeiling(ceil.id); await A.deleteKey(k.id); await A.deleteBudget(b.id);
});
await check(S, "routing policy: create, replace, delete", async (c) => {
  const spec = { select: [{ default: "deepinfra:deepseek-ai/DeepSeek-V4.1-Flash-1017" }], on_failure: ["fireworks:accounts/fireworks/models/glm-5p3"] };
  await A.upsertRoutingPolicy("peeblo-check", spec); c.ids.push(id()!);
  await A.upsertRoutingPolicy("peeblo-check", { select: [{ default: "fireworks:accounts/fireworks/models/glm-5p3" }] }); c.ids.push(id()!);
  const list = await A.routingPolicies();
  const p = (list.data ?? list).find((x: any) => x.name === "peeblo-check");
  expect(p && JSON.stringify(p.spec).includes("glm-5p3"), "replaced policy not listed");
  await A.deleteRoutingPolicy("peeblo-check"); c.ids.push(id()!);
});
await check(S, "guardrail mandate readable and switchable", async (c) => {
  const g = await A.guardrailMandates();
  const m = (g.data ?? g).find((x: any) => x.profile === "peeblo-lakera");
  expect(m, "no peeblo-lakera mandate");
  const r = await A.setGuardrailMandate(m.id, m.enabled); c.ids.push(id()!);
  expect(r.enabled === m.enabled, "state changed");
  c.note("mandate_enabled", m.enabled);
});
await check(S, "web search setting kept when switched", async (c) => {
  const w = await A.webSearch();
  await A.setWebSearch(w.enabled); c.ids.push(id()!);
  const after = await A.webSearch();
  expect(after.enabled === w.enabled && JSON.stringify(after.allowed_domains) === JSON.stringify(w.allowed_domains), "setting changed");
  c.note("web_enabled", w.enabled);
});
await check(S, "MCP server: register, list, remove", async (c) => {
  const s = await A.registerMcpServer({ name: "peeblo-check-deepwiki", url: "https://mcp.deepwiki.com/mcp", readTools: ["read_wiki_structure"], everyoneTools: ["@read"], purpose: "check" }); c.ids.push(id()!);
  const list = await A.mcpServers();
  expect((list.data ?? list).some((x: any) => x.id === s.id), "not listed");
  await A.deleteMcpServer(s.id); c.ids.push(id()!);
});
await check(S, "no session: a clear error with the dashboard link", async (c) => {
  await A.signOut();
  try { await A.createBudget("never", 1); throw new Error("expected NoSession"); }
  catch (e) { expect(e instanceof A.NoSession && e.link.endsWith("/#/budgets"), `got ${(e as Error).message}`); c.note("message", (e as Error).message); }
  await A.signIn(process.env.OTARI_DASHBOARD_EMAIL!, process.env.OTARI_DASHBOARD_PASSWORD!);
});
await pool.end();
process.exit((await save(S)) ? 0 : 1);
