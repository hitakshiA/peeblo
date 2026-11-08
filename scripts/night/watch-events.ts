// Prints one line per event worth a look while a story runs: failures, stuck runs, budget blocks, refusals, Slack
// errors and slow steps. Polls the event log every 5 s from now on.
const { pool } = await import("../../src/db.ts");
let last = Number((await pool.query("SELECT coalesce(max(id), 0) AS m FROM events")).rows[0].m);
const watch = ["run.failed", "run.stuck", "budget.blocked", "guard.blocked", "guard.unavailable", "approval.rejoined"];
for (;;) {
  const rows = (await pool.query("SELECT id, type, run_id, data FROM events WHERE id > $1 ORDER BY id LIMIT 500", [last])).rows;
  for (const e of rows) {
    last = Number(e.id);
    const d = e.data as any;
    const bad = watch.includes(e.type) || (e.type === "tool.call" && ["failed", "invalid", "refused"].includes(d.status)) || (e.type === "model.call" && Number(d.status) >= 400) || (e.type === "stop_check.decided" && d.verdict === "continue");
    if (bad) console.log(`${e.type} ${e.run_id ?? ""} ${d.tool ?? ""} ${d.status ?? d.verdict ?? ""} ${String(d.error ?? d.reason ?? d.message ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
  }
  await new Promise((r) => setTimeout(r, 5000));
}
