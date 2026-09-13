// Minimal seeder for every app except Stripe (see stripe.ts). Seeds the full world with only
// the fields the agent needs. Idempotent via manifests. Usage: node seed/apps/lite.ts [app ...]
import { loadEnv, updateEnv } from "../lib/env.ts";
import { request } from "../lib/http.ts";
import { Manifest } from "../lib/manifest.ts";
import { renderPdf } from "../lib/pdf.ts";
import { ACCOUNTS, CONTACTS, CONTRACTS, OPPORTUNITIES, INVOICES, PAYMENTS, PRODUCTS, lineTotal } from "../world/world.ts";
import { DOCUMENTS, COMMUNICATIONS, JIRA_ISSUES } from "../world/content.ts";
import { POLICIES } from "../world/policies.ts";

const env = loadEnv();
const acct = (k: string) => ACCOUNTS.find((a) => a.key === k)!;
const inCrm = (crm: string, target: "salesforce" | "hubspot") => crm === target || crm === "both";
const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
const log = (app: string, ...m: unknown[]) => console.log(`[${app}]`, ...m);

// ------------------------------------------------------------------ QuickBooks
async function qbo() {
  const m = new Manifest("qbo");
  const tok = await request("https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", {
    form: { grant_type: "refresh_token", refresh_token: env.QUICKBOOKS_REFRESH_TOKEN },
    headers: { Authorization: "Basic " + Buffer.from(`${env.QUICKBOOKS_CLIENT_ID}:${env.QUICKBOOKS_CLIENT_SECRET}`).toString("base64") },
  });
  updateEnv("QUICKBOOKS_REFRESH_TOKEN", tok.refresh_token);
  const base = `https://sandbox-quickbooks.api.intuit.com/v3/company/${env.QUICKBOOKS_REALM_ID}`;
  const H = { Authorization: `Bearer ${tok.access_token}` };
  const q = async (sql: string) => (await request(`${base}/query?minorversion=75&query=${encodeURIComponent(sql)}`, { headers: H })).QueryResponse;
  const post = async (entity: string, body: unknown) => (await request(`${base}/${entity.toLowerCase()}?minorversion=75`, { headers: H, json: body }))[entity];
  const esc = (s: string) => s.replace(/'/g, "\\'");

  for (const name of new Set(PRODUCTS.map((p) => p.qboIncomeAccount))) {
    await m.ensure("account", name, async () => (await q(`select Id from Account where Name = '${esc(name)}'`)).Account?.[0]?.Id
      ?? (await post("Account", { Name: name, AccountType: "Income", AccountSubType: "ServiceFeeIncome" })).Id);
  }
  for (const p of PRODUCTS) {
    await m.ensure("item", p.key, async () => (await q(`select Id from Item where Name = '${esc(p.name)}'`)).Item?.[0]?.Id
      ?? (await post("Item", { Name: p.name, Sku: p.sku, Type: "Service", UnitPrice: p.unitAmount, IncomeAccountRef: { value: m.get("account", p.qboIncomeAccount) } })).Id);
  }
  const customers = [...ACCOUNTS.filter((a) => a.qbo).map((a) => ({ key: a.key, name: a.name, company: a.legalName, email: CONTACTS.find((c) => c.accountKey === a.key && ["billing", "ap"].includes(c.role))?.email, notes: `peeblo_key=${a.key}${a.parentKey ? `; parent=${acct(a.parentKey).legalName}` : ""}${a.taxId ? `; EIN ${a.taxId}` : ""}` })),
    { key: "unidentified", name: "Unidentified Deposits", company: "Unidentified Deposits", email: undefined, notes: "Holding customer for cash that could not be matched" }];
  for (const batch of chunks(customers, 6)) {
    await Promise.all(batch.map((c) => m.ensure("customer", c.key, async () => (await q(`select Id from Customer where DisplayName = '${esc(c.name)}'`)).Customer?.[0]?.Id
      ?? (await post("Customer", { DisplayName: c.name, CompanyName: c.company, Notes: c.notes, ...(c.email ? { PrimaryEmailAddr: { Address: c.email } } : {}) })).Id)));
  }
  const qInvoices = INVOICES.filter((i) => i.qbo);
  for (const batch of chunks(qInvoices, 6)) {
    await Promise.all(batch.map((i) => m.ensure("invoice", i.key, async () => (await post("Invoice", {
      DocNumber: i.number, TxnDate: i.issueDate, DueDate: i.dueDate, CustomerRef: { value: m.get("customer", i.accountKey) },
      Line: i.lines.map((l) => ({ Amount: Math.round(l.quantity * l.unitAmount * 100) / 100, DetailType: "SalesItemLineDetail", Description: l.description ?? PRODUCTS.find((p) => p.key === l.productKey)!.name, SalesItemLineDetail: { ItemRef: { value: m.get("item", l.productKey) }, Qty: l.quantity, UnitPrice: l.unitAmount } })),
      PrivateNote: `peeblo_key=${i.key}${i.stripe ? `; billed in Stripe as ${i.number}` : ""}${i.contractKey ? `; contract=${i.contractKey}` : ""}`,
      ...(i.memo || i.poNumber ? { CustomerMemo: { value: [i.memo, i.poNumber && `PO ${i.poNumber}`].filter(Boolean).join(" — ") } } : {}),
    })).Id)));
  }
  // Settled invoices get an applied payment; case payments come from PAYMENTS.
  const payments = [
    ...qInvoices.filter((i) => i.qbo!.state === "paid").map((i) => ({ key: `auto_${i.key}`, customer: i.accountKey, amount: lineTotal(i.lines), date: i.stripe?.paidDate ?? i.dueDate, ref: `PAY ${i.number}`, note: "Payment received", apps: [{ invoiceKey: i.key, amount: lineTotal(i.lines) }] })),
    ...PAYMENTS.filter((p) => p.system === "qbo").map((p) => ({ key: p.key, customer: p.accountKey ?? "unidentified", amount: p.amount, date: p.date, ref: p.reference.slice(0, 21), note: `${p.payerName} | ${p.method} | ${p.reference} | peeblo_key=${p.key}`, apps: p.applications })),
  ];
  for (const batch of chunks(payments, 6)) {
    await Promise.all(batch.map((p) => m.ensure("payment", p.key, async () => (await post("Payment", {
      CustomerRef: { value: m.get("customer", p.customer) }, TotalAmt: p.amount, TxnDate: p.date, PaymentRefNum: p.ref, PrivateNote: p.note,
      Line: p.apps.map((a) => ({ Amount: a.amount, LinkedTxn: [{ TxnId: m.get("invoice", a.invoiceKey), TxnType: "Invoice" }] })),
    })).Id)));
  }
  log("qbo", "customers", Object.keys(m.all("customer")).length, "invoices", Object.keys(m.all("invoice")).length, "payments", Object.keys(m.all("payment")).length);
}

// ------------------------------------------------------------------ Salesforce
async function salesforce() {
  const m = new Manifest("salesforce");
  const tok = await request(`${env.SALESFORCE_INSTANCE_URL}/services/oauth2/token`, { form: { grant_type: "client_credentials", client_id: env.SALESFORCE_CLIENT_ID, client_secret: env.SALESFORCE_CLIENT_SECRET } });
  const api = `${tok.instance_url}/services/data/v67.0`;
  const H = { Authorization: `Bearer ${tok.access_token}` };
  async function createAll(kind: string, items: { key: string; record: Record<string, unknown> }[]) {
    const todo = items.filter((x) => !m.get(kind, x.key));
    for (const batch of chunks(todo, 200)) {
      const res: { id?: string; success: boolean; errors: unknown[] }[] = await request(`${api}/composite/sobjects`, { headers: H, json: { allOrNone: false, records: batch.map((x) => ({ attributes: { type: kind }, ...x.record })) } });
      res.forEach((r, i) => r.success ? m.set(kind, batch[i].key, r.id!) : log("salesforce", kind, batch[i].key, JSON.stringify(r.errors)));
    }
  }
  const sfAccounts = ACCOUNTS.filter((a) => inCrm(a.crm, "salesforce"));
  await createAll("Account", sfAccounts.map((a) => ({ key: a.key, record: { Name: a.name, AccountNumber: a.key, Website: a.domain, Industry: a.industry, BillingCity: a.city, BillingCountryCode: "US", BillingStateCode: a.state, Description: `Legal entity: ${a.legalName}${a.taxId ? `; EIN ${a.taxId}` : ""}; payment terms ${a.paymentTerms}${a.poRequired ? "; PO required" : ""}${a.notes ? `; ${a.notes}` : ""}` } })));
  const withParent = sfAccounts.filter((a) => a.parentKey && m.get("Account", a.parentKey));
  if (withParent.length) await request(`${api}/composite/sobjects`, { method: "PATCH", headers: H, json: { allOrNone: false, records: withParent.map((a) => ({ attributes: { type: "Account" }, id: m.get("Account", a.key), ParentId: m.get("Account", a.parentKey!) })) } });
  await createAll("Contact", CONTACTS.filter((c) => inCrm(c.crm, "salesforce") && m.get("Account", c.accountKey)).map((c) => ({ key: c.key, record: { AccountId: m.get("Account", c.accountKey), FirstName: c.firstName, LastName: c.lastName, Email: c.email, Title: c.title, Description: `Role: ${c.role}; status: ${c.status}` } })));
  await createAll("Opportunity", OPPORTUNITIES.filter((o) => m.get("Account", o.accountKey)).map((o) => {
    const c = CONTRACTS.find((x) => x.key === o.contractKey);
    const terms = c ? `Contract ${c.title}; start ${c.startDate}; ${c.termMonths} months; ${c.billing}; ${c.paymentTerms}; lines: ${c.lines.map((l) => `${l.quantity}x ${l.productKey} @ $${l.unitAmount}`).join(", ")}${c.poRequired ? "; PO required" : ""}${c.upliftPct ? `; ${c.upliftPct}% renewal uplift` : ""}${c.overageCapMonthly ? `; overage cap $${c.overageCapMonthly}/mo` : ""}; signed by ${c.signedBy}` : "";
    return { key: o.key, record: { AccountId: m.get("Account", o.accountKey), Name: o.name, StageName: o.stage, Amount: o.amount, CloseDate: o.closeDate, Type: o.type, NextStep: o.nextStep, Description: terms.slice(0, 32000) } };
  }));
  log("salesforce", "accounts", Object.keys(m.all("Account")).length, "contacts", Object.keys(m.all("Contact")).length, "opps", Object.keys(m.all("Opportunity")).length);
}

// ------------------------------------------------------------------ HubSpot
async function hubspot() {
  const m = new Manifest("hubspot");
  const H = { Authorization: `Bearer ${env.HUBSPOT_ACCESS_TOKEN}` };
  const api = "https://api.hubapi.com/crm/v3/objects";
  const assoc = (id: string | undefined, typeId: number) => id ? [{ to: { id }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: typeId }] }] : [];
  async function createAll(kind: string, items: { key: string; input: Record<string, unknown> }[]) {
    for (const batch of chunks(items.filter((x) => !m.get(kind, x.key)), 100)) {
      const res = await request(`${api}/${kind}/batch/create`, { headers: H, json: { inputs: batch.map((x) => x.input) } });
      // Batch results are unordered, so match each result back on a unique property.
      res.results.forEach((r: any) => {
        const hit = batch.find((x) => (x.input.properties as any)[matchField(kind)] === r.properties[matchField(kind)]);
        if (hit) m.set(kind, hit.key, r.id);
      });
    }
  }
  const matchField = (kind: string) => ({ companies: "name", contacts: "email", deals: "dealname" } as Record<string, string>)[kind];
  const hsAccounts = ACCOUNTS.filter((a) => inCrm(a.crm, "hubspot"));
  await createAll("companies", hsAccounts.map((a) => ({ key: a.key, input: { properties: { name: a.renamedFrom ?? a.name, domain: a.domain, city: a.city, state: a.state, description: `Legal entity: ${a.legalName}${a.taxId ? `; EIN ${a.taxId}` : ""}; terms ${a.paymentTerms}; peeblo_key=${a.key}${a.notes ? `; ${a.notes}` : ""}` } } })));
  for (const a of hsAccounts.filter((x) => x.parentKey && m.get("companies", x.parentKey))) {
    await request(`https://api.hubapi.com/crm/v4/objects/companies/${m.get("companies", a.key)}/associations/companies/${m.get("companies", a.parentKey!)}`, { method: "PUT", headers: H, json: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 14 }] }).catch((e) => log("hubspot", "parent link", a.key, e.message));
  }
  await createAll("contacts", CONTACTS.filter((c) => inCrm(c.crm, "hubspot") && m.get("companies", c.accountKey)).map((c) => ({ key: c.key, input: { properties: { email: c.email, firstname: c.firstName, lastname: c.lastName, jobtitle: c.status === "left_company" ? `${c.title} (LEFT COMPANY)` : c.title }, associations: assoc(m.get("companies", c.accountKey), 279) } })));
  const stage: Record<string, string> = { "Closed Won": "closedwon", "Closed Lost": "closedlost", "Negotiation/Review": "contractsent", Prospecting: "appointmentscheduled" };
  await createAll("deals", OPPORTUNITIES.filter((o) => m.get("companies", o.accountKey)).map((o) => ({ key: o.key, input: { properties: { dealname: o.name, amount: String(o.amount), closedate: `${o.closeDate}T12:00:00Z`, dealstage: stage[o.stage], pipeline: "default" }, associations: assoc(m.get("companies", o.accountKey), 341) } })));
  for (const c of COMMUNICATIONS.filter((x) => x.channel !== "slack" && x.accountKey && m.get("companies", x.accountKey))) {
    const companyId = m.get("companies", c.accountKey!);
    const contactKey = CONTACTS.find((k) => k.email === c.from || k.email === c.to)?.key;
    await m.ensure("engagements", c.key, async () => {
      const text = `${c.direction === "inbound" ? "From" : "To"}: ${c.direction === "inbound" ? c.from : c.to}\nSubject: ${c.subject ?? ""}\n\n${c.body}`;
      if (c.channel === "hubspot_email") {
        try {
          return (await request(`${api}/emails`, { headers: H, json: { properties: { hs_timestamp: c.date, hs_email_direction: c.direction === "inbound" ? "INCOMING_EMAIL" : "EMAIL", hs_email_subject: c.subject, hs_email_text: c.body, hs_email_status: "SENT", hs_email_headers: JSON.stringify({ from: { email: c.from }, to: [{ email: c.to }] }) }, associations: [...assoc(companyId, 186), ...assoc(m.get("contacts", contactKey ?? ""), 198)] } })).id;
        } catch (e) { log("hubspot", "email fallback to note", c.key, (e as Error).message.slice(0, 120)); }
      }
      return (await request(`${api}/notes`, { headers: H, json: { properties: { hs_timestamp: c.date, hs_note_body: c.channel === "hubspot_email" ? `[Email] ${text}` : `${c.from}: ${c.body}` }, associations: assoc(companyId, 190) } })).id;
    });
  }
  log("hubspot", "companies", Object.keys(m.all("companies")).length, "contacts", Object.keys(m.all("contacts")).length, "deals", Object.keys(m.all("deals")).length, "engagements", Object.keys(m.all("engagements")).length);
}

// ------------------------------------------------------------------ Slack
async function slack() {
  const m = new Manifest("slack");
  const H = { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` };
  const call = async (method: string, body: Record<string, unknown>) => {
    const r = await request(`https://slack.com/api/${method}`, { headers: H, json: body });
    if (!r.ok) throw new Error(`${method}: ${r.error}`);
    return r;
  };
  await call("conversations.setPurpose", { channel: env.SLACK_ASSIGNMENTS_CHANNEL_ID, purpose: "Assign receivables and billing work to Peeblo" }).catch(() => {});
  await call("conversations.setPurpose", { channel: env.SLACK_APPROVALS_CHANNEL_ID, purpose: "Peeblo approval requests (credits, voids, reissues, customer emails)" }).catch(() => {});
  for (const c of COMMUNICATIONS.filter((x) => x.channel === "slack").sort((a, b) => a.date.localeCompare(b.date))) {
    await m.ensure("message", c.key, async () => (await call("chat.postMessage", { channel: c.slackChannel === "approvals" ? env.SLACK_APPROVALS_CHANNEL_ID : env.SLACK_ASSIGNMENTS_CHANNEL_ID, text: `*${c.from}* · ${c.date.slice(0, 16).replace("T", " ")} UTC\n${c.body}`, unfurl_links: false })).ts);
  }
  log("slack", "messages", Object.keys(m.all("message")).length);
}

// ------------------------------------------------------------------ Jira
async function jira() {
  const m = new Manifest("jira");
  const H = { Authorization: "Basic " + Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString("base64") };
  const adf = (text: string) => ({ type: "doc", version: 1, content: text.split("\n\n").map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] })) });
  const api = `${env.JIRA_BASE_URL}/rest/api/3`;
  for (const j of JIRA_ISSUES) {
    const issueKey = await m.ensure("issue", j.key, async () => {
      const footer = `${j.accountKey ? `Customer: ${acct(j.accountKey).name}. ` : ""}Created ${j.created}.`;
      return (await request(`${api}/issue`, { headers: H, json: { fields: { project: { key: env.JIRA_PROJECT_KEY }, summary: j.summary, issuetype: { name: j.type }, labels: j.labels, description: adf(`${j.description}\n\n${footer}`) } } })).key;
    });
    if (!m.get("comments", j.key)) {
      for (const c of j.comments ?? []) await request(`${api}/issue/${issueKey}/comment`, { headers: H, json: { body: adf(`${c.author} (${c.date}): ${c.body}`) } });
      m.set("comments", j.key, String(j.comments?.length ?? 0));
    }
    if (j.status !== "To Do" && !m.get("status", j.key)) {
      const { transitions } = await request(`${api}/issue/${issueKey}/transitions`, { headers: H });
      const t = transitions.find((x: any) => x.to.name.toLowerCase() === j.status.toLowerCase() || x.name.toLowerCase() === j.status.toLowerCase());
      if (t) await request(`${api}/issue/${issueKey}/transitions`, { headers: H, json: { transition: { id: t.id } } });
      else log("jira", "no transition to", j.status, "for", issueKey);
      m.set("status", j.key, j.status);
    }
  }
  log("jira", "issues", Object.values(m.all("issue")).join(", "));
}

// ------------------------------------------------------------------ Notion
async function notion() {
  const m = new Manifest("notion");
  const H = { Authorization: `Bearer ${env.NOTION_TOKEN}`, "Notion-Version": "2026-03-11" };
  const rt = (s: string) => s.match(/[\s\S]{1,1900}/g)!.map((content) => ({ type: "text", text: { content } }));
  const blocks = (md: string) => md.split("\n").filter((l) => l.trim()).map((l) => {
    if (l.startsWith("## ")) return { type: "heading_2", heading_2: { rich_text: rt(l.slice(3)) } };
    if (l.startsWith("# ")) return { type: "heading_1", heading_1: { rich_text: rt(l.slice(2)) } };
    if (/^\s*[-*] /.test(l)) return { type: "bulleted_list_item", bulleted_list_item: { rich_text: rt(l.replace(/^\s*[-*] /, "")) } };
    if (/^\s*\d+\. /.test(l)) return { type: "numbered_list_item", numbered_list_item: { rich_text: rt(l.replace(/^\s*\d+\. /, "")) } };
    return { type: "paragraph", paragraph: { rich_text: rt(l) } };
  });
  for (const p of POLICIES) {
    await m.ensure("page", p.key, async () => (await request("https://api.notion.com/v1/pages", { headers: H, json: { parent: { page_id: env.NOTION_POLICY_ROOT_PAGE_ID }, properties: { title: { title: rt(p.title) } }, children: blocks(p.markdown).slice(0, 100) } })).id);
  }
  log("notion", "pages", Object.keys(m.all("page")).length);
}

// ------------------------------------------------------------------ Dropbox
async function dropbox() {
  const m = new Manifest("dropbox");
  const tok = await request("https://api.dropboxapi.com/oauth2/token", { form: { grant_type: "refresh_token", refresh_token: env.DROPBOX_REFRESH_TOKEN }, headers: { Authorization: "Basic " + Buffer.from(`${env.DROPBOX_APP_KEY}:${env.DROPBOX_APP_SECRET}`).toString("base64") } });
  // Dropbox-API-Arg must be ASCII; escape everything else.
  const arg = (o: unknown) => JSON.stringify(o).replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  const upload = (path: string, bytes: Uint8Array) => request("https://content.dropboxapi.com/2/files/upload", { headers: { Authorization: `Bearer ${tok.access_token}`, "Content-Type": "application/octet-stream", "Dropbox-API-Arg": arg({ path, mode: "overwrite", autorename: false, mute: true }) }, body: bytes });
  for (const d of DOCUMENTS) {
    for (const [i, v] of d.versions.entries()) {
      await m.ensure("version", `${d.key}#${i}`, async () => (await upload(d.path, renderPdf(d.title, [`Document date: ${v.date}${v.note ? ` — ${v.note}` : ""}`, ...v.body]))).rev);
    }
  }
  await m.ensure("file", "readme", async () => (await upload("/README - Finance Shared Drive.txt", new TextEncoder().encode("Miny Labs finance shared drive.\n/Customers/<Account>/Contracts, Purchase Orders, Tax, AP, Correspondence, Statements\n/Finance/Remittances, Usage, SLA Reports, Reports\nExecuted documents are authoritative; later file versions supersede earlier ones.\n"))).rev);
  log("dropbox", "versions", Object.keys(m.all("version")).length);
}

const APPS: Record<string, () => Promise<void>> = { qbo, salesforce, hubspot, slack, jira, notion, dropbox };
const selected = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(APPS);
const results = await Promise.allSettled(selected.map((a) => APPS[a]()));
results.forEach((r, i) => r.status === "rejected" && console.error(`[${selected[i]}] FAILED:`, (r.reason as Error).message));
process.exitCode = results.some((r) => r.status === "rejected") ? 1 : 0;
