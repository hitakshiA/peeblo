// Item 2: the model is chosen at a boundary. A running session keeps its model; a change applies to new
// sessions, or now with a takeover note; code checks the allowlist and who asked. Cheap models only (the
// heavy-model path is the same code with a cheap id; real big-model runs are deferred to the end).
import { check, expect, save } from "./harness.ts";
import { api, calls, MAYA, OWNER } from "./api.ts";
import { teammate, turn } from "./n-common.ts";
import { pool } from "../../src/db.ts";

const S = "N2";
const A = "deepseek/deepseek-v4.1-flash-1017";
const B = "xiaomi/mimo-v2.6-flash";
const tm = await teammate("route-check", { tools: [], connectors: [], model: { default: A, fallback: "minimax/minimax-m3.1-flash" } });
const served = (events: any[]) => calls(events).filter((x) => x.status === 200 && x.role !== "guard").map((x) => x.requested_model);
const change = (body: Record<string, unknown>) => api("POST", `/v1/teammates/${tm}/model`, { person: OWNER, ...body });
const place = `C0CHECK:route-${Date.now().toString(36)}`;

await check(S, "a model change waits for the next session; a running one keeps its model", async (c) => {
  const t1 = await turn(tm, "r1", "In one sentence, what is a refund?", { place });
  expect(served(t1.events).every((m) => m === A), `turn 1 ran on ${served(t1.events)}`);
  const r = await change({ model: B, why: "check" });
  expect(r.applies_to === "new sessions", JSON.stringify(r));
  const t2 = await turn(tm, "r2", "And in one sentence, what is a chargeback?", { place });
  expect(served(t2.events).every((m) => m === A), `the running session switched to ${served(t2.events)}`);
  const fresh = await turn(tm, "r3", "In one sentence, what is an invoice?");
  expect(served(fresh.events).every((m) => m === B), `a new session ran on ${served(fresh.events)}`);
  c.note("sessions", { running: t1.sessionId, fresh: fresh.sessionId });
  c.ids.push(...calls([...t1.events, ...t2.events, ...fresh.events]).map((x) => x.request_id).filter(Boolean));
});

await check(S, "a change asked for now moves the running session over, with a note", async (c) => {
  const t1 = await turn(tm, "n1", "In one sentence, what is a ledger?", { place: `${place}-now` });
  const before = served(t1.events);
  const r = await change({ model: A, now: { session_id: t1.sessionId }, why: "back to the worker default" });
  expect(r.applies_to === "now", JSON.stringify(r));
  const t2 = await turn(tm, "n2", "And a journal entry?", { place: `${place}-now` });
  expect(served(t2.events).every((m) => m === A), `after the takeover it ran on ${served(t2.events)}`);
  const { rows } = await pool.query("SELECT data FROM events WHERE session_id = $1 AND type = 'session.config' ORDER BY id", [t1.sessionId]);
  expect(rows.some((x) => x.data.reason === "takeover"), "no takeover recorded");
  c.note("before", before); c.note("after", served(t2.events));
});

await check(S, "code refuses a non-owner and a closed model", async (c) => {
  let maya = "";
  try { await api("POST", `/v1/teammates/${tm}/model`, { person: MAYA, model: B }); } catch (e) { maya = String(e); }
  expect(maya.includes("403"), `Maya got: ${maya || "allowed"}`);
  let closed = "";
  try { await change({ model: "anthropic/claude-fable-5" }); } catch (e) { closed = String(e); }
  expect(closed.includes("403") && closed.includes("open-weight"), `closed model got: ${closed || "allowed"}`);
  c.note("refusals", [maya.slice(-90), closed.slice(-90)]);
});
await pool.end();
process.exit((await save(S)) ? 0 : 1);
