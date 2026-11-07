// Item 4: connectors. Writes in a session run one at a time; a lower mode applies to a running session at
// once (the tool list stays the same; the gate asks). Uses Linear issue GRO-323 (a cancelled test issue).
import { check, expect, save } from "./harness.ts";
import { api } from "./api.ts";
import { teammate, turn } from "./n-common.ts";
import { pool } from "../../src/db.ts";

const S = "N4";
const tm = await teammate("write-check", { tools: [], connectors: ["linear"], mode: "yolo" });
const place = `C0CHECK:writes-${Date.now().toString(36)}`;

await check(S, "two writes in one turn run one after the other", async (c) => {
  const r = await turn(tm, "two-writes", "Add two separate comments to Linear issue GRO-323: one saying 'check one' and another saying 'check two'.", { place });
  const { rows } = await pool.query("SELECT at, data FROM events WHERE run_id = $1 AND type = 'tool.call' AND data->>'via' = 'otari_mcp' AND data->>'kind' <> 'read' AND data->>'status' = 'completed' ORDER BY id", [r.runId]);
  expect(rows.length >= 2, `only ${rows.length} completed writes`);
  const spans = rows.map((x) => ({ end: new Date(x.at).getTime(), start: new Date(x.at).getTime() - Number(x.data.ms ?? 0) }));
  for (let i = 1; i < spans.length; i++) expect(spans[i].start >= spans[i - 1].end - 50, `write ${i + 1} started before write ${i} finished`);
  c.note("writes", rows.map((x) => `${x.data.tool} ${x.data.ms}ms`));
  c.ids.push(...rows.map((x) => x.data.request_id).filter(Boolean));
});

await check(S, "a lower mode applies to the running session at once; the tools stay the same", async (c) => {
  await api("PATCH", `/v1/teammates/${tm}`, { mode: "ask", note: "lower to ask" });
  try {
    // Ask mode is "reads only, unless a person approves" (DESIGN): the write now waits, and a no stops it.
    const r = await turn(tm, "after-lower", "Now add one more comment to GRO-323 saying 'check three'.", { place, answer: "denied" });
    const writes = r.tools.filter((x) => x.via === "otari_mcp" && x.kind !== "read");
    expect(writes.some((x) => x.status === "waiting_approval") && writes.some((x) => x.status === "denied"), `writes ${JSON.stringify(writes.map((x) => x.status))}`);
    expect(writes.every((x) => x.mode === "ask"), `gate mode ${JSON.stringify(writes.map((x) => x.mode))}`);
    c.note("writes", writes.map((x) => `${x.tool}:${x.status}:${x.mode}`));
  } finally {
    await api("PATCH", `/v1/teammates/${tm}`, { mode: "yolo", note: "restore" });
  }
});
await pool.end();
process.exit((await save(S)) ? 0 : 1);
