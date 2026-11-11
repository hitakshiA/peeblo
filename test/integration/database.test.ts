// Integration tests on a real Postgres: the durable guarantees Peeblo promises. They run when PEEBLO_TEST_DATABASE_URL
// points at an empty database (CI starts one; locally: docker run -e POSTGRES_PASSWORD=t -p 55432:5432 postgres:18),
// and are skipped otherwise, so `pnpm test` needs no database.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.PEEBLO_TEST_DATABASE_URL;
const skip = url ? false : "PEEBLO_TEST_DATABASE_URL is not set";

let db: typeof import("../../src/db.ts");
let sessions: typeof import("../../src/store/sessions.ts");
let events: typeof import("../../src/store/events.ts");
let teammates: typeof import("../../src/store/teammates.ts");

before(async () => {
  if (!url) return;
  // Core reads DATABASE_URL when config loads; point it at the test database before anything imports it.
  process.env.DATABASE_URL = url;
  db = await import("../../src/db.ts");
  sessions = await import("../../src/store/sessions.ts");
  events = await import("../../src/store/events.ts");
  teammates = await import("../../src/store/teammates.ts");
  // Start from an empty database every time.
  await db.pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
});
after(async () => {
  if (url) await db.pool.end();
});

test("migrations apply in order, and a second run applies nothing", { skip }, async () => {
  const first = await db.migrate();
  assert.ok(first.length >= 17, `applied ${first.length}`);
  assert.deepEqual([...first].sort(), first);
  assert.deepEqual(await db.migrate(), []);
  const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM schema_migrations");
  assert.equal(rows[0].n, first.length);
});

test("a submission is idempotent on its request id: one run, however often Slack redelivers it", { skip }, async () => {
  const tm = await teammates.createTeammate(
    `it-${Date.now()}`,
    { name: "Itest", role: "integration test", model: { default: "peeblo-worker" } },
    { personId: null, label: "test" },
  );
  const s = await sessions.openSession(tm.id, "dm", `D1:${Date.now()}`);
  const again = await sessions.openSession(tm.id, "dm", s.place_key);
  assert.equal(again.id, s.id, "the same place opens the same session");
  const ask = { sessionId: s.id, personId: null, requestId: `slack:evt-${Date.now()}`, text: "hello", source: "slack" };
  const a = await sessions.submit(ask);
  const b = await sessions.submit(ask);
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(b.run.id, a.run.id);
  const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM runs WHERE session_id = $1", [s.id]);
  assert.equal(rows[0].n, 1);
});

test("the event log is append-only and read back in order", { skip }, async () => {
  const tm = await teammates.createTeammate(
    `ev-${Date.now()}`,
    { name: "Evtest", role: "integration test", model: { default: "peeblo-worker" } },
    { personId: null, label: "test" },
  );
  const s = await sessions.openSession(tm.id, "api", `api:${Date.now()}`);
  const { run } = await sessions.submit({ sessionId: s.id, personId: null, requestId: `api:${Date.now()}`, text: "count", source: "api" });
  for (let i = 1; i <= 5; i++) await events.appendEvent({ sessionId: s.id, runId: run.id, type: "turn.started", data: { turn: i } });
  const got = (await events.runEvents(run.id)).filter((e) => e.type === "turn.started").map((e) => (e.data as { turn: number }).turn);
  assert.deepEqual(got, [1, 2, 3, 4, 5]);
});

test("a teammate's config is versioned: an edit is a new version, the old one stays readable", { skip }, async () => {
  const tm = await teammates.createTeammate(
    `ver-${Date.now()}`,
    { name: "Vtest", role: "first role", model: { default: "peeblo-worker" } },
    { personId: null, label: "test" },
  );
  const next = await teammates.updateTeammate(tm.slug, { role: "second role" }, { label: "test" });
  assert.equal(next.version, tm.version + 1);
  assert.equal((await teammates.teammateAt(tm.id, tm.version))?.config.role, "first role");
  assert.equal((await teammates.getTeammate(tm.slug))?.config.role, "second role");
});
