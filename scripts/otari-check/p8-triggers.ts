// Phase 8 "done when": "every night" (cron), "after every deploy" (webhook) and "when 500s spike" (watch) each fire
// once, and only wake the teammate when there's work. Each is made by a real turn (the teammate writes the schedule);
// the cron tick is fired as the scheduler would; the webhook goes through the public URL, signed; the watch polls a
// real Linear query, and a test issue changes it.
import { createHmac } from "node:crypto";
import { check, expect, save } from "./harness.ts";
import { answer, api } from "./api.ts";
import { teammate, turn, used } from "./n-common.ts";
const { pool } = await import("../../src/db.ts");
const { config } = await import("../../src/config.ts");
const { unseal } = await import("../../src/crypto.ts");
const T = await import("../../src/triggers.ts");

const S = "P8";
const tm = await teammate("trigger-check", { tools: [], connectors: ["linear"], mode: "auto" });
const created = async (r: any, tool: string) => (used(r.tools, tool).find((x) => x.status === "completed")?.result?.id as string) ?? null;
const sched = async (id: string) => (await pool.query("SELECT * FROM schedules WHERE id = $1", [id])).rows[0];
const runsOf = async (id: string) => (await pool.query("SELECT r.id, r.status FROM runs r JOIN submissions s ON s.id = r.submission_id WHERE s.request_id LIKE $1", [`%:${id}:%`])).rows;
const settled = async (runId: string) => { for (let i = 0; i < 120; i++) { const r = (await pool.query("SELECT status FROM runs WHERE id = $1", [runId])).rows[0]; if (["done", "failed"].includes(r?.status)) return r.status; await new Promise((x) => setTimeout(x, 3000)); } return "timeout"; };

await check(S, "every night: the teammate writes the schedule, and a tick runs it once", async (c) => {
  const r = await turn(tm, "p8-cron", "Every night at 21:00 UTC, look at the GRO team in Linear and post a one-line summary of issues created that day; if there are none, post nothing.");
  const id = await created(r, "schedule");
  expect(id, `schedule tool: ${JSON.stringify(used(r.tools, "schedule").map((x) => [x.status, x.error]))}`);
  const s = await sched(id!);
  expect(s.kind === "cron" && /^\d+ 21 \* \* \*$/.test(s.cron), `cron: ${s.cron}`);
  const run = (await api("POST", `/v1/schedules/${id}/run`)).run_id as string;
  expect(run && (await settled(run)) === "done", "the scheduled run didn't finish");
  const ran = (await pool.query("SELECT data FROM events WHERE type = 'schedule.ran' AND data->>'run_id' = $1", [run])).rows[0]?.data;
  c.note("findings", ran?.findings);
  expect(ran, "the run wasn't logged with its findings");
  await pool.query("UPDATE schedules SET enabled = false WHERE id = $1", [id]);
});

await check(S, "after every deploy: a signed webhook wakes it for a successful deploy, and a failed one is skipped", async (c) => {
  const r = await turn(tm, "p8-hook", "After every successful deploy of acme-checkout-api (GitHub deployment_status events with state success), check the 3 newest GRO issues for anything about checkout and tell me. Set that up.");
  const id = await created(r, "webhook_trigger");
  expect(id, `webhook_trigger: ${JSON.stringify(used(r.tools, "webhook_trigger").map((x) => [x.status, x.error]))}`);
  const s = await sched(id!);
  c.note("filter", s.filter);
  const secret = unseal<string>(s.secret);
  const post = async (state: string) => {
    const body = JSON.stringify({ deployment_status: { state }, deployment: { environment: "production" }, repository: { full_name: "hitakshiA/acme-checkout-api" } });
    const res = await fetch(`${config.publicUrl}/hooks/trigger-check/${id}`, { method: "POST", headers: { "content-type": "application/json", "x-github-event": "deployment_status", "x-github-delivery": `check-${state}-${Date.now()}`, "x-hub-signature-256": "sha256=" + createHmac("sha256", secret).update(body).digest("hex") }, body });
    return [res.status, await res.text()] as const;
  };
  const bad = await post("failure");
  const before = (await runsOf(id!)).length;
  const good = await post("success");
  const unsigned = await fetch(`${config.publicUrl}/hooks/trigger-check/${id}`, { method: "POST", headers: { "content-type": "application/json", "x-github-event": "deployment_status" }, body: "{}" });
  c.note("responses", { failure: bad, success: good, unsigned: unsigned.status });
  expect(bad[0] === 202 && /skipped/.test(bad[1]) && before === 0, `failed deploy: ${bad}`);
  expect(good[0] === 202 && /run ru_/.test(good[1]), `successful deploy: ${good}`);
  expect(unsigned.status === 401, "an unsigned hook was accepted");
  const run = good[1].replace(/^run /, "");
  expect((await settled(run)) === "done", "the triggered run didn't finish");
});

await check(S, "when 500s spike (a watch): it wakes only when the watched data changes", async (c) => {
  const r = await turn(tm, "p8-watch", "Watch the newest 5 issues of the Linear GRO team (Linear's list_issues) every hour, and tell me when a new one mentions 500 errors.");
  const id = await created(r, "watch");
  expect(id, `watch: ${JSON.stringify(used(r.tools, "watch").map((x) => [x.status, x.error]))}`);
  const poll = async () => (await api("POST", `/v1/schedules/${id}/run`)).result as string;
  const first = await poll();
  const second = await poll();
  expect(first === "baseline" && second === "unchanged" && (await runsOf(id!)).length === 0, `polls: ${first}, ${second}`);
  // A real change: a test issue in GRO about 500s (removed afterwards).
  const { catalogFor, executeTool } = await import("../../src/connectors/mcp.ts");
  const { getTeammate } = await import("../../src/store/teammates.ts");
  const cat = await catalogFor((await getTeammate("trigger-check"))!.config);
  const save1 = cat.tools.find((t) => t.server === "linear" && /save_issue|create_issue/.test(t.tool))!;
  const made = await executeTool(save1, { team: "GRO", title: `Checkout API returns 500 errors (watch check ${Date.now().toString(36)})`, description: "Created by Peeblo's trigger check; safe to remove." });
  const third = await poll();
  const runs = await runsOf(id!);
  c.note("polls", [first, second, third]); c.note("runs", runs.length);
  expect(third === "changed" && runs.length === 1, `after the change: ${third}, runs ${runs.length}`);
  expect((await settled(runs[0].id)) === "done", "the watch run didn't finish");
  const issueId = JSON.stringify(made.data).match(/"id"\s*:\s*"([0-9a-f-]{36})"/)?.[1];
  const del = cat.tools.find((t) => t.server === "linear" && /delete_issue|archive_issue/.test(t.tool));
  if (issueId && del) await executeTool(del, { id: issueId }).catch(() => null);
  await pool.query("UPDATE schedules SET enabled = false WHERE id = $1", [id]);
});
await pool.end();
process.exit((await save(S)) ? 0 : 1);
