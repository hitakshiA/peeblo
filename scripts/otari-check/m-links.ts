// Seam M: dashboard links from a receipt: each request, and the session's trace in Otari.
import { check, expect, save } from "./harness.ts";
import { pool } from "../../src/db.ts";
import { buildReceipt } from "../../src/receipts.ts";
import { traceIdForRequest, traceSummary } from "../../src/otari/traces.ts";
import { links } from "../../src/otari/links.ts";

const S = "M";
const { rows } = await pool.query("SELECT run_id, session_id, data->>'request_id' AS rid FROM events WHERE type = 'model.call' AND data->>'status' = '200' AND data->>'role' IS NULL ORDER BY id DESC LIMIT 1");
expect(rows[0], "no finished model call in the event log; run a turn first");
const { run_id: runId, session_id: sessionId, rid } = rows[0];

await check(S, "a request's trace is the Peeblo session, named and tagged", async (c) => {
  const traceId = await traceIdForRequest(rid);
  expect(traceId, "no trace for the request");
  const t = await traceSummary(traceId);
  c.ids.push(rid);
  c.note("trace", { id: t.trace_id, name: t.name, harness: t.harness });
  expect(t.name === sessionId, `trace named ${t.name}, not ${sessionId}`);
});

await check(S, "the receipt carries request and trace links", async (c) => {
  const r = await buildReceipt(runId);
  expect(r.links && r.links.requests[rid]?.includes(`/#/requests?request=${rid}`), "no request link");
  expect(r.links.trace_id && r.links.session.includes(`peek=${r.links.trace_id}`), `session link ${r.links.session}`);
  c.note("session_link", r.links.session);
});

await check(S, "without a session, the link searches for the session", async () => {
  expect(links.sessionsFor({ q: sessionId }).endsWith(`/#/sessions?q=${sessionId}`), links.sessionsFor({ q: sessionId }));
});
await pool.end();
process.exit((await save(S)) ? 0 : 1);
