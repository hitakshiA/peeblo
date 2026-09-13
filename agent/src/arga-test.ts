// Reliability test against an Arga Stripe twin: an approved wrong-entity reissue whose write is accepted but whose
// response is lost. Pass = the executor reconciles instead of retrying blindly, leaving exactly one replacement.
//   node src/arga-test.ts provision   -> provisions a Stripe twin (costs one Arga boot-up), saves /tmp/arga-run.json
//   node src/arga-test.ts run         -> seeds the twin, runs the executor scenario, diffs twin state, writes a report
import { writeFileSync, readFileSync } from "node:fs";
import { loadEnv } from "../../seed/lib/env.ts";
import { request } from "../../seed/lib/http.ts";

const env = loadEnv();
const ARGA = "https://api.argalabs.com";
const H = { Authorization: `Bearer ${env.ARGA_API_KEY}` };
const RUN_FILE = "/tmp/arga-run.json";
const mode = process.argv[2];
const redact = (o: any) => JSON.parse(JSON.stringify(o, (k, v) => (/key|secret|token|password/i.test(k) && typeof v === "string" ? `${v.slice(0, 7)}…` : v)));

if (mode === "provision") {
  const { run_id } = await request(`${ARGA}/validate/twins/provision`, { headers: H, json: { twins: ["stripe"], ttl_minutes: 10, public: true } });
  let status: any;
  for (let i = 0; i < 90; i++) {
    status = await request(`${ARGA}/validate/twins/provision/${run_id}/status`, { headers: H });
    if (["ready", "failed", "error"].includes(status.status)) break;
    await new Promise((r) => setTimeout(r, 4000));
  }
  writeFileSync(RUN_FILE, JSON.stringify({ run_id, ...status }, null, 2));
  console.log(JSON.stringify(redact({ run_id, ...status }), null, 2));
  process.exit(0);
}

const run = JSON.parse(readFileSync(RUN_FILE, "utf8"));
const twin = run.twins?.stripe ?? run.twins?.[0];
const vars = twin.env_vars ?? {};
process.env.STRIPE_API_BASE = String(twin.base_url).replace(/\/v1\/?$/, "").replace(/\/$/, "");
// Twins accept any key with a Stripe test prefix; never send the real key to the sandbox.
process.env.STRIPE_SECRET_KEY_OVERRIDE = String(vars.STRIPE_SECRET_KEY ?? vars.STRIPE_API_KEY ?? "sk_test_peeblo_arga_twin");
process.env.PEEBLO_DB = "/tmp/peeblo-arga.db";
process.env.PEEBLO_APPROVALS_NO_SLACK = "1";
process.env.PEEBLO_FAULT = "lose_response:stripe.create_invoice";

const { stripe } = await import("./connectors.ts");
const { propose, retry, decide } = await import("./executor.ts");
const { cases, db } = await import("./store.ts");
const state = async () => request(`${twin.admin_url}/admin/state`, { headers: { ...H, ...(run.proxy_token ? { "X-Arga-Proxy-Token": run.proxy_token } : {}) } }).catch((e) => ({ unavailable: e.message.slice(0, 200) }));
const log: string[] = [];
const say = (m: string) => { console.log(m); log.push(m); };

say(`Arga run ${run.run_id} · Stripe twin ${process.env.STRIPE_API_BASE}`);
// Seed: parent and subsidiary customers, and an issued invoice addressed to the wrong one.
const holdings = await stripe.call("/customers", { form: { name: "Eastbridge Holdings", "metadata[legal_name]": "Eastbridge Holdings, Inc.", "metadata[tax_id]": "36-4418207" } });
const logistics = await stripe.call("/customers", { form: { name: "Eastbridge Logistics", "metadata[legal_name]": "Eastbridge Logistics LLC", "metadata[tax_id]": "84-2917365" } });
const draft = await stripe.call("/invoices", { form: { customer: holdings.id, collection_method: "send_invoice", days_until_due: "30", "metadata[invoice_number]": "INV-2310" } });
await stripe.call("/invoiceitems", { form: { customer: holdings.id, invoice: draft.id, description: "Platform seats, Q3 2026 (80 seats)", amount: "2400000", currency: "usd" } });
const wrong = await stripe.call(`/invoices/${draft.id}/finalize`, { form: {} });
say(`seeded: ${wrong.id} ${wrong.status} $${wrong.total / 100} to ${wrong.customer_name}`);
const before = await state();

const c = cases.create("Arga: interrupted reissue", "Twin test: reissue INV-2310 from Eastbridge Holdings to Eastbridge Logistics LLC with a lost response");
const approve = async (res: any) => {
  if (res.status !== "awaiting_approval") return res;
  const d = await decide(res.approval_id, (env.SLACK_APPROVER_USER_IDS ?? "").split(",")[0], "approved");
  return (db.prepare("SELECT status, verification, error, id FROM operations WHERE id = ?").get(res.operation_id) as any) ?? d;
};
say(`void wrong invoice -> ${JSON.stringify(await approve(await propose(c.id, "stripe.void_invoice", { invoice_id: wrong.id }, "wrong bill-to entity")))}`);
const params = { customer_id: logistics.id, lines: [{ description: "Platform seats, Q3 2026 (80 seats)", quantity: 80, unit_amount_usd: 300 }], days_until_due: 30, invoice_ref: "INV-2310", finalize: true, replaces_invoice_id: wrong.id };
const first = await approve(await propose(c.id, "stripe.create_invoice", params, "reissue to the contracting entity"));
say(`create replacement (provider accepts, response lost) -> ${JSON.stringify(first)}`);
const op = db.prepare("SELECT id FROM operations WHERE kind = 'stripe.create_invoice' AND case_id = ?").get(c.id) as { id: string };
say(`retry -> ${JSON.stringify(await retry(op.id))}`);
say(`retry again (must be a no-op) -> ${JSON.stringify(await propose(c.id, "stripe.create_invoice", { ...params, memo: "rephrased by a resumed run" }, "same change, different wording"))}`);

const after = await state();
const invoices = (await stripe.call(`/invoices?customer=${logistics.id}&limit=100`)).data;
const orig = await stripe.call(`/invoices/${wrong.id}`);
const checks = {
  original_void: orig.status === "void",
  exactly_one_replacement: invoices.length === 1,
  replacement_open_to_logistics: invoices[0]?.status === "open" && invoices[0]?.customer === logistics.id,
  replacement_amount_matches: invoices[0]?.total === wrong.total,
};
say(`checks: ${JSON.stringify(checks)}`);
const pass = Object.values(checks).every(Boolean);
say(pass ? "PASS" : "FAIL");
writeFileSync("/tmp/arga-report.json", JSON.stringify({ run_id: run.run_id, pass, checks, log, state_before: before, state_after: after }, null, 2));
