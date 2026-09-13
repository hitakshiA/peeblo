// Eastbridge wrong-bill-to-entity scenario. Idempotent: run it to set up or to reset between takes.
//   node seed/scenarios/eastbridge.ts
// Starting state: a $24,000 quarterly invoice (INV-2310) for Eastbridge Logistics' contract is addressed to its
// affiliate Eastbridge Holdings, is overdue, and was rejected by Logistics AP. Dropbox holds billing instructions in
// two versions (2025: bill Holdings; 2026 executed: bill Logistics). No payment or credit exists.
import { stripe, qbo, hubspot, jira, slack, dropbox, env } from "../../agent/src/connectors.ts";
import { request } from "../lib/http.ts";
import { renderPdf } from "../lib/pdf.ts";
import { Manifest } from "../lib/manifest.ts";

const REF = "INV-2310";
const AMOUNT = 24000;
const LINE = "Miny Platform Seats, Q3 2026 quarterly installment (80 seats, Eastbridge Logistics fleet rollout)";
const st = new Manifest("stripe"), qb = new Manifest("qbo"), hs = new Manifest("hubspot"), jr = new Manifest("jira"), sc = new Manifest("scenario_eastbridge");
const log = (...m: unknown[]) => console.log("[eastbridge]", ...m);
const HOLDINGS_STRIPE = st.get("customer", "eastbridge_holdings")!;
const HOLDINGS_QBO = qb.get("customer", "eastbridge_holdings")!;
const LOGISTICS_HS = hs.get("companies", "eastbridge_logistics")!;
const PRIYA_HS = hs.get("contacts", "eb_l_ap");

async function resetStripe() {
  // Archive every earlier Eastbridge document (seeded originals and agent-created replacements) so each take starts clean.
  const customers = [HOLDINGS_STRIPE, ...(await stripe.call(`/customers/search?query=${encodeURIComponent("name~'Eastbridge Logistics'")}`)).data.map((c: any) => c.id)];
  for (const cust of customers) {
    for (const inv of (await stripe.call(`/invoices?customer=${cust}&limit=100`)).data) {
      const ref = inv.metadata?.invoice_number ?? "";
      if (!["INV-2381", "INV-2355", REF].includes(ref) && !inv.metadata?.replaces && cust === HOLDINGS_STRIPE) continue;
      if (inv.status === "draft") { await stripe.call(`/invoices/${inv.id}`, { method: "DELETE" }); continue; }
      if (inv.status === "open" || inv.status === "uncollectible") await stripe.call(`/invoices/${inv.id}/void`, { form: {} });
      await stripe.call(`/invoices/${inv.id}`, { form: { "metadata[invoice_number]": `archived-${ref}-${Date.now()}`, "metadata[archived]": "scenario reset" } });
    }
    if (cust !== HOLDINGS_STRIPE) await stripe.call(`/customers/${cust}`, { method: "DELETE" });
  }
  const inv = await stripe.call("/invoices", { form: { customer: HOLDINGS_STRIPE, collection_method: "send_invoice", days_until_due: "1", effective_at: String(Date.parse("2026-08-01T12:00:00Z") / 1000), auto_advance: "false", pending_invoice_items_behavior: "exclude", description: "Order Form EBL-2026-01, Q3 2026", "metadata[invoice_number]": REF, "metadata[contract_key]": "c_eb_logistics_2026", "custom_fields[0][name]": "Invoice ref", "custom_fields[0][value]": REF, "custom_fields[1][name]": "Terms", "custom_fields[1][value]": "Net 30, due 2026-08-31" } });
  await stripe.call("/invoiceitems", { form: { customer: HOLDINGS_STRIPE, invoice: inv.id, description: LINE, quantity: "80", unit_amount_decimal: "30000", currency: "usd" } });
  const fin = await stripe.call(`/invoices/${inv.id}/finalize`, { form: { auto_advance: "false" } });
  log("stripe", fin.id, fin.status, `$${fin.amount_due / 100}`, "due", new Date(fin.due_date * 1000).toISOString().slice(0, 10));
}

async function resetQbo() {
  const voidAndRename = async (i: any, tag: string) => {
    if (i.TotalAmt !== 0) await qbo.post("Invoice", { Id: i.Id, SyncToken: i.SyncToken }, "&operation=void");
    const fresh = await qbo.get("Invoice", i.Id);
    await qbo.post("Invoice", { Id: fresh.Id, SyncToken: fresh.SyncToken, sparse: true, DocNumber: `X${Date.now() % 100000}-${tag}`.slice(0, 21), CustomerRef: fresh.CustomerRef, Line: fresh.Line });
  };
  for (const docId of [qb.get("invoice", "i_2381"), qb.get("invoice", "i_2355")].filter(Boolean) as string[]) {
    const i = await qbo.get("Invoice", docId).catch(() => undefined);
    if (i && !String(i.DocNumber).startsWith("X")) await voidAndRename(i, i.DocNumber);
  }
  const pay = qb.get("payment", "p_ebh_0910");
  if (pay) { const p = await qbo.get("Payment", pay).catch(() => undefined); if (p) await qbo.post("Payment", { Id: p.Id, SyncToken: p.SyncToken }, "&operation=delete"); qb.delete("payment", "p_ebh_0910"); }
  for (const i of (await qbo.query(`select * from Invoice where DocNumber LIKE '${REF}%'`)).Invoice ?? []) await voidAndRename(i, REF);
  for (const cm of ((await qbo.query("select * from CreditMemo MAXRESULTS 200")).CreditMemo ?? []).filter((c: any) => String(c.PrivateNote ?? "").startsWith("peeblo_op="))) await qbo.post("CreditMemo", { Id: cm.Id, SyncToken: cm.SyncToken }, "&operation=delete").catch(() => {});
  const inv = await qbo.post("Invoice", { DocNumber: REF, TxnDate: "2026-08-01", DueDate: "2026-08-31", CustomerRef: { value: HOLDINGS_QBO }, PrivateNote: `billed in Stripe as ${REF}; contract=c_eb_logistics_2026`, CustomerMemo: { value: "Order Form EBL-2026-01, Q3 2026" }, Line: [{ Amount: AMOUNT, DetailType: "SalesItemLineDetail", Description: LINE, SalesItemLineDetail: { ItemRef: { value: qb.get("item", "seat_annual") }, Qty: 80, UnitPrice: 300 } }] });
  log("qbo", inv.Id, inv.DocNumber, `$${inv.Balance}`, "customer", inv.CustomerRef.name);
}

async function resetHubspot() {
  for (const kind of ["emails", "notes"]) {
    const assoc = await hubspot.call(`/crm/v4/objects/companies/${LOGISTICS_HS}/associations/${kind}`);
    for (const r of assoc.results) {
      const obj = await hubspot.call(`/crm/v3/objects/${kind}/${r.toObjectId}?properties=hs_email_subject,hs_note_body,hs_email_headers`);
      const text = `${obj.properties.hs_email_subject ?? ""} ${obj.properties.hs_note_body ?? ""} ${obj.properties.hs_email_headers ?? ""}`;
      if (/\[Peeblo\]|INV-2381|INV-2310|ar@minylabs\.com"\}, "to"/.test(text) || text.includes('"from":{"email":"ar@minylabs.com"}')) await hubspot.call(`/crm/v3/objects/${kind}/${r.toObjectId}`, undefined, "DELETE");
    }
  }
  const email = await hubspot.call("/crm/v3/objects/emails", {
    properties: { hs_timestamp: "2026-09-11T15:42:00Z", hs_email_direction: "INCOMING_EMAIL", hs_email_status: "SENT", hs_email_subject: `RE: Invoice ${REF} from Miny Labs, REJECTED (bill-to entity)`, hs_email_headers: JSON.stringify({ from: { email: "priya.natarajan@eastbridgelogistics.com" }, to: [{ email: "ar@minylabs.com" }] }),
      hs_email_text: `Hello,\n\nWe are returning invoice ${REF} ($24,000.00) unpaid. It is addressed to Eastbridge Holdings, Inc., our parent company. Our order form EBL-2026-01 and supplier record EBL-SUP-10442 are with Eastbridge Logistics LLC (EIN 84-2917365). Our AP system cannot match an invoice addressed to a different legal entity, so it will stay unpaid until it is corrected.\n\nPlease send a corrected invoice addressed to Eastbridge Logistics LLC. The billing instructions we signed in August are in your shared folder.\n\nThanks,\nPriya Natarajan\nAccounts Payable Lead, Eastbridge Logistics LLC` },
    associations: [{ to: { id: LOGISTICS_HS }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 186 }] }, ...(PRIYA_HS ? [{ to: { id: PRIYA_HS }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 198 }] }] : [])],
  });
  log("hubspot rejection email", email.id);
}

async function setupDropbox() {
  if (sc.get("dropbox", "order_form")) return;
  const token = (await request("https://api.dropboxapi.com/oauth2/token", { form: { grant_type: "refresh_token", refresh_token: env.DROPBOX_REFRESH_TOKEN }, headers: { Authorization: "Basic " + Buffer.from(`${env.DROPBOX_APP_KEY}:${env.DROPBOX_APP_SECRET}`).toString("base64") } })).access_token;
  const upload = async (path: string, title: string, body: string[]) => (await request("https://content.dropboxapi.com/2/files/upload", { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream", "Dropbox-API-Arg": JSON.stringify({ path, mode: "overwrite", mute: true }) }, body: renderPdf(title, body) })).rev;
  const path = "/Customers/Eastbridge Logistics/AP/Eastbridge Billing Instructions.pdf";
  if (!sc.get("dropbox", "billing_instructions_v2")) sc.set("dropbox", "billing_instructions_v1", await upload(path, "Eastbridge Billing Instructions", ["Document date: 2025-09-02", "EASTBRIDGE GROUP: SUPPLIER BILLING INSTRUCTIONS (v1)", "Applies to: Miny Labs, Inc. subscriptions for Eastbridge Holdings, Inc. and its affiliates.", "Bill-to entity: Eastbridge Holdings, Inc., 150 N Riverside Plaza, Chicago, IL 60606 (EIN 36-4418207).", "Invoices to ap@eastbridge.com. Affiliates are billed centrally through Eastbridge Holdings.", "Signed: Renata Voss, CFO, Eastbridge Holdings, Inc., 09/02/2025"]));
  if (!sc.get("dropbox", "billing_instructions_v2")) sc.set("dropbox", "billing_instructions_v2", await upload(path, "Eastbridge Billing Instructions", ["Document date: 2026-08-14 (executed version, supersedes the 2025-09-02 instructions)", "EASTBRIDGE LOGISTICS LLC: SUPPLIER BILLING INSTRUCTIONS (v2)", "Effective August 14, 2026, Eastbridge Logistics LLC is invoiced directly and no longer billed through Eastbridge Holdings, Inc.", "Bill-to entity: Eastbridge Logistics LLC, 2200 Channahon Rd, Joliet, IL 60436 (EIN 84-2917365). Supplier ID EBL-SUP-10442.", "Scope: Order Form EBL-2026-01 (80 platform seats). Billing: quarterly in advance, $24,000.00 per quarter, Net 30.", "Invoices to priya.natarajan@eastbridgelogistics.com. Invoices addressed to Eastbridge Holdings, Inc. will be rejected.", "Eastbridge Holdings, Inc. remains the bill-to entity only for its own Order Form EBH-2025-01.", "Signed: Daniel Osei, COO, Eastbridge Logistics LLC, 08/14/2026", "Acknowledged: Renata Voss, CFO, Eastbridge Holdings, Inc., 08/14/2026"]));
  log("dropbox billing instructions v1 + v2 uploaded");
  // The original seeded order form said annual billing; replace it with the executed quarterly version.
  const oldForm = "/Customers/Eastbridge Logistics/Contracts/Order Form EBL-2026-01 (signed).pdf";
  await request("https://api.dropboxapi.com/2/files/delete_v2", { headers: { Authorization: `Bearer ${token}` }, json: { path: oldForm } }).catch(() => {});
  sc.set("dropbox", "order_form", await upload("/Customers/Eastbridge Logistics/Contracts/Order Form EBL-2026-01 (executed).pdf", "Order Form EBL-2026-01 (executed)", ["Document date: 2026-08-14", "Order Form EBL-2026-01", "Between Miny Labs, Inc. and Eastbridge Logistics LLC, 2200 Channahon Rd, Joliet, IL 60436 (EIN 84-2917365) (\"Customer\").", "Effective date: 2026-08-01. Term: 12 months.", "Fees: Miny Platform Seat (annual), 80 x $1,200.00 = $96,000.00 per year.", "Billing: quarterly in advance, $24,000.00 per quarter. Payment terms: Net 30.", "Invoices must be addressed to the Customer legal entity named above. Invoices addressed to any other entity, including affiliates, will be rejected by Customer's accounts payable.", "Governed by the Master Subscription Agreement between Miny Labs, Inc. and Eastbridge Holdings, Inc. dated September 1, 2025, which affiliates may use by signing their own Order Form.", "Signed for Customer: Daniel Osei, Chief Operating Officer, Eastbridge Logistics LLC.", "Signed for Miny Labs: Hitakshi Arora, Head of Finance, Miny Labs, Inc."]));
}

async function resetJira() {
  const key = jr.get("issue", "j_eb_exception") ?? await (async () => {
    const created = await jira.call("/issue", { fields: { project: { key: env.JIRA_PROJECT_KEY }, issuetype: { name: "Task" }, labels: ["billing-exception", "ar"], summary: `Billing exception: Eastbridge ${REF} rejected by AP`, description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: `Eastbridge Logistics AP returned ${REF} ($24,000) unpaid on 2026-09-11, citing the bill-to entity. Owner: AR (Peeblo). Opened from the AR exceptions queue.` }] }] } } });
    jr.set("issue", "j_eb_exception", created.key);
    return created.key as string;
  })();
  const { comments } = await jira.call(`/issue/${key}/comment`);
  for (const c of comments) if (JSON.stringify(c.body).includes("[Peeblo]")) await jira.call(`/issue/${key}/comment/${c.id}`, undefined, "DELETE");
  const { transitions } = await jira.call(`/issue/${key}/transitions`);
  const todo = transitions.find((t: any) => t.to.name === "To Do");
  const issue = await jira.call(`/issue/${key}?fields=status`);
  if (todo && issue.fields.status.name !== "To Do") await jira.call(`/issue/${key}/transitions`, { transition: { id: todo.id } });
  log("jira exception", key);
}

async function resetSlack() {
  const since = sc.get("slack", "setup_ts") ?? String(Date.now() / 1000);
  for (const channel of [env.SLACK_ASSIGNMENTS_CHANNEL_ID, env.SLACK_APPROVALS_CHANNEL_ID]) {
    const { messages } = await slack.call("conversations.history", { channel, oldest: since, limit: 200 });
    for (const m of messages) if (m.bot_id) await slack.call("chat.delete", { channel, ts: m.ts }).catch(() => {});
  }
  sc.set("slack", "setup_ts", String(Date.now() / 1000));
  log("slack cleared bot messages since last setup");
}

await setupDropbox();
await Promise.all([resetStripe(), resetQbo(), resetHubspot(), resetJira(), resetSlack()]);
log("ready");
