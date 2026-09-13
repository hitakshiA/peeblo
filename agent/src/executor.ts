import { db, now, id, hash, evidence, wakeups } from "./store.ts";
import { stripe, qbo, hubspot, jira, slack, env } from "./connectors.ts";
import { HttpError } from "../../seed/lib/http.ts";
import { emit } from "./bus.ts";

// The model proposes; this module decides. Authority, approval binding, the intent log,
// recovery from uncertain writes, and independent verification are all deterministic code.

type Authority = "autonomous" | "ar_approver" | "cfo";
type Params = Record<string, any>;
interface ActionSpec {
  description: string;
  params: string; // human-readable parameter contract shown to the model
  authority: (p: Params) => Authority;
  amount?: (p: Params) => number | undefined;
  execute: (p: Params, idempotencyKey: string, ctx?: ExecContext) => Promise<any>;
  // Finds an already-applied effect after an uncertain outcome, so retries never duplicate.
  reconcile?: (p: Params, idempotencyKey: string) => Promise<any | undefined>;
  verify: (p: Params, result: any) => Promise<{ ok: boolean; observed: string }>;
  // Business identity of the write. Resumed runs may phrase params differently; this keeps one operation per real change.
  identity?: (p: Params) => unknown;
  // Multi-step actions whose execute() is idempotent per step; resuming re-runs it and skips completed steps.
  resumable?: boolean;
}
interface ExecContext { step: (name: string, detail: string, reused: boolean) => void; checkpoint: (name: string) => void }

const cents = (usd: number) => String(Math.round(usd * 100));
const money = (n: number) => Math.round(n * 100) / 100;
const byAmount = (amt: number): Authority => (amt <= 250 ? "autonomous" : amt <= 5000 ? "ar_approver" : "cfo");
const customFields = (fields: { name: string; value: string }[]) =>
  Object.fromEntries(fields.slice(0, 4).flatMap((f, i) => [[`custom_fields[${i}][name]`, f.name], [`custom_fields[${i}][value]`, f.value]]));

export const ACTIONS: Record<string, ActionSpec> = {
  "billing.reissue_to_correct_entity": {
    description: "Approved correction for an issued invoice addressed to the wrong legal entity. In order, and resumable step by step: ensure a Stripe customer for the correct entity, void the wrong Stripe invoice, create and finalize the replacement for the correct entity (same lines and reference), void the wrong QuickBooks invoice, and create the QuickBooks replacement for the correct customer. One approval covers the whole correction.",
    params: "{ stripe_invoice_id, qbo_invoice_id, correct_entity: { legal_name, display_name, tax_id, email, city?, state? }, qbo_customer_id, stripe_customer_id?, days_until_due, reason }",
    authority: () => "ar_approver",
    identity: (p) => ({ stripe_invoice_id: p.stripe_invoice_id, qbo_invoice_id: p.qbo_invoice_id, legal_name: p.correct_entity?.legal_name }),
    amount: () => undefined,
    resumable: true,
    execute: async (p, key, ctx) => {
      const step = (name: string, detail: string, reused: boolean) => ctx?.step(name, detail, reused);
      const original = await stripe.call(`/invoices/${p.stripe_invoice_id}?expand[]=lines`);
      const ref = original.metadata?.invoice_number ?? original.number;
      // 1. Stripe customer for the correct entity
      let customerId = p.stripe_customer_id as string | undefined;
      if (!customerId) {
        const existing = (await stripe.call(`/customers/search?query=${encodeURIComponent(`metadata['peeblo_op']:'${key}'`)}`)).data[0];
        customerId = existing?.id ?? (await stripe.call("/customers", { idempotencyKey: `${key}-customer`, form: { name: p.correct_entity.display_name ?? p.correct_entity.legal_name, email: p.correct_entity.email ?? "", "address[city]": p.correct_entity.city ?? "", "address[state]": p.correct_entity.state ?? "", "address[country]": "US", "metadata[legal_name]": p.correct_entity.legal_name, "metadata[tax_id]": p.correct_entity.tax_id ?? "", "metadata[peeblo_op]": key } })).id;
        step("stripe.customer", `${p.correct_entity.legal_name} (${customerId})`, Boolean(existing));
      }
      // 2. Void the wrong Stripe invoice
      const current = await stripe.call(`/invoices/${p.stripe_invoice_id}`);
      if (current.status !== "void") { await stripe.call(`/invoices/${p.stripe_invoice_id}/void`, { idempotencyKey: `${key}-void`, form: {} }); step("stripe.void_invoice", `${ref} to ${original.customer_name} voided`, false); }
      else step("stripe.void_invoice", `${ref} already void`, true);
      // 3. Replacement Stripe invoice
      let replacement = (await stripe.call(`/invoices/search?query=${encodeURIComponent(`metadata['peeblo_op']:'${key}'`)}`)).data[0];
      const reused = Boolean(replacement);
      if (!replacement) {
        replacement = await stripe.call("/invoices", { idempotencyKey: `${key}-invoice`, form: { customer: customerId!, collection_method: "send_invoice", days_until_due: String(p.days_until_due ?? 30), auto_advance: "false", pending_invoice_items_behavior: "exclude", description: original.description ?? "", "metadata[invoice_number]": ref, "metadata[replaces]": p.stripe_invoice_id, "metadata[peeblo_op]": key, ...customFields([{ name: "Invoice ref", value: ref }, { name: "Bill to", value: p.correct_entity.legal_name }, ...(p.correct_entity.tax_id ? [{ name: "Customer EIN", value: p.correct_entity.tax_id }] : [])]) } });
        for (const [i, l] of original.lines.data.entries()) await stripe.call("/invoiceitems", { idempotencyKey: `${key}-line-${i}`, form: { customer: customerId!, invoice: replacement.id, description: l.description, quantity: String(l.quantity ?? 1), unit_amount_decimal: String(l.pricing?.unit_amount_decimal ?? l.price?.unit_amount_decimal ?? Math.round(l.amount / (l.quantity ?? 1))), currency: "usd" } });
      }
      if (replacement.status === "draft" || !reused) replacement = await stripe.call(`/invoices/${replacement.id}/finalize`, { idempotencyKey: `${key}-finalize`, form: { auto_advance: "false" } }).catch(async () => stripe.call(`/invoices/${replacement.id}`));
      step("stripe.create_invoice", `${ref} to ${p.correct_entity.legal_name} ${replacement.id} $${replacement.total / 100}`, reused);
      ctx?.checkpoint("stripe replacement created");
      // 4. Void the wrong QuickBooks invoice
      const qOriginal = await qbo.get("Invoice", p.qbo_invoice_id);
      const total = qOriginal.TotalAmt || replacement.total / 100;
      if (qOriginal.TotalAmt !== 0) { await qbo.post("Invoice", { Id: qOriginal.Id, SyncToken: qOriginal.SyncToken }, "&operation=void"); step("qbo.void_invoice", `${qOriginal.DocNumber} to ${qOriginal.CustomerRef.name} voided`, false); }
      else step("qbo.void_invoice", `${qOriginal.DocNumber} already void`, true);
      // 5. QuickBooks replacement
      let qReplacement = ((await qbo.query(`select * from Invoice where DocNumber = '${ref}-R'`)).Invoice ?? []).find((i: any) => String(i.PrivateNote ?? "").includes(key));
      const qReused = Boolean(qReplacement);
      qReplacement ??= await qbo.post("Invoice", { DocNumber: `${ref}-R`, TxnDate: new Date().toISOString().slice(0, 10), DueDate: new Date(Date.now() + (p.days_until_due ?? 30) * 86400000).toISOString().slice(0, 10), CustomerRef: { value: p.qbo_customer_id }, PrivateNote: `Replaces ${qOriginal.DocNumber} (wrong bill-to entity); Stripe ${replacement.id} [peeblo_op=${key}]`, CustomerMemo: qOriginal.CustomerMemo, Line: qOriginal.Line.filter((l: any) => l.DetailType === "SalesItemLineDetail").map((l: any) => ({ Amount: l.Amount, DetailType: l.DetailType, Description: l.Description, SalesItemLineDetail: { ItemRef: l.SalesItemLineDetail.ItemRef, Qty: l.SalesItemLineDetail.Qty, UnitPrice: l.SalesItemLineDetail.UnitPrice } })) });
      step("qbo.create_invoice", `${qReplacement.DocNumber} to ${qReplacement.CustomerRef.name} $${qReplacement.TotalAmt ?? total}`, qReused);
      return { id: replacement.id, stripe_replacement_id: replacement.id, qbo_replacement_id: qReplacement.Id, stripe_customer_id: customerId, total };
    },
    verify: async (p, r) => {
      const [so, sr, qo, qr] = await Promise.all([stripe.call(`/invoices/${p.stripe_invoice_id}`), stripe.call(`/invoices/${r.stripe_replacement_id}`), qbo.get("Invoice", p.qbo_invoice_id), qbo.get("Invoice", r.qbo_replacement_id)]);
      const ok = so.status === "void" && sr.status === "open" && sr.customer === r.stripe_customer_id && qo.TotalAmt === 0 && qr.CustomerRef.value === p.qbo_customer_id && Math.abs(qr.Balance - sr.amount_due / 100) < 0.01;
      return { ok, observed: `Stripe ${so.number ?? so.id} ${so.status}; replacement ${sr.metadata?.invoice_number} ${sr.status} to ${sr.customer_name} $${sr.amount_due / 100}. QuickBooks ${qo.DocNumber} total $${qo.TotalAmt}; replacement ${qr.DocNumber} to ${qr.CustomerRef.name} balance $${qr.Balance}` };
    },
  },
  "stripe.create_customer": {
    identity: (p) => ({ legal_name: p.legal_name, tax_id: p.tax_id }),
    description: "Create a Stripe customer for a verified legal entity.",
    params: "{ name, email, legal_name, tax_id?, address_city?, address_state? }",
    authority: () => "autonomous",
    execute: (p, key) => stripe.call("/customers", { idempotencyKey: key, form: { name: p.name, email: p.email, "address[city]": p.address_city ?? "", "address[state]": p.address_state ?? "", "address[country]": "US", "metadata[legal_name]": p.legal_name, "metadata[tax_id]": p.tax_id ?? "", "metadata[peeblo_op]": key } }),
    reconcile: async (_p, key) => (await stripe.call(`/customers/search?query=${encodeURIComponent(`metadata['peeblo_op']:'${key}'`)}`)).data[0],
    verify: async (_p, r) => { const c = await stripe.call(`/customers/${r.id}`); return { ok: !c.deleted, observed: `customer ${c.id} ${c.name}` }; },
  },
  "stripe.update_draft_invoice": {
    description: "Change a DRAFT Stripe invoice: set custom fields (e.g. PO Number) and/or replace its line items. Finalized invoices cannot be edited.",
    params: "{ invoice_id, custom_fields?: [{name,value}], lines?: [{description, quantity, unit_amount_usd}] }",
    authority: () => "autonomous",
    execute: async (p, key) => {
      const inv = await stripe.call(`/invoices/${p.invoice_id}`);
      if (inv.status !== "draft") throw new Error(`invoice ${p.invoice_id} is ${inv.status}, not draft`);
      if (p.lines) {
        for (const li of inv.lines.data) if (li.invoice_item) await stripe.call(`/invoiceitems/${li.invoice_item}`, { method: "DELETE" });
        for (const [i, l] of p.lines.entries()) await stripe.call("/invoiceitems", { idempotencyKey: `${key}-line-${i}`, form: { customer: inv.customer, invoice: inv.id, description: l.description, quantity: String(l.quantity), unit_amount_decimal: cents(l.unit_amount_usd), currency: "usd" } });
      }
      if (p.custom_fields) await stripe.call(`/invoices/${inv.id}`, { form: customFields(p.custom_fields) });
      return stripe.call(`/invoices/${inv.id}`);
    },
    verify: async (p) => { const inv = await stripe.call(`/invoices/${p.invoice_id}`); return { ok: inv.status === "draft", observed: `draft total $${inv.total / 100}; fields ${JSON.stringify(inv.custom_fields)}` }; },
  },
  "stripe.finalize_invoice": {
    identity: (p) => ({ invoice_id: p.invoice_id }),
    description: "Finalize a draft Stripe invoice so it becomes open and payable.",
    params: "{ invoice_id }",
    authority: () => "autonomous",
    execute: (p, key) => stripe.call(`/invoices/${p.invoice_id}/finalize`, { idempotencyKey: key, form: { auto_advance: "false" } }),
    verify: async (p) => { const inv = await stripe.call(`/invoices/${p.invoice_id}`); return { ok: inv.status === "open", observed: `${inv.number} ${inv.status} $${inv.amount_due / 100}` }; },
  },
  "stripe.void_invoice": {
    identity: (p) => ({ invoice_id: p.invoice_id }),
    description: "Void an issued (open) Stripe invoice. Use only as part of an approved correction.",
    params: "{ invoice_id }",
    authority: () => "ar_approver",
    amount: () => undefined,
    execute: (p, key) => stripe.call(`/invoices/${p.invoice_id}/void`, { idempotencyKey: key, form: {} }),
    reconcile: async (p) => { const inv = await stripe.call(`/invoices/${p.invoice_id}`); return inv.status === "void" ? inv : undefined; },
    verify: async (p) => { const inv = await stripe.call(`/invoices/${p.invoice_id}`); return { ok: inv.status === "void", observed: `invoice ${inv.id} is ${inv.status}` }; },
  },
  "stripe.create_invoice": {
    identity: (p) => ({ customer_id: p.customer_id, invoice_ref: p.invoice_ref, replaces: p.replaces_invoice_id ?? null }),
    description: "Create (and optionally finalize) a Stripe invoice for a customer. Used for missing invoices and approved reissues.",
    params: "{ customer_id, lines: [{description, quantity, unit_amount_usd}], days_until_due, custom_fields?: [{name,value}], memo?, invoice_ref, finalize: boolean, replaces_invoice_id? }",
    authority: (p) => (p.replaces_invoice_id ? "ar_approver" : "autonomous"),
    amount: (p) => money(p.lines.reduce((s: number, l: any) => s + l.quantity * l.unit_amount_usd, 0)),
    execute: async (p, key) => {
      const fields = [...(p.custom_fields ?? []), { name: "Invoice ref", value: p.invoice_ref }].slice(0, 4);
      const inv = await stripe.call("/invoices", { idempotencyKey: key, form: { customer: p.customer_id, collection_method: "send_invoice", days_until_due: String(p.days_until_due), auto_advance: "false", pending_invoice_items_behavior: "exclude", description: p.memo ?? "", "metadata[invoice_number]": p.invoice_ref, "metadata[peeblo_op]": key, ...(p.replaces_invoice_id ? { "metadata[replaces]": p.replaces_invoice_id } : {}), ...customFields(fields) } });
      for (const [i, l] of p.lines.entries()) await stripe.call("/invoiceitems", { idempotencyKey: `${key}-line-${i}`, form: { customer: p.customer_id, invoice: inv.id, description: l.description, quantity: String(l.quantity), unit_amount_decimal: cents(l.unit_amount_usd), currency: "usd" } });
      return p.finalize ? stripe.call(`/invoices/${inv.id}/finalize`, { idempotencyKey: `${key}-finalize`, form: { auto_advance: "false" } }) : stripe.call(`/invoices/${inv.id}`);
    },
    reconcile: async (_p, key) => (await stripe.call(`/invoices/search?query=${encodeURIComponent(`metadata['peeblo_op']:'${key}'`)}`)).data[0],
    verify: async (p, r) => { const inv = await stripe.call(`/invoices/${r.id}`); const want = cents(ACTIONS["stripe.create_invoice"].amount!(p)!); return { ok: String(inv.total) === want && inv.customer === p.customer_id, observed: `${inv.id} ${inv.status} to ${inv.customer_name} total $${inv.total / 100}` }; },
  },
  "stripe.create_credit_note": {
    identity: (p) => ({ invoice_id: p.invoice_id, amount_usd: p.amount_usd }),
    description: "Issue a credit note against an open or paid Stripe invoice.",
    params: "{ invoice_id, amount_usd, reason: 'duplicate'|'order_change'|'product_unsatisfactory', memo }",
    authority: (p) => byAmount(p.amount_usd),
    amount: (p) => p.amount_usd,
    execute: (p, key) => stripe.call("/credit_notes", { idempotencyKey: key, form: { invoice: p.invoice_id, amount: cents(p.amount_usd), reason: p.reason, memo: p.memo, "metadata[peeblo_op]": key } }),
    reconcile: async (p, key) => (await stripe.call(`/credit_notes?invoice=${p.invoice_id}&limit=20`)).data.find((c: any) => c.metadata?.peeblo_op === key),
    verify: async (p, r) => { const cn = await stripe.call(`/credit_notes/${r.id}`); return { ok: cn.amount === Number(cents(p.amount_usd)) && cn.status !== "void", observed: `credit note ${cn.number} $${cn.amount / 100}` }; },
  },
  "qbo.apply_payment": {
    description: "Apply an existing unapplied QuickBooks payment to one or more open invoices of the SAME QuickBooks customer.",
    params: "{ payment_id, applications: [{ invoice_id, amount_usd }] }",
    authority: () => "autonomous",
    amount: (p) => money(p.applications.reduce((s: number, a: any) => s + a.amount_usd, 0)),
    execute: async (p) => {
      const pay = await qbo.get("Payment", p.payment_id);
      const applied = (pay.Line ?? []).reduce((s: number, l: any) => s + l.Amount, 0);
      const adding = money(p.applications.reduce((s: number, a: any) => s + a.amount_usd, 0));
      if (money(applied + adding) > pay.TotalAmt) throw new Error(`applications $${adding} exceed unapplied $${money(pay.TotalAmt - applied)}`);
      for (const a of p.applications) {
        const inv = await qbo.get("Invoice", a.invoice_id);
        if (inv.CustomerRef.value !== pay.CustomerRef.value) throw new Error(`invoice ${inv.DocNumber} belongs to ${inv.CustomerRef.name}, payment to ${pay.CustomerRef.name}; move the payment to the right customer first`);
        if (a.amount_usd > inv.Balance) throw new Error(`amount $${a.amount_usd} exceeds ${inv.DocNumber} balance $${inv.Balance}`);
      }
      return qbo.post("Payment", { Id: pay.Id, SyncToken: pay.SyncToken, sparse: true, CustomerRef: pay.CustomerRef, TotalAmt: pay.TotalAmt, Line: [...(pay.Line ?? []), ...p.applications.map((a: any) => ({ Amount: a.amount_usd, LinkedTxn: [{ TxnId: a.invoice_id, TxnType: "Invoice" }] }))] });
    },
    reconcile: async (p) => { const pay = await qbo.get("Payment", p.payment_id); const linked = new Set((pay.Line ?? []).flatMap((l: any) => l.LinkedTxn.map((t: any) => t.TxnId))); return p.applications.every((a: any) => linked.has(a.invoice_id)) ? pay : undefined; },
    verify: async (p) => { const pay = await qbo.get("Payment", p.payment_id); const invs = await Promise.all(p.applications.map((a: any) => qbo.get("Invoice", a.invoice_id))); return { ok: invs.every((i) => (pay.Line ?? []).some((l: any) => l.LinkedTxn.some((t: any) => t.TxnId === i.Id))), observed: invs.map((i) => `${i.DocNumber} balance $${i.Balance}`).join("; ") + `; payment unapplied $${pay.UnappliedAmt}` }; },
  },
  "qbo.create_customer": {
    identity: (p) => ({ display_name: p.display_name }),
    description: "Create a QuickBooks customer for a verified legal entity.",
    params: "{ display_name, company_name, email?, notes? }",
    authority: () => "autonomous",
    execute: (p) => qbo.post("Customer", { DisplayName: p.display_name, CompanyName: p.company_name, Notes: p.notes, ...(p.email ? { PrimaryEmailAddr: { Address: p.email } } : {}) }),
    reconcile: async (p) => (await qbo.query(`select * from Customer where DisplayName = '${p.display_name.replace(/'/g, "\\'")}'`)).Customer?.[0],
    verify: async (_p, r) => { const c = await qbo.get("Customer", r.Id); return { ok: c.Active, observed: `QBO customer ${c.Id} ${c.DisplayName}` }; },
  },
  "qbo.void_invoice": {
    identity: (p) => ({ invoice_id: p.invoice_id }),
    description: "Void a QuickBooks invoice (e.g. a duplicate or an invoice being reissued to the correct entity).",
    params: "{ invoice_id }",
    authority: () => "ar_approver",
    execute: async (p) => { const inv = await qbo.get("Invoice", p.invoice_id); return qbo.post("Invoice", { Id: inv.Id, SyncToken: inv.SyncToken }, "&operation=void"); },
    reconcile: async (p) => { const inv = await qbo.get("Invoice", p.invoice_id); return inv.Balance === 0 && /void/i.test(inv.PrivateNote ?? "") ? inv : undefined; },
    verify: async (p) => { const inv = await qbo.get("Invoice", p.invoice_id); return { ok: inv.Balance === 0 && inv.TotalAmt === 0, observed: `${inv.DocNumber} total $${inv.TotalAmt} balance $${inv.Balance}` }; },
  },
  "qbo.create_invoice": {
    identity: (p) => ({ customer_id: p.customer_id, doc_number: p.doc_number }),
    description: "Create a QuickBooks invoice. Only when no Stripe→QuickBooks sync will create it; check Systems of Record policy.",
    params: "{ customer_id, doc_number, txn_date, due_date, lines: [{description, quantity, unit_amount_usd, item_id}], private_note }",
    authority: (p) => (/reissue|replac/i.test(p.private_note ?? "") ? "ar_approver" : "autonomous"),
    amount: (p) => money(p.lines.reduce((s: number, l: any) => s + l.quantity * l.unit_amount_usd, 0)),
    execute: (p, key) => qbo.post("Invoice", { DocNumber: p.doc_number, TxnDate: p.txn_date, DueDate: p.due_date, CustomerRef: { value: p.customer_id }, PrivateNote: `${p.private_note} [peeblo_op=${key}]`, Line: p.lines.map((l: any) => ({ Amount: money(l.quantity * l.unit_amount_usd), DetailType: "SalesItemLineDetail", Description: l.description, SalesItemLineDetail: { ItemRef: { value: l.item_id }, Qty: l.quantity, UnitPrice: l.unit_amount_usd } })) }),
    reconcile: async (p, key) => (await qbo.query(`select * from Invoice where DocNumber = '${p.doc_number}'`)).Invoice?.find((i: any) => (i.PrivateNote ?? "").includes(key)),
    verify: async (p, r) => { const inv = await qbo.get("Invoice", r.Id); return { ok: inv.TotalAmt === ACTIONS["qbo.create_invoice"].amount!(p) && inv.CustomerRef.value === p.customer_id, observed: `${inv.DocNumber} to ${inv.CustomerRef.name} $${inv.TotalAmt}` }; },
  },
  "qbo.create_credit_memo": {
    identity: (p) => ({ customer_id: p.customer_id, amount_usd: p.amount_usd }),
    description: "Create a QuickBooks credit memo for a customer.",
    params: "{ customer_id, amount_usd, item_id, description }",
    authority: (p) => byAmount(p.amount_usd),
    amount: (p) => p.amount_usd,
    execute: (p, key) => qbo.post("CreditMemo", { CustomerRef: { value: p.customer_id }, PrivateNote: `peeblo_op=${key}`, Line: [{ Amount: p.amount_usd, DetailType: "SalesItemLineDetail", Description: p.description, SalesItemLineDetail: { ItemRef: { value: p.item_id }, Qty: 1, UnitPrice: p.amount_usd } }] }),
    reconcile: async (_p, key) => ((await qbo.query("select * from CreditMemo MAXRESULTS 200")).CreditMemo ?? []).find((c: any) => c.PrivateNote === `peeblo_op=${key}`),
    verify: async (p, r) => { const cm = await qbo.get("CreditMemo", r.Id); return { ok: cm.TotalAmt === p.amount_usd, observed: `credit memo ${cm.Id} $${cm.TotalAmt}` }; },
  },
  "hubspot.log_note": {
    description: "Record internal context on a HubSpot company (promise to pay, status, contact change).",
    params: "{ company_id, body }",
    authority: () => "autonomous",
    execute: (p) => hubspot.call("/crm/v3/objects/notes", { properties: { hs_timestamp: now(), hs_note_body: `[Peeblo] ${p.body}` }, associations: [{ to: { id: p.company_id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 190 }] }] }),
    verify: async (_p, r) => { const n = await hubspot.call(`/crm/v3/objects/notes/${r.id}?properties=hs_note_body`); return { ok: Boolean(n.id), observed: `note ${n.id}` }; },
  },
  "customer.send_email": {
    description: "Send an email to a customer contact from ar@minylabs.com (recorded as an outbound email on the HubSpot company). Approved templates (reminders, receipts, statements, factual answers) are autonomous; anything that commits money, admits fault or changes terms needs approval.",
    params: "{ company_id, to, subject, body, template: 'reminder'|'receipt'|'statement'|'factual_answer'|'custom' }",
    authority: (p) => (["reminder", "receipt", "statement", "factual_answer"].includes(p.template) ? "autonomous" : "ar_approver"),
    execute: (p) => hubspot.call("/crm/v3/objects/emails", { properties: { hs_timestamp: now(), hs_email_direction: "EMAIL", hs_email_status: "SENT", hs_email_subject: p.subject, hs_email_text: p.body, hs_email_headers: JSON.stringify({ from: { email: "ar@minylabs.com" }, to: [{ email: p.to }] }) }, associations: [{ to: { id: p.company_id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 186 }] }] }),
    verify: async (_p, r) => ({ ok: Boolean(r.id), observed: `outbound email ${r.id} recorded` }),
  },
  "jira.comment": {
    description: "Comment on a Jira issue (follow up on a dependency, attach billing impact).",
    params: "{ issue_key, body }",
    authority: () => "autonomous",
    execute: (p) => jira.call(`/issue/${p.issue_key}/comment`, { body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: `[Peeblo] ${p.body}` }] }] } }),
    verify: async (p, r) => { const c = await jira.call(`/issue/${p.issue_key}/comment/${r.id}`); return { ok: Boolean(c.id), observed: `comment ${c.id} on ${p.issue_key}` }; },
  },
  "jira.create_issue": {
    description: "Create a Jira task for another team (billing defect, sync bug, dispute needing engineering).",
    params: "{ summary, description, labels: string[] }",
    authority: () => "autonomous",
    execute: (p) => jira.call("/issue", { fields: { project: { key: env.JIRA_PROJECT_KEY }, issuetype: { name: "Task" }, summary: p.summary, labels: p.labels, description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: p.description }] }] } } }),
    verify: async (_p, r) => { const i = await jira.call(`/issue/${r.key}?fields=summary`); return { ok: Boolean(i.key), observed: `${i.key} ${i.fields.summary}` }; },
  },
  "slack.post": {
    description: "Post an internal update in Slack (#ar-desk thread or a DM to an internal owner). Never for customers.",
    params: "{ text, thread_ts? }",
    authority: () => "autonomous",
    execute: (p) => slack.call("chat.postMessage", { channel: env.SLACK_ASSIGNMENTS_CHANNEL_ID, text: p.text, thread_ts: p.thread_ts }),
    verify: async (_p, r) => ({ ok: Boolean(r.ts), observed: `slack message ${r.ts}` }),
  },
};

// ------------------------------------------------------------------------------------------------
type OpRow = { id: string; case_id: string; kind: string; params: string; idempotency_key: string; amount: number | null; authority: string; status: string; approval_id: string | null; result: string | null; verification: string | null; error: string | null };
const getOp = (opId: string) => db.prepare("SELECT * FROM operations WHERE id = ?").get(opId) as OpRow | undefined;
const setOp = (opId: string, patch: Partial<OpRow>) => {
  const cols = Object.keys(patch);
  db.prepare(`UPDATE operations SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...cols.map((c) => (patch as any)[c]), now(), opId);
};

// Test hook: PEEBLO_FAULT=lose_response:<kind> makes the next such write succeed at the provider
// but lose its response, exercising the uncertain-outcome recovery path.
let faultArmed = process.env.PEEBLO_FAULT ?? "";
export class InterruptedError extends Error {}
// Demo/test control: interrupt the whole run right after the provider accepts the next write of this kind
// (or any write with "*"), before the result is recorded. The operation stays "submitted".
let interruptArmed = "";
export const interrupts = { arm: (kind: string) => { interruptArmed = kind; }, disarm: () => { interruptArmed = ""; }, armed: () => interruptArmed };

async function run(op: OpRow): Promise<any> {
  const spec = ACTIONS[op.kind];
  const params = JSON.parse(op.params);
  if (op.status === "uncertain" || op.status === "submitted") {
    const found = spec.reconcile ? await spec.reconcile(params, op.idempotency_key) : undefined;
    if (found) { emit(op.case_id, undefined, "operation.reconciled", { operation_id: op.id, kind: op.kind, provider_id: found.id ?? found.Id }); return finish(op, params, found, "found the effect already applied after the interruption; no duplicate created"); }
    if (!spec.reconcile && !spec.resumable) throw new Error(`operation ${op.id} outcome unknown and ${op.kind} cannot be reconciled; escalate`);
    if (spec.resumable) emit(op.case_id, undefined, "operation.resuming", { operation_id: op.id, kind: op.kind });
  }
  setOp(op.id, { status: "submitted" });
  emit(op.case_id, undefined, "operation.submitted", { operation_id: op.id, kind: op.kind, params, amount: op.amount });
  let result: any;
  try {
    const ctx: ExecContext = {
      step: (name, detail, reused) => { emit(op.case_id, undefined, reused ? "operation.reconciled" : "operation.step", { operation_id: op.id, kind: name, detail, provider_id: detail }); evidence.add(op.case_id, "executor", `${name}: ${detail}${reused ? " (already done; not repeated)" : ""}`, op.id); },
      checkpoint: (name) => { if (interruptArmed) { interruptArmed = ""; evidence.add(op.case_id, "executor", `Run interrupted at checkpoint: ${name}`, op.id); throw new InterruptedError(`interrupted after ${name}`); } },
    };
    result = await spec.execute(params, op.idempotency_key, ctx);
    if (interruptArmed && (interruptArmed === "*" || interruptArmed === op.kind)) { interruptArmed = ""; evidence.add(op.case_id, "executor", `Run interrupted after ${op.kind} was submitted; result not yet recorded`, op.id); throw new InterruptedError(`interrupted after ${op.kind} submitted`); }
    if (faultArmed === `lose_response:${op.kind}`) { faultArmed = ""; throw Object.assign(new Error("simulated timeout: provider accepted the write but the response was lost"), { uncertain: true }); }
  } catch (e) {
    if (e instanceof InterruptedError) throw e;
    const uncertain = (e as any).uncertain || !(e instanceof HttpError) || (e as HttpError).status >= 500;
    setOp(op.id, { status: uncertain ? "uncertain" : "failed", error: (e as Error).message.slice(0, 1000) });
    evidence.add(op.case_id, "executor", `${op.kind} ${uncertain ? "outcome UNCERTAIN" : "failed"}: ${(e as Error).message.slice(0, 300)}`, op.id);
    return { status: uncertain ? "uncertain" : "failed", operation_id: op.id, error: (e as Error).message.slice(0, 500), guidance: uncertain ? "Call execute_action again with the same operation_id; the executor will reconcile before any retry." : "Fix the parameters or choose a different action." };
  }
  return finish(op, params, result);
}

async function finish(op: OpRow, params: Params, result: any, note?: string) {
  const v = await ACTIONS[op.kind].verify(params, result).catch((e) => ({ ok: false, observed: `verification error: ${e.message}` }));
  setOp(op.id, { status: v.ok ? "succeeded" : "failed", result: JSON.stringify(result).slice(0, 4000), verification: v.observed, error: v.ok ? null : "verification failed" });
  emit(op.case_id, undefined, "operation.verified", { operation_id: op.id, kind: op.kind, params, ok: v.ok, observed: v.observed, note, amount: op.amount });
  evidence.add(op.case_id, "executor", `${op.kind} ${v.ok ? "VERIFIED" : "NOT VERIFIED"}: ${v.observed}${note ? ` (${note})` : ""}`, op.id);
  return { status: v.ok ? "succeeded" : "verification_failed", operation_id: op.id, verified_state: v.observed, provider_id: result?.id ?? result?.Id ?? result?.key ?? result?.ts, note };
}

export async function propose(caseId: string, kind: string, params: Params, justification: string) {
  const spec = ACTIONS[kind];
  if (params && typeof params.params === "object") params = { ...params, ...params.params };
  if (!spec) return { status: "rejected", error: `unknown action ${kind}`, available: Object.keys(ACTIONS) };
  const idempotencyKey = `peeblo-${hash({ caseId, kind, identity: spec.identity ? spec.identity(params) : params })}`;
  const existing = db.prepare("SELECT * FROM operations WHERE idempotency_key = ?").get(idempotencyKey) as OpRow | undefined;
  if (existing) {
    if (["succeeded"].includes(existing.status)) return { status: "already_done", operation_id: existing.id, verified_state: existing.verification };
    if (existing.status === "awaiting_approval") return { status: "awaiting_approval", operation_id: existing.id, note: "Approval already requested; schedule a follow-up instead of re-requesting." };
    if (["uncertain", "submitted", "approved"].includes(existing.status)) return run(existing);
    if (existing.status === "rejected") return { status: "rejected_by_approver", operation_id: existing.id };
  }
  const amount = spec.amount?.(params);
  const authority = spec.authority(params);
  const opId = existing?.id ?? id("op");
  if (!existing) db.prepare("INSERT INTO operations (id,case_id,kind,params,idempotency_key,amount,authority,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(opId, caseId, kind, JSON.stringify(params), idempotencyKey, amount ?? null, authority, "proposed", now(), now());
  if (authority === "autonomous") return run(getOp(opId)!);
  return requestApproval(getOp(opId)!, justification);
}

export async function retry(operationId: string) {
  const op = getOp(operationId);
  if (!op) return { status: "rejected", error: "unknown operation" };
  if (op.status === "succeeded") return { status: "already_done", verified_state: op.verification };
  if (!["uncertain", "submitted", "approved", "failed"].includes(op.status)) return { status: op.status };
  return run(op);
}

async function requestApproval(op: OpRow, justification: string) {
  const approvalId = id("apr");
  const fingerprint = hash({ kind: op.kind, params: op.params, amount: op.amount });
  const approverRole = op.authority === "cfo" ? "CFO (Sam Rivera)" : "AR approver";
  const expires = new Date(Date.now() + 48 * 3600_000).toISOString();
  const text = `*Approval needed* (${approverRole}) · case \`${op.case_id}\`\n*Action:* \`${op.kind}\`${op.amount != null ? ` · *Amount:* $${op.amount.toLocaleString("en-US", { minimumFractionDigits: 2 })}` : ""}\n*Exact change:* \`\`\`${JSON.stringify(JSON.parse(op.params), null, 1).slice(0, 2500)}\`\`\`\n*Why:* ${justification}\n_Approval covers exactly this change and expires ${expires.slice(0, 16)}Z._`;
  const msg = await slack.call("chat.postMessage", { channel: env.SLACK_APPROVALS_CHANNEL_ID, text, blocks: [
    { type: "section", text: { type: "mrkdwn", text: text.slice(0, 2900) } },
    ...(op.authority === "cfo" ? [] : [{ type: "actions", elements: [
      { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" }, action_id: "peeblo_approve", value: approvalId },
      { type: "button", style: "danger", text: { type: "plain_text", text: "Reject" }, action_id: "peeblo_reject", value: approvalId },
    ] }]),
  ] });
  db.prepare("INSERT INTO approvals VALUES (?,?,?,?,?,NULL,?,?,NULL,?)").run(approvalId, op.case_id, op.id, fingerprint, "pending", msg.ts, expires, now());
  setOp(op.id, { status: "awaiting_approval", approval_id: approvalId });
  emit(op.case_id, undefined, "approval.requested", { approval_id: approvalId, operation_id: op.id, kind: op.kind, params: JSON.parse(op.params), amount: op.amount, approver: approverRole, justification, slack_ts: msg.ts });
  evidence.add(op.case_id, "executor", `Approval requested from ${approverRole} for ${op.kind}${op.amount != null ? ` $${op.amount}` : ""}`, approvalId);
  return { status: "awaiting_approval", operation_id: op.id, approval_id: approvalId, approver: approverRole, note: op.authority === "cfo" ? "CFO approval happens outside Slack; escalate and wait." : "Schedule a wake-up; you will be resumed when the approver decides." };
}

// Called from the Slack interaction handler. Only listed approvers count; the approval binds to the fingerprint.
export async function decide(approvalId: string, userId: string, decision: "approved" | "rejected") {
  const apr = db.prepare("SELECT * FROM approvals WHERE id = ?").get(approvalId) as any;
  if (!apr || apr.status !== "pending") return { ok: false, message: "This approval is no longer pending." };
  const approvers = (env.SLACK_APPROVER_USER_IDS ?? "").split(",").map((s) => s.trim());
  if (!approvers.includes(userId)) return { ok: false, message: "You are not an authorized AR approver." };
  const op = getOp(apr.operation_id)!;
  if (apr.expires_at < now()) { db.prepare("UPDATE approvals SET status='expired' WHERE id=?").run(approvalId); return { ok: false, message: "Approval expired; Peeblo will re-request with current records." }; }
  if (hash({ kind: op.kind, params: op.params, amount: op.amount }) !== apr.fingerprint) return { ok: false, message: "The proposed change was modified; approval invalid." };
  db.prepare("UPDATE approvals SET status=?, approver=?, decided_at=? WHERE id=?").run(decision, userId, now(), approvalId);
  evidence.add(op.case_id, "slack", `${op.kind} ${decision} by <@${userId}>`, approvalId);
  if (decision === "rejected") { setOp(op.id, { status: "rejected" }); wakeups.schedule(op.case_id, now(), `Approver rejected ${op.kind}`); return { ok: true, message: "Rejected. Peeblo will reassess the case." }; }
  setOp(op.id, { status: "approved" });
  let result: any;
  try { result = await run(getOp(op.id)!); }
  catch (e) {
    if (!(e instanceof InterruptedError)) throw e;
    emit(op.case_id, undefined, "run.finished", { status: "interrupted", reason: e.message });
    return { ok: true, message: `Approved. Execution was interrupted (${e.message}); Peeblo will resume from the recorded operation.` };
  }
  wakeups.schedule(op.case_id, now(), `Approved ${op.kind} executed: ${result.status}`);
  return { ok: true, message: `Approved and executed: ${result.status}${result.verified_state ? ` — ${result.verified_state}` : ""}` };
}

export const operations = {
  list: (caseId: string) => db.prepare("SELECT id, kind, params, amount, authority, status, verification, error FROM operations WHERE case_id = ? ORDER BY created_at").all(caseId),
};
