// §1g step 2: Peeblo helps directly (R1′), live. A quick lookup it does itself; heavy work it delegates and says who;
// one listener per channel (a message tagging a teammate is that teammate's); a new detail goes to the job already
// working on it; Peeblo starts under 20 tools.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, expect, save } from "./harness.ts";
import { answer, calls } from "./api.ts";
import { turn } from "./n-common.ts";
const { pool } = await import("../../src/db.ts");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const S = "R7";

await check(S, "a quick lookup Peeblo does itself (a connector read, no delegation)", async (c) => {
  const r = await turn("peeblo", `cos-direct-${Date.now().toString(36)}`, "How many GRO issues in Linear are in Todo right now? Just the number and their ids.");
  const used = r.tools.map((x: any) => x.tool);
  c.note("tools", used);
  c.note("answer", answer(r.events).slice(0, 160));
  expect(used.some((t: string) => /^linear__/.test(t)), `no Linear read: ${used.join(", ")}`);
  expect(!used.includes("delegate"), "it delegated a lookup");
  const first = calls(r.events).find((x) => x.role !== "guard" && x.status === 200);
  c.note("tools_declared", first?.tools_declared);
  expect(first && first.tools_declared < 20, `first call declared ${first?.tools_declared} tools`);
});

if (!process.env.R7_ONLY) await check(S, "heavy work (a computer job) is delegated, and the person is told who has it", async (c) => {
  const r = await turn("peeblo", `cos-heavy-${Date.now().toString(36)}`, "Please check out our acme checkout-api repo, run its test suite on a computer, and tell me which tests fail.", { answer: "approved" });
  const used = r.tools.map((x: any) => x.tool);
  const call = r.events.find((e: any) => e.type === "chain.call")?.data;
  c.note("tools", used); c.note("callee", call?.callee ?? null); c.note("answer", answer(r.events).slice(0, 200));
  expect(used.includes("delegate"), `no delegation: ${used.join(", ")}`);
  const name = call?.callee ? (await pool.query("SELECT v.config->>'name' n FROM teammates t JOIN teammate_versions v ON v.teammate_id = t.id AND v.version = t.version WHERE t.slug = $1", [call.callee])).rows[0]?.n : null;
  expect(name && new RegExp(name, "i").test(answer(r.events) + r.events.filter((e: any) => e.type === "slack.post").map((e: any) => e.data.text).join(" ")), `didn't say who has it (${name})`);
});

if (!process.env.R7_ONLY) await check(S, "one listener: a channel message tagging a teammate gets no Peeblo run", async (c) => {
  const SECRETS = process.env.PEEBLO_SECRETS_DIR ?? join(import.meta.dirname, "../../local/secrets");
  const tok = JSON.parse(readFileSync(join(SECRETS, "slack-users.json"), "utf8"))["U0CFKNZLLSF"].token;
  const call = async (m: string, b: any, read = false) => (await (await fetch(`https://slack.com/api/${m}`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": read ? "application/x-www-form-urlencoded" : "application/json; charset=utf-8" }, body: read ? new URLSearchParams(b) : JSON.stringify(b) })).json());
  const growth = (await call("conversations.list", { types: "public_channel", limit: "200" }, true)).channels.find((x: any) => x.name === "growth").id;
  const bot = (await pool.query("SELECT a.bot_user_id FROM slack_apps a JOIN teammates t ON t.id = a.teammate_id WHERE t.slug = 'grove'")).rows[0].bot_user_id;
  const m = await call("chat.postMessage", { channel: growth, text: `<@${bot}> what's the newest GRO issue?` });
  await wait(40_000);
  const runs = (await pool.query("SELECT t.slug FROM runs r JOIN submissions s ON s.id = r.submission_id JOIN sessions se ON se.id = r.session_id JOIN teammates t ON t.id = se.teammate_id WHERE s.request_id LIKE $1", [`slack:%:${m.ts}`])).rows.map((x) => x.slug);
  c.note("runs_for_message", runs);
  expect(runs.includes("grove"), `Grove didn't pick it up: ${runs.join(", ")}`);
  expect(!runs.includes("peeblo"), "Peeblo also read a message tagging another teammate");
});

await check(S, "a new detail goes to the job already working on it", async (c) => {
  const d = await turn("peeblo", `cos-job-${Date.now().toString(36)}`, "Delegate to Grove: for each of the 8 newest GRO issues, get its full details and write a one-line summary. Don't ask me anything.", { answer: "approved" });
  const child = d.events.find((e: any) => e.type === "chain.call")?.data?.child_run;
  expect(child, "no job for Grove");
  const r = await turn("peeblo", `cos-detail-${Date.now().toString(36)}`, `For the job Grove is doing right now (${child}): please also include each issue's assignee. Pass that on rather than starting something new.`);
  const used = r.tools.map((x: any) => `${x.tool}:${x.status}`);
  const fwd = r.events.find((e: any) => e.type === "job.detail_forwarded")?.data;
  c.note("tools", used); c.note("forwarded", fwd ?? null);
  expect(fwd?.job === child, `not forwarded to ${child}: ${used.join(", ")}`);
  const sub = (await pool.query("SELECT text FROM submissions WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1", [fwd.to_session])).rows[0]?.text;
  expect(/assignee/i.test(sub ?? ""), `the job's thread didn't get the detail: ${sub}`);
});
await save(S);
await pool.end();
process.exit(0);
