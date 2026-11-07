// End to end: one teammate turn that uses web search, code execution, a connector read and a connector write
// (approved by a person), through Peeblo's proxy and Otari's org guardrail, billed to the person and to the
// teammate's own key, with one forced fallback, and a receipt built only from events, surviving a kill -9.
//   node scripts/otari-check/e2e.ts start    → submits the turn (core must be running)
//   (kill -9 core mid-run, then ./peeblo up)
//   node scripts/otari-check/e2e.ts finish   → approves, waits, verifies
import { readFile, writeFile } from "node:fs/promises";
import { check, expect, save } from "./harness.ts";
import { api, calls, ensureTeammate, settle, submit, tools } from "./api.ts";
import { guardMode, lakeraMandate, setLakera } from "../../src/guard.ts";
import { pool } from "../../src/db.ts";

const STATE = "local/otari-check/e2e-run.json";
const phase = process.argv[2];

if (phase === "start") {
  // With PEEBLO_GUARD=lakera the org mandate is switched on for the run; with "open" the guard model screens it.
  const before = await lakeraMandate();
  if (guardMode() === "lakera") await setLakera(true);
  await ensureTeammate("e2e", {
    name: "Wren", role: "Growth analyst for the acme team",
    // The default model no longer exists, so every call falls back to the worker routing policy.
    model: { default: "acme/retired-model-v1", fallback: "peeblo-worker" },
    budget: { monthly_usd: 3 }, tools: ["web", "code"], web: { allowed_domains: ["github.com"] },
    connectors: ["linear"], mode: "auto",
  });
  const stamp = Date.now().toString(36);
  const text = [
    "Hi Wren, I'm putting together the weekly update.",
    "Please find the latest release of earendil-works/gondolin on GitHub,",
    "work out the week-over-week change in percent for our signups 412, 398, 455, 301 and 288 with code,",
    "look up the three most recently updated issues in the GRO team in Linear,",
    "and then add a comment to GRO-323 in Linear that sums up what you found.",
  ].join(" ");
  const r = await submit("e2e", `C0CHECK:e2e-${stamp}`, text, `e2e-${stamp}`);
  await writeFile(STATE, JSON.stringify({ ...r, mandateWas: before?.enabled ?? false, startedAt: new Date().toISOString() }));
  console.log(JSON.stringify(r));
  await pool.end();
  process.exit(0);
}

const st = JSON.parse(await readFile(STATE, "utf8"));
try {
  const { run, events } = await settle(st.runId, { answer: "approved", timeoutMs: 600_000 });
  const cs = calls(events);
  const ts = tools(events);
  const receipt = await api<any>("GET", `/v1/runs/${st.runId}/receipt`);
  const S = "E2E";
  await check(S, "the run finished after core was killed mid-run", async (c) => {
    expect(run.status === "done", `run ${run.status}: ${run.error}`);
    const starts = events.filter((e) => e.type === "run.started").length;
    const attempts = events.filter((e) => e.type === "turn.attempt");
    c.note("run_started_events", starts);
    c.note("turn_attempts", attempts.map((e) => e.data.pid));
    expect(attempts.length >= 2 && new Set(attempts.map((e) => e.data.pid)).size >= 2, "the turn did not run again in a new core process (was core killed mid-run?)");
  });
  await check(S, "web search, code, a connector read and an approved connector write all ran", async (c) => {
    const kinds = ts.map((t) => `${t.by}:${t.tool}:${t.status}`);
    c.note("tools", kinds);
    expect(ts.some((t) => (t.tool === "web_search" || t.tool === "web_fetch") && t.status === "completed"), "no web search or fetch");
    expect(ts.some((t) => t.tool === "code_execution" && t.status === "completed"), "no code execution");
    expect(ts.some((t) => t.via === "otari_mcp" && t.kind === "read" && t.status === "completed"), "no connector read");
    const write = ts.find((t) => t.via === "otari_mcp" && t.kind !== "read" && t.status === "completed");
    // In Auto, a write the person asked for is allowed by the reviewer gate; anything else gets a person's approval.
    expect(write && (write.approval_id || write.reviewer), "no connector write allowed by a person or the reviewer");
    c.ids.push(...ts.map((t) => t.request_id).filter(Boolean));
  });
  await check(S, "every model call went through the proxy, the guardrail, the person and the teammate's key", async (c) => {
    const ok = cs.filter((x) => x.status === 200 && x.role !== "guard"); // the guard model's own check uses Peeblo's key
    expect(ok.length > 0, "no successful model call");
    expect(ok.every((x) => x.end_user === "slack-T0CFKBN3YPM-U0CGL01BU72"), "a call was not billed to the person");
    expect(ok.every((x) => x.key && x.key !== "core"), "a call did not go out on the teammate's key");
    const open = events.filter((e) => e.type === "guard.checked");
    const lakera = ok.every((x) => (typeof x.guardrails === "string" && x.guardrails.includes("evaluated")) || x.guard_mandate === true);
    expect(lakera || (open.length >= 1 && open.every((e) => e.data.safe === true)), "the message was not checked by either guard");
    c.note("guard", lakera ? "lakera" : `open: ${open[0]?.data.checked_by}`);
    c.ids.push(...cs.map((x) => x.request_id).filter(Boolean));
    c.note("calls", ok.length);
  });
  await check(S, "the forced fallback happened once per call and is on the receipt", async (c) => {
    const failed = cs.filter((x) => x.failed && x.requested_model === "acme/retired-model-v1");
    const fell = cs.filter((x) => x.peebloFallback && x.status === 200);
    expect(failed.length >= 1 && fell.length >= 1, `failed ${failed.length}, fell back ${fell.length}`);
    expect(receipt.fallbacks >= 1, "receipt shows no fallback");
    c.note("served", [...new Set(fell.map((x) => x.served_model))]);
  });
  await check(S, "the receipt is built from events only and matches Otari", async (c) => {
    const sum = cs.reduce((a, x) => a + (Number(x.cost_usd) || 0), 0);
    expect(Math.abs(receipt.cost_usd - Math.round((sum + receipt.interrupted.reduce((a: number, i: any) => a + (i.settled_cost_usd ?? 0), 0)) * 1e6) / 1e6) < 1e-6, "receipt cost differs from the events");
    expect(receipt.links?.trace_id, "no trace link");
    c.note("line", receipt.line);
    c.note("interrupted", receipt.interrupted);
    c.note("trace", receipt.links.session);
  });
  await save(S);
} finally {
  if (guardMode() === "lakera") await setLakera(st.mandateWas);
  await pool.end();
}
