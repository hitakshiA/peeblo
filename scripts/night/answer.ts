// Answer an approval through Peeblo's API as a person (a test helper when no one can press the Slack button):
//   node scripts/night/answer.ts <approval_id> <approved|denied> <person: hitakshi|maya|jun>
const { config } = await import("../../src/config.ts");
const { pool } = await import("../../src/db.ts");
const [id, decision, who] = process.argv.slice(2);
const p = (await pool.query("SELECT id FROM people WHERE lower(display_name) LIKE $1 ORDER BY created_at LIMIT 1", [`${who}%`])).rows[0];
const r = await fetch(`http://127.0.0.1:${config.apiPort}/v1/approvals/${id}`, { method: "POST", headers: { authorization: `Bearer ${config.adminToken}`, "content-type": "application/json" }, body: JSON.stringify({ decision, person_id: p?.id }) });
console.log(r.status, await r.text());
await pool.end();
