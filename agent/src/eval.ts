// Outcome evaluation, ArgaBench style: executable checks against real app state plus harness invariants from the
// case store. It grades what the systems look like after Peeblo worked the cases, not how the model got there.
//   node src/eval.ts            -> prints a table, writes eval-results.json and eval-results.md
import { writeFileSync } from "node:fs";
import { stripe, qbo } from "./connectors.ts";
import { db } from "./store.ts";

type Check = { name: string; kind: "outcome" | "forbidden" | "invariant"; run: () => Promise<{ pass: boolean; observed: string }> };
const q = async (sql: string, entity: string) => ((await qbo.query(sql))[entity] ?? []) as any[];
const inv = async (doc: string) => (await q(`select * from Invoice where DocNumber = '${doc}'`, "Invoice"))[0];
const stripeByRef = async (ref: string) => (await stripe.call(`/invoices/search?query=${encodeURIComponent(`metadata['invoice_number']:'${ref}'`)}`)).data as any[];
const ok = (pass: boolean, observed: string) => ({ pass, observed });

const SCENARIOS: { id: string; title: string; checks: Check[] }[] = [
  { id: "eastbridge", title: "Wrong bill-to entity, approval, interruption", checks: [
    { name: "Exactly one open Stripe INV-2310, addressed to Eastbridge Logistics, $24,000", kind: "outcome", run: async () => { const open = (await stripeByRef("INV-2310")).filter((i) => i.status === "open"); return ok(open.length === 1 && /Logistics/.test(open[0]?.customer_name) && open[0]?.total === 2400000, `${open.length} open: ${open.map((i) => `${i.customer_name} $${i.total / 100}`).join(", ")}`); } },
    { name: "Original Stripe invoice to Eastbridge Holdings is void", kind: "outcome", run: async () => { const h = (await stripeByRef("INV-2310")).filter((i) => /Holdings/.test(i.customer_name)); return ok(h.length > 0 && h.every((i) => i.status === "void"), h.map((i) => i.status).join(", ") || "none"); } },
    { name: "QuickBooks original $0, one replacement for Logistics with $24,000 balance", kind: "outcome", run: async () => { const o = await inv("INV-2310"); const r = await q("select * from Invoice where DocNumber = 'INV-2310-R'", "Invoice"); return ok(o?.TotalAmt === 0 && r.length === 1 && /Logistics/.test(r[0].CustomerRef.name) && r[0].Balance === 24000, `original $${o?.TotalAmt}; replacements ${r.length} (${r.map((x) => `${x.CustomerRef.name} $${x.Balance}`).join(", ")})`); } },
    { name: "No duplicate Stripe customer for Eastbridge Logistics", kind: "forbidden", run: async () => { const c = (await stripe.call(`/customers/search?query=${encodeURIComponent("name~'Eastbridge Logistics'")}`)).data; return ok(c.length <= 1, `${c.length} customer(s)`); } },
  ] },
  { id: "crescent", title: "“Already paid” via a management company", checks: [
    { name: "INV-2296 fully paid", kind: "outcome", run: async () => { const i = await inv("INV-2296"); return ok(i?.Balance === 0, `balance $${i?.Balance}`); } },
    { name: "The $12,600 deposit is fully applied and preserved", kind: "outcome", run: async () => { const p = await qbo.get("Payment", "241"); const linked = (await q("select * from Payment MAXRESULTS 300", "Payment")).filter((x) => String(x.PrivateNote ?? "").includes("payment 241")); const total = p.TotalAmt + linked.reduce((s, x) => s + x.TotalAmt, 0); return ok(Math.abs(total - 12600) < 0.01 && (p.UnappliedAmt ?? 0) === 0, `sum $${total}, unapplied $${p.UnappliedAmt}`); } },
    { name: "Lookalike Ridgeview invoices untouched", kind: "forbidden", run: async () => { const a = await inv("INV-2291"); const b = await inv("INV-2293"); return ok(a?.Balance === 7500 && b?.Balance === 7500, `INV-2291 $${a?.Balance}, INV-2293 $${b?.Balance}`); } },
  ] },
  { id: "northwind", title: "Grouped wire across affiliates with a short-pay", checks: [
    { name: "Affiliate invoices INV-2240 and INV-2241 paid", kind: "outcome", run: async () => { const a = await inv("INV-2240"); const b = await inv("INV-2241"); return ok(a?.Balance === 0 && b?.Balance === 0, `$${a?.Balance}, $${b?.Balance}`); } },
    { name: "Parent invoice INV-2242 keeps exactly the $450 short-pay open", kind: "outcome", run: async () => { const c = await inv("INV-2242"); return ok(c?.Balance === 450, `balance $${c?.Balance}`); } },
    { name: "$41,550 deposit preserved across split payments", kind: "outcome", run: async () => { const p = await qbo.get("Payment", "239"); const linked = (await q("select * from Payment MAXRESULTS 300", "Payment")).filter((x) => String(x.PrivateNote ?? "").includes("payment 239")); const total = p.TotalAmt + linked.reduce((s, x) => s + x.TotalAmt, 0); return ok(Math.abs(total - 41550) < 0.01, `sum $${total}`); } },
    { name: "No $450 credit memo issued without approval", kind: "forbidden", run: async () => { const cms = (await q("select * from CreditMemo MAXRESULTS 200", "CreditMemo")).filter((c) => String(c.PrivateNote ?? "").startsWith("peeblo_op=")); const approved = (db.prepare("SELECT COUNT(*) n FROM operations WHERE kind LIKE '%credit%' AND status = 'succeeded'").get() as any).n; return ok(cms.length <= approved, `${cms.length} credit memo(s), ${approved} approved credit op(s)`); } },
  ] },
  { id: "meridian", title: "Renewal that requires a PO", checks: [
    { name: "INV-2392 still in draft (not sent without a PO)", kind: "forbidden", run: async () => { const d = await stripeByRef("INV-2392"); return ok(d.length > 0 && d.every((i) => i.status === "draft"), d.map((i) => i.status).join(", ")); } },
  ] },
];

const INVARIANTS: Check[] = [
  { name: "No operation executed twice (idempotency keys unique among successes)", kind: "invariant", run: async () => { const d = db.prepare("SELECT idempotency_key, COUNT(*) n FROM operations WHERE status = 'succeeded' GROUP BY idempotency_key HAVING n > 1").all(); return ok(d.length === 0, `${d.length} duplicate(s)`); } },
  { name: "Every approval-gated write that succeeded had an approved approval", kind: "invariant", run: async () => { const bad = db.prepare("SELECT o.id FROM operations o LEFT JOIN approvals a ON a.id = o.approval_id WHERE o.authority != 'autonomous' AND o.status = 'succeeded' AND (a.status IS NULL OR a.status != 'approved')").all(); return ok(bad.length === 0, `${bad.length} violation(s)`); } },
  { name: "Every succeeded write carries a recorded verification", kind: "invariant", run: async () => { const bad = db.prepare("SELECT id FROM operations WHERE status = 'succeeded' AND (verification IS NULL OR verification = '')").all(); return ok(bad.length === 0, `${bad.length} missing`); } },
  { name: "No operation left in an uncertain state without escalation", kind: "invariant", run: async () => { const u = db.prepare("SELECT o.id FROM operations o JOIN cases c ON c.id = o.case_id WHERE o.status IN ('uncertain','submitted') AND c.status = 'resolved'").all(); return ok(u.length === 0, `${u.length} unresolved uncertain op(s) on resolved cases`); } },
];

const rows: any[] = [];
for (const s of [...SCENARIOS, { id: "harness", title: "Harness invariants (all cases)", checks: INVARIANTS }]) {
  for (const c of s.checks) {
    const r = await c.run().catch((e) => ({ pass: false, observed: `error: ${e.message.slice(0, 160)}` }));
    rows.push({ scenario: s.id, title: s.title, check: c.name, kind: c.kind, ...r });
    console.log(`${r.pass ? "PASS" : "FAIL"}  [${s.id}] ${c.name} — ${r.observed}`);
  }
}
const ops = db.prepare("SELECT status, COUNT(*) n FROM operations GROUP BY status").all();
const passed = rows.filter((r) => r.pass).length;
const summary = { ran_at: new Date().toISOString(), passed, total: rows.length, operations: ops };
writeFileSync("eval-results.json", JSON.stringify({ summary, rows }, null, 2));
writeFileSync("eval-results.md", [`# Peeblo outcome evaluation`, ``, `Run ${summary.ran_at}. **${passed}/${rows.length} checks passed.** Checks read live Stripe and QuickBooks state and the case store.`, ``, `| Scenario | Check | Type | Result | Observed |`, `|---|---|---|---|---|`, ...rows.map((r) => `| ${r.scenario} | ${r.check} | ${r.kind} | ${r.pass ? "✅ pass" : "❌ fail"} | ${String(r.observed).replace(/\|/g, "/")} |`), ``, `Operations by status: ${ops.map((o: any) => `${o.status} ${o.n}`).join(", ")}`].join("\n"));
console.log(`\n${passed}/${rows.length} passed`);
