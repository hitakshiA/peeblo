// K14 loop limits, through Peeblo's own proxy (started here on a spare port, with a real session): the same
// tool call gets a factual note from its 3rd time, stops the run on its 6th, and the stopped run gets no more
// model calls. Deterministic: no model decides anything, so the limit is checked exactly.
import { check, expect, save } from "./harness.ts"; // no config: safe to load before the port is set
process.env.PEEBLO_PROXY_PORT ??= "7399";
const { api } = await import("./api.ts");
const { teammate } = await import("./n-common.ts");
const { pool } = await import("../../src/db.ts");
const { getTeammate } = await import("../../src/store/teammates.ts");
const { bindRun, issueToken, revokeToken, startProxy, toolsBaseUrl, proxyBaseUrl } = await import("../../src/proxy/relay.ts");

const S = "P2L";
const slug = await teammate("agent-check");
const tm = (await getTeammate(slug))!;
const server = await startProxy();
const session = await api("POST", `/v1/teammates/${slug}/sessions`, { kind: "thread", place_key: `C0CHECK:loop-${Date.now().toString(36)}` });
const token = issueToken({ teammateId: tm.id, teammateVersion: tm.version, teammateSlug: tm.slug, sessionId: session.id, fallbackModel: null, web: null, code: false, otariKey: null, keyId: null });
bindRun(token, null as unknown as string, null, 1, null);
const call = () => fetch(`${toolsBaseUrl()}/tools/call`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ name: "budget_status", arguments: {} }) }).then((r) => r.json() as Promise<{ text: string; isError: boolean }>);

await check(S, "the same call gets a note from its 3rd time and stops the run on its 6th", async (c) => {
  const out = [];
  for (let i = 1; i <= 6; i++) out.push(await call());
  expect(!out[0].text.includes("[peeblo:") && !out[1].text.includes("[peeblo:"), "a note came before the 3rd call");
  expect(out[2].text.includes("3th identical budget_status call") || out[2].text.includes("identical budget_status"), `no note on the 3rd call: ${out[2].text.slice(-120)}`);
  expect(out[5].isError && /^Stopped:/.test(out[5].text), `the 6th call was not stopped: ${out[5].text.slice(0, 120)}`);
  const { rows } = await pool.query("SELECT data FROM events WHERE session_id = $1 AND type = 'run.stuck'", [session.id]);
  expect(rows.length === 1, `run.stuck events: ${rows.length}`);
  c.note("reason", rows[0].data.reason);
});

await check(S, "a stopped run gets no more model calls", async (c) => {
  const r = await fetch(`${proxyBaseUrl()}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ model: "deepseek/deepseek-v4.1-flash-1017", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }) });
  expect(r.status === 429 && r.headers.get("peeblo-refused") === "loop_limit", `got ${r.status} ${r.headers.get("peeblo-refused")}`);
  c.note("refusal", (await r.json() as { detail: string }).detail);
});
revokeToken(token);
server.close();
await pool.end();
process.exit((await save(S)) ? 0 : 1);
