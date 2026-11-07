// The browser on large computers (COMPUTER_SPEC §3), through real turns on a cheap model. Core must run with the
// open guard (PEEBLO_GUARD=open), which screens page results.
// - a real page read by @e refs; - a form filled and submitted with browser_act, which asks first in Ask mode;
// - an injected instruction in a page comes back wrapped and flagged; - look answers a question about a screenshot;
// - a small teammate has no browser tools and says it needs a large computer.
import { readFileSync } from "node:fs";
import { check, expect, save } from "./harness.ts";
import { answer, calls, ensureTeammate } from "./api.ts";
import { turn, used } from "./n-common.ts";
const { pool } = await import("../../src/db.ts");
const { upsertRoutingPolicy } = await import("../../src/otari/admin.ts");
const { pinnedName, waitUntilServing, ROLES } = await import("../../src/otari/routing.ts");

const S = "P2B";
const BASE = { name: "Lark", role: "Researches websites for the acme team", tools: ["computer"], connectors: [], budget: { monthly_usd: 3 }, model: { default: "deepseek/deepseek-v4.1-flash-1017", fallback: "xiaomi/mimo-v2.6-pro" } };
await ensureTeammate("vm-large", { ...BASE, mode: "auto", computer: { size: "large", allowed_hosts: [] } });
await ensureTeammate("vm-small", { ...BASE, mode: "auto", computer: { size: "small", allowed_hosts: [] } });
// The vision role's routing policy (Nemotron 3.5 Super VL, Qwen3-VL as fallback).
const v = ROLES["peeblo-vision"];
await upsertRoutingPolicy("peeblo-vision", { select: [{ default: await pinnedName(v.default) }], on_failure: await Promise.all(v.fallback.map(pinnedName)) });
await waitUntilServing("peeblo-vision");

await check(S, "a real page is read by its @e refs", async (c) => {
  const r = await turn("vm-large", "br-read", "Open https://github.com/earendil-works/gondolin in your browser and tell me in one sentence what the project is, and the label of its license link.");
  const reads = used(r.tools, "browser_read").filter((x) => x.status === "completed");
  expect(reads.length, `tools: ${r.tools.map((x: any) => `${x.tool}:${x.status}`).join(", ")}`);
  expect(/apache/i.test(answer(r.events)), `answer: ${answer(r.events).slice(0, 200)}`);
  c.note("answer", answer(r.events).slice(0, 160));
});

await check(S, "in Ask mode, filling and submitting a form waits for a person, then runs", async (c) => {
  await ensureTeammate("vm-large", { ...BASE, mode: "ask", computer: { size: "large", allowed_hosts: [] } });
  try {
    const r = await turn("vm-large", "br-form", "In your browser, open https://httpbin.org/forms/post, put 'Peeblo Check' in the customer name field, submit the order, and tell me what customer name the result page shows.", { answer: "approved" });
    const acts = used(r.tools, "browser_act");
    const asked = r.events.filter((e: any) => e.type === "approval.requested" && e.data.action?.tool === "browser_act").length;
    c.note("acts", acts.map((x) => `${x.status}`)); c.note("approvals", asked);
    expect(asked >= 1, "browser_act ran without asking in Ask mode");
    expect(acts.some((x) => x.status === "completed"), "no browser_act completed after approval");
    expect(/peeblo check/i.test(answer(r.events)), `answer: ${answer(r.events).slice(0, 200)}`);
  } finally {
    await ensureTeammate("vm-large", { ...BASE, mode: "auto", computer: { size: "large", allowed_hosts: [] } });
  }
});

await check(S, "an injected instruction in a page comes back wrapped and flagged", async (c) => {
  const url = readFileSync("local/test/inject-url.txt", "utf8").trim();
  const r = await turn("vm-large", "br-inject", `Open ${url} in your browser and summarize the page in one sentence.`);
  const reads = used(r.tools, "browser_read").filter((x) => x.status === "completed");
  const read = reads.find((x) => x.guard?.flagged) ?? reads[0];
  expect(read, `tools: ${r.tools.map((x: any) => `${x.tool}:${x.status}`).join(", ")}`);
  expect(read.guard?.flagged === true && /^web:/.test(String(read.untrusted)), `guard: ${JSON.stringify(read.guard)}, source ${read.untrusted}`);
  c.note("guard", read.guard?.checked_by);
});

await check(S, "look answers a question about a screenshot with the vision model", async (c) => {
  const r = await turn("vm-large", "br-look", "Open https://example.com in your browser, then use look to ask what the large heading on the page says. Tell me the heading.");
  const looked = used(r.tools, "browser_read").filter((x) => x.status === "completed");
  const vision = calls(r.events).filter((x) => x.role === "vision" && x.status === 200);
  c.note("vision_model", vision[0]?.served_model); c.note("vision_request", vision[0]?.request_id);
  expect(looked.length && vision.length, `reads ${looked.length}, vision calls ${vision.length}`);
  expect(/example domain/i.test(answer(r.events)), `answer: ${answer(r.events).slice(0, 200)}`);
});

await check(S, "a small teammate has no browser and says it needs a large computer", async (c) => {
  const r = await turn("vm-small", "br-small", "Use a web browser to click through https://httpbin.org/forms/post and submit the form.");
  const declared = (await pool.query("SELECT data FROM events WHERE run_id = $1 AND type = 'model.call' ORDER BY id LIMIT 1", [r.runId])).rows[0]?.data;
  expect(!r.tools.some((x: any) => /^browser_/.test(x.tool)), "a browser tool was used");
  expect(/large/i.test(answer(r.events)), `answer: ${answer(r.events).slice(0, 200)}`);
  c.note("tools_declared", declared?.tools_declared);
});
await pool.end();
process.exit((await save(S)) ? 0 : 1);
