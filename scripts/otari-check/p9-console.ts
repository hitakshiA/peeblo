// Phase 9 "done when": what Peeblo does in Slack can be done in the console, from the same API. Signed in with the
// console password (a cookie, no admin token): talk to a teammate and get its answer and receipt; hire one from the
// form (a real Slack app, removed afterwards); change a teammate; and the console stays off the public URL.
import { check, expect, save } from "./harness.ts";
const { pool } = await import("../../src/db.ts");
const { config } = await import("../../src/config.ts");

const S = "P9";
const B = `http://127.0.0.1:${config.apiPort}`;
const login = await fetch(`${B}/v1/console/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: config.consolePassword }) });
const cookie = String(login.headers.get("set-cookie") ?? "").split(";")[0];
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(B + path, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${j.error ?? ""}`);
  return j;
};

await check(S, "signed in, a person talks to a teammate and gets its answer and receipt", async (c) => {
  expect(login.status === 200 && cookie.startsWith("peeblo_console="), `login ${login.status}`);
  const s = await call("POST", "/v1/teammates/scout/sessions", { kind: "api", place_key: `console:${Date.now()}` });
  const { run_id } = await call("POST", `/v1/sessions/${s.id}/submissions`, { text: "In one sentence, what do you do for the team?", request_id: `p9-${Date.now()}` });
  let r: any;
  for (let i = 0; i < 90; i++) { r = await call("GET", `/v1/runs/${run_id}`); if (["done", "failed"].includes(r.run.status)) break; await new Promise((x) => setTimeout(x, 2000)); }
  const said = r.events.filter((e: any) => e.type === "turn.finished" || e.type === "slack.post").map((e: any) => e.data.text).join(" ");
  const receipt = await call("GET", `/v1/runs/${run_id}/receipt`);
  const person = (await pool.query("SELECT person_id FROM submissions WHERE id = (SELECT submission_id FROM runs WHERE id = $1)", [run_id])).rows[0]?.person_id;
  c.note("answer", said.slice(0, 120)); c.note("receipt", receipt.line);
  expect(r.run.status === "done" && said.length > 10 && receipt.calls >= 1, `run ${r.run.status}, receipt ${receipt.line}`);
  expect(person, "the console's person wasn't filled in");
});

await check(S, "a hire from the console form makes the teammate and its Slack app", async (c) => {
  const slug = `console-hire-${Date.now().toString(36)}`;
  const h = await call("POST", "/v1/console/hire", { slug, name: "Wick", role: "Console hire check", model: { default: "deepseek/deepseek-v4.1-flash-1017" }, budget: { monthly_usd: 1 }, tools: [], connectors: [], mode: "ask" });
  c.note("install_url", Boolean(h.install_url)); c.note("app_error", h.app_error ?? null);
  expect(h.teammate?.slug === slug && h.install_url, `hire: ${JSON.stringify(h).slice(0, 200)}`);
  const ov = await call("GET", `/v1/teammates/${slug}/overview`);
  expect(ov.app?.app_id && ov.app.installed === false, `app: ${JSON.stringify(ov.app)}`);
  const { deleteTeammateApp } = await import("../../src/slack/admin.ts");
  await deleteTeammateApp(ov.app.app_id);
});

await check(S, "a teammate change from the console is a new version; without the cookie the API refuses", async () => {
  const before = (await call("GET", "/v1/teammates/scout")).version;
  const after = await call("PATCH", "/v1/teammates/scout", { budget: { monthly_usd: 5 }, note: "console check" });
  expect(after.version === before + 1, `versions ${before} → ${after.version}`);
  const anon = await fetch(`${B}/v1/teammates`);
  expect(anon.status === 401, `without a cookie: ${anon.status}`);
  const pub = await fetch(`${config.publicUrl}/console/`).catch(() => null);
  expect(!pub || pub.status === 404, `on the public URL: ${pub?.status}`);
});
await pool.end();
process.exit((await save(S)) ? 0 : 1);
