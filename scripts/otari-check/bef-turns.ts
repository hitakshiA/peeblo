// Seams B (proxy and receipts), E (web) and F (code), each through a real teammate turn: API → run → Pi →
// Peeblo's proxy → hosted Otari. Needs core running (./peeblo up).
import { check, expect, save } from "./harness.ts";
import { api, answer, calls, ensureTeammate, settle, submit, tools } from "./api.ts";
import { admin } from "../../src/otari/admin.ts";
import { pool } from "../../src/db.ts";

const slug = "otari-check";
const stamp = Date.now().toString(36);
await ensureTeammate(slug, {
  name: "Check", role: "Runs Peeblo's Otari checks", model: { default: "deepseek/deepseek-v4.1-flash-1017", fallback: "z-ai/glm-5.3" },
  budget: { monthly_usd: 2 }, tools: ["web", "code"], web: { allowed_domains: ["github.com"] }, connectors: [], mode: "auto",
});

await check("B", "a turn's calls go through the proxy with Peeblo's identity on them", async (c) => {
  const { sessionId, runId } = await submit(slug, `C0CHECK:b-${stamp}`, "In one sentence: what is a receipt in accounting?", `b-${stamp}`);
  const { run, events } = await settle(runId);
  expect(run.status === "done", `run ${run.status}: ${run.error}`);
  const m = calls(events).find((x) => x.status === 200 && x.role !== "guard");
  expect(m?.request_id && m.provider && m.served_model && m.attempts >= 1 && m.cost_usd > 0, `incomplete call event: ${JSON.stringify(m)}`);
  expect(m.end_user === "slack-T0CFKBN3YPM-U0CGL01BU72", `end user ${m.end_user}`);
  c.ids.push(m.request_id);
  // What Otari recorded for that request: the tags and the paying person Peeblo set.
  const u = await admin<any>("GET", `/organizations/me/usage?request_group_id=${m.request_id}&limit=1`, undefined, "x", "x");
  const row = (u.data ?? u)[0];
  expect(row?.tags?.teammate === slug && row.tags.session === sessionId && row.tags.run === runId, `tags ${JSON.stringify(row?.tags)}`);
  const receipt = await api<any>("GET", `/v1/runs/${runId}/receipt`);
  expect(receipt.cost_usd > 0 && receipt.request_ids.includes(m.request_id), "receipt does not match the events");
  c.note("key", m.key);
  c.note("receipt", receipt.line);
});

await check("B", "Peeblo falls back to the teammate's second model when the first can't serve", async (c) => {
  await api("PATCH", `/v1/teammates/${slug}`, { model: { default: "acme/retired-model-v1", fallback: "z-ai/glm-5.3" }, note: "force a fallback" });
  try {
    const { runId } = await submit(slug, `C0CHECK:bf-${stamp}`, "In one sentence: what is a ledger?", `bf-${stamp}`);
    const { run, events } = await settle(runId);
    expect(run.status === "done", `run ${run.status}: ${run.error}`);
    const cs = calls(events);
    const failed = cs.find((x) => x.failed);
    const ok = cs.find((x) => x.status === 200 && x.peebloFallback);
    expect(failed && ok, `calls ${JSON.stringify(cs.map((x) => [x.status, x.requested_model, x.peebloFallback]))}`);
    c.ids.push(...cs.map((x) => x.request_id).filter(Boolean));
    c.note("failed_code", failed.error_code ?? failed.error?.slice(0, 80));
  } finally {
    await api("PATCH", `/v1/teammates/${slug}`, { model: { default: "deepseek/deepseek-v4.1-flash-1017", fallback: "z-ai/glm-5.3" }, note: "restore" });
  }
});

await check("E", "web search and fetch inside the teammate's allowed sites", async (c) => {
  const { runId } = await submit(slug, `C0CHECK:e-${stamp}`, "What is the latest release of earendil-works/gondolin on GitHub? Then also open https://www.bbc.co.uk/news and tell me what the tool said.", `e-${stamp}`);
  const { run, events } = await settle(runId);
  expect(run.status === "done", `run ${run.status}: ${run.error}`);
  const t = tools(events).filter((x) => x.by === "otari");
  // The model may search or go straight to the page; either is Otari's web tool doing the work.
  expect(t.some((x) => (x.tool === "web_search" || x.tool === "web_fetch") && x.status === "completed"), `no search or fetch: ${JSON.stringify(t)}`);
  expect(tools(events).some((x) => x.tool === "web_fetch" && x.status === "refused" && String(x.reason).includes("bbc")), "the off-list fetch was not refused");
  c.ids.push(...calls(events).map((x) => x.request_id).filter(Boolean));
  c.note("tools", t.map((x) => `${x.tool}:${x.status}`));
});

await check("F", "code runs in Otari's sandbox and the sandbox is kept for the session", async (c) => {
  const place = `C0CHECK:f-${stamp}`;
  const a = await submit(slug, place, "Using code: store the list 412, 398, 455, 301, 288 in a variable called signups and print its sum.", `f1-${stamp}`);
  const r1 = await settle(a.runId);
  const b = await submit(slug, place, "Using code, without redefining anything, print max(signups).", `f2-${stamp}`);
  const r2 = await settle(b.runId);
  const t1 = tools(r1.events).find((x) => x.tool === "code_execution");
  const t2 = tools(r2.events).find((x) => x.tool === "code_execution");
  expect(t1?.status === "completed" && t2?.status === "completed", `code calls ${t1?.status} / ${t2?.status}`);
  expect(t1.sandbox && t1.sandbox === t2.sandbox, `sandboxes ${t1.sandbox} / ${t2.sandbox}`);
  expect(String(t2.stdout).includes("455"), `second run printed ${t2.stdout}`);
  c.ids.push(...[...calls(r1.events), ...calls(r2.events)].map((x) => x.request_id).filter(Boolean));
  c.note("sandbox", t1.sandbox);
  c.note("answer", answer(r2.events).slice(0, 120));
});
await pool.end();
const ok = [await save("B"), await save("E"), await save("F")].every(Boolean);
process.exit(ok ? 0 : 1);
