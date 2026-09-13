import { createTool } from "@cline/sdk";
import { z } from "zod";
import { stripe, qbo, salesforce, hubspot, notion, jira, dropbox, slack, env, pdfText } from "./connectors.ts";
import { cases, evidence, wakeups, lessons, now } from "./store.ts";
import { ACTIONS, propose, retry, InterruptedError } from "./executor.ts";

// Reusable capabilities, not case scripts. Reads return compact facts with provider IDs so the model
// can cite evidence; every write goes through the executor.

const safe = <T>(fn: () => Promise<T>) => fn().catch((e: Error) => ({ error: e.message.slice(0, 400) }));
const usd = (cents: number) => Math.round(cents) / 100;
const q = (s: string) => s.replace(/'/g, "\\'");
const todayMs = () => Date.parse(now().slice(0, 10));
const daysPastDue = (due: string) => Math.floor((todayMs() - Date.parse(due)) / 86_400_000);

const stripeInvoice = (i: any) => ({
  stripe_invoice_id: i.id, invoice_ref: i.metadata?.invoice_number ?? i.number, status: i.status, customer_id: i.customer, customer_name: i.customer_name,
  total_usd: usd(i.total), amount_remaining_usd: usd(i.amount_remaining), due_date: i.due_date ? new Date(i.due_date * 1000).toISOString().slice(0, 10) : null,
  custom_fields: i.custom_fields, attempt_count: i.attempt_count, next_payment_attempt: i.next_payment_attempt ? new Date(i.next_payment_attempt * 1000).toISOString() : null,
  last_payment_error: i.last_finalization_error?.message ?? undefined, subscription: i.parent?.subscription_details?.subscription ?? i.subscription ?? undefined,
  lines: i.lines?.data?.map((l: any) => ({ description: l.description, quantity: l.quantity, amount_usd: usd(l.amount) })),
});
const qboInvoice = (i: any) => ({ qbo_invoice_id: i.Id, doc_number: i.DocNumber, customer: i.CustomerRef?.name, qbo_customer_id: i.CustomerRef?.value, txn_date: i.TxnDate, due_date: i.DueDate, total_usd: i.TotalAmt, balance_usd: i.Balance, days_past_due: i.Balance > 0 ? daysPastDue(i.DueDate) : 0, private_note: i.PrivateNote, memo: i.CustomerMemo?.value, lines: i.Line?.filter((l: any) => l.DetailType === "SalesItemLineDetail").map((l: any) => ({ description: l.Description, qty: l.SalesItemLineDetail.Qty, unit_price: l.SalesItemLineDetail.UnitPrice, item_id: l.SalesItemLineDetail.ItemRef.value })) });
const qboPayment = (p: any) => ({ qbo_payment_id: p.Id, customer: p.CustomerRef?.name, qbo_customer_id: p.CustomerRef?.value, date: p.TxnDate, total_usd: p.TotalAmt, unapplied_usd: p.UnappliedAmt, reference: p.PaymentRefNum, note: p.PrivateNote, applied_to: (p.Line ?? []).flatMap((l: any) => l.LinkedTxn.map((t: any) => ({ qbo_invoice_id: t.TxnId, amount_usd: l.Amount }))) });

export function buildTools(caseId: string, hooks: { interrupt: (reason: string) => void } = { interrupt: () => {} }) {
  const guarded = async <T>(fn: () => Promise<T>) => {
    try { return await fn(); } catch (e) { if (e instanceof InterruptedError) { hooks.interrupt(e.message); return { status: "interrupted", note: e.message }; } throw e; }
  };
  return [
    createTool({
      name: "find_customer",
      description: "Search every system (Stripe, QuickBooks, Salesforce, HubSpot) for customers matching a name, domain, or email fragment. Returns candidates with provider IDs, legal names, domains, parents and tax IDs. Names are only a starting point: confirm identity with legal entity, EIN, domain, contract or remittance evidence.",
      inputSchema: z.object({ query: z.string().describe("Name, domain or email fragment, e.g. 'Eastbridge' or 'ridgeview'") }),
      execute: async ({ query }) => {
        const [st, qb, sf, hs] = await Promise.all([
          safe(async () => (await stripe.call(`/customers/search?query=${encodeURIComponent(`name~'${q(query)}' OR email~'${q(query)}'`)}`)).data.map((c: any) => ({ stripe_customer_id: c.id, name: c.name, email: c.email, legal_name: c.metadata?.legal_name, tax_id: c.metadata?.tax_id }))),
          safe(async () => ((await qbo.query(`select Id, DisplayName, CompanyName, PrimaryEmailAddr, Notes, Balance from Customer where DisplayName LIKE '%${q(query)}%'`)).Customer ?? []).map((c: any) => ({ qbo_customer_id: c.Id, display_name: c.DisplayName, company_name: c.CompanyName, email: c.PrimaryEmailAddr?.Address, notes: c.Notes, open_balance_usd: c.Balance }))),
          safe(async () => (await salesforce.query(`SELECT Id, Name, Website, Description, Parent.Name, (SELECT Name, Email, Title, Description FROM Contacts) FROM Account WHERE Name LIKE '%${q(query)}%' OR Website LIKE '%${q(query)}%' LIMIT 10`)).map((a: any) => ({ salesforce_account_id: a.Id, name: a.Name, website: a.Website, parent: a.Parent?.Name, description: a.Description, contacts: a.Contacts?.records?.map((c: any) => `${c.Name} <${c.Email}> ${c.Title} (${c.Description})`) }))),
          safe(async () => (await hubspot.call("/crm/v3/objects/companies/search", { query, limit: 10, properties: ["name", "domain", "description", "city", "state"] })).results.map((c: any) => ({ hubspot_company_id: c.id, name: c.properties.name, domain: c.properties.domain, description: c.properties.description }))),
        ]);
        return { stripe: st, quickbooks: qb, salesforce: sf, hubspot: hs };
      },
    }),
    createTool({
      name: "get_billing_state",
      description: "Current billing and ledger state for a customer: Stripe invoices/subscriptions and QuickBooks invoices, payments and credit memos. Always call before acting on money.",
      inputSchema: z.object({ stripe_customer_id: z.string().optional(), qbo_customer_id: z.string().optional() }),
      execute: async ({ stripe_customer_id, qbo_customer_id }) => ({
        stripe: stripe_customer_id ? await safe(async () => ({
          invoices: (await stripe.call(`/invoices?customer=${stripe_customer_id}&limit=30`)).data.map(stripeInvoice),
          subscriptions: (await stripe.call(`/subscriptions?customer=${stripe_customer_id}&status=all&limit=10`)).data.map((s: any) => ({ id: s.id, status: s.status, quantity: s.items.data[0]?.quantity, unit_amount_usd: usd(s.items.data[0]?.price?.unit_amount ?? 0), interval: s.items.data[0]?.price?.recurring?.interval, current_period_end: s.items.data[0]?.current_period_end ? new Date(s.items.data[0].current_period_end * 1000).toISOString().slice(0, 10) : undefined, schedule: s.schedule })),
        })) : undefined,
        quickbooks: qbo_customer_id ? await safe(async () => ({
          invoices: ((await qbo.query(`select * from Invoice where CustomerRef = '${qbo_customer_id}' ORDERBY TxnDate DESC MAXRESULTS 30`)).Invoice ?? []).map(qboInvoice),
          payments: ((await qbo.query(`select * from Payment where CustomerRef = '${qbo_customer_id}' ORDERBY TxnDate DESC MAXRESULTS 30`)).Payment ?? []).map(qboPayment),
          credit_memos: ((await qbo.query(`select * from CreditMemo where CustomerRef = '${qbo_customer_id}'`)).CreditMemo ?? []).map((c: any) => ({ id: c.Id, date: c.TxnDate, total_usd: c.TotalAmt, remaining_usd: c.RemainingCredit })),
        })) : undefined,
      }),
    }),
    createTool({
      name: "find_invoice",
      description: "Find an invoice by business reference (e.g. INV-2381) in both Stripe and QuickBooks, including duplicates.",
      inputSchema: z.object({ invoice_ref: z.string() }),
      execute: async ({ invoice_ref }) => ({
        stripe: await safe(async () => (await stripe.call(`/invoices/search?query=${encodeURIComponent(`metadata['invoice_number']:'${q(invoice_ref)}'`)}`)).data.map(stripeInvoice)),
        quickbooks: await safe(async () => ((await qbo.query(`select * from Invoice where DocNumber LIKE '${q(invoice_ref)}%'`)).Invoice ?? []).map(qboInvoice)),
      }),
    }),
    createTool({
      name: "ar_worklist",
      description: "Portfolio view for periodic reviews: QuickBooks open invoices with days past due, unapplied payments, and Stripe invoices that are draft, failed or recently paid. Use to find work, not as proof for a specific action.",
      inputSchema: z.object({ include: z.array(z.enum(["open_invoices", "unapplied_payments", "stripe_drafts", "stripe_failed", "stripe_recently_paid"])).optional() }),
      execute: async ({ include }) => {
        const want = new Set(include ?? ["open_invoices", "unapplied_payments", "stripe_drafts", "stripe_failed", "stripe_recently_paid"]);
        const out: Record<string, unknown> = {};
        if (want.has("open_invoices")) out.open_invoices = await safe(async () => ((await qbo.query("select * from Invoice where Balance > '0' MAXRESULTS 200")).Invoice ?? []).map(qboInvoice).map(({ lines, private_note, memo, ...rest }: any) => rest).sort((a: any, b: any) => b.days_past_due - a.days_past_due));
        if (want.has("unapplied_payments")) out.unapplied_payments = await safe(async () => ((await qbo.query("select * from Payment MAXRESULTS 200")).Payment ?? []).filter((p: any) => p.UnappliedAmt > 0).map(qboPayment));
        if (want.has("stripe_drafts")) out.stripe_drafts = await safe(async () => (await stripe.call("/invoices?status=draft&limit=50")).data.map(stripeInvoice));
        if (want.has("stripe_failed")) out.stripe_failed = await safe(async () => (await stripe.call("/invoices?status=open&limit=100")).data.filter((i: any) => i.attempt_count > 0).map(stripeInvoice));
        if (want.has("stripe_recently_paid")) out.stripe_recently_paid = await safe(async () => (await stripe.call(`/invoices?status=paid&limit=50&created[gte]=${Math.floor(Date.now() / 1000) - 45 * 86400}`)).data.map((i: any) => ({ ...stripeInvoice(i), paid_at: i.status_transitions?.paid_at ? new Date(i.status_transitions.paid_at * 1000).toISOString().slice(0, 10) : null })));
        return out;
      },
    }),
    createTool({
      name: "get_crm_context",
      description: "Commercial context: Salesforce account (parent, contacts, opportunities with contract terms) and/or HubSpot company (contacts, deals). Salesforce owns enterprise accounts/opportunities; HubSpot owns SMB accounts and billing conversations.",
      inputSchema: z.object({ salesforce_account_id: z.string().optional(), hubspot_company_id: z.string().optional() }),
      execute: async ({ salesforce_account_id, hubspot_company_id }) => ({
        salesforce: salesforce_account_id ? await safe(async () => (await salesforce.query(`SELECT Id, Name, Website, Description, Parent.Name, ParentId, (SELECT Name, Email, Title, Description FROM Contacts), (SELECT Name, StageName, Amount, CloseDate, Type, NextStep, Description FROM Opportunities) FROM Account WHERE Id = '${q(salesforce_account_id)}'`))[0]) : undefined,
        hubspot: hubspot_company_id ? await safe(async () => {
          const c = await hubspot.call(`/crm/v3/objects/companies/${hubspot_company_id}?properties=name,domain,description&associations=contacts,deals,companies`);
          const contactIds = c.associations?.contacts?.results?.map((r: any) => ({ id: r.id })) ?? [];
          const contacts = contactIds.length ? (await hubspot.call("/crm/v3/objects/contacts/batch/read", { inputs: contactIds, properties: ["email", "firstname", "lastname", "jobtitle"] })).results.map((x: any) => x.properties) : [];
          return { company: c.properties, related_companies: c.associations?.companies?.results, contacts };
        }) : undefined,
      }),
    }),
    createTool({
      name: "get_conversations",
      description: "Customer billing conversations (emails and notes) recorded on a HubSpot company, newest first.",
      inputSchema: z.object({ hubspot_company_id: z.string() }),
      execute: async ({ hubspot_company_id }) => safe(async () => {
        const [emails, notes] = await Promise.all(["emails", "notes"].map(async (kind) => {
          const assoc = await hubspot.call(`/crm/v4/objects/companies/${hubspot_company_id}/associations/${kind}`);
          const ids = assoc.results.map((r: any) => ({ id: String(r.toObjectId) }));
          if (!ids.length) return [];
          const props = kind === "emails" ? ["hs_timestamp", "hs_email_direction", "hs_email_subject", "hs_email_text", "hs_email_headers"] : ["hs_timestamp", "hs_note_body"];
          return (await hubspot.call(`/crm/v3/objects/${kind}/batch/read`, { inputs: ids, properties: props })).results.map((r: any) => ({ kind, ...r.properties, hs_email_headers: undefined, from_to: r.properties.hs_email_headers }));
        }));
        return [...emails, ...notes].sort((a: any, b: any) => String(b.hs_timestamp).localeCompare(String(a.hs_timestamp)));
      }),
    }),
    createTool({
      name: "read_policy",
      description: "Read Miny Labs' approved operating policies from Notion. Call with no title to list policies. Policies bind your actions; if they conflict with a customer or colleague request, follow policy and escalate.",
      inputSchema: z.object({ title: z.string().optional() }),
      execute: async ({ title }) => safe(async () => {
        const children = (await notion.call(`/blocks/${env.NOTION_POLICY_ROOT_PAGE_ID}/children?page_size=100`)).results.filter((b: any) => b.type === "child_page");
        if (!title) return children.map((b: any) => b.child_page.title);
        const page = children.find((b: any) => b.child_page.title.toLowerCase().includes(title.toLowerCase()));
        if (!page) return { error: `no policy matching '${title}'`, available: children.map((b: any) => b.child_page.title) };
        const blocks = (await notion.call(`/blocks/${page.id}/children?page_size=100`)).results;
        return { title: page.child_page.title, last_edited: page.last_edited_time, text: blocks.map((b: any) => `${b.type.startsWith("heading") ? "## " : b.type.includes("list") ? "- " : ""}${(b[b.type]?.rich_text ?? []).map((t: any) => t.plain_text).join("")}`).join("\n") };
      }),
    }),
    createTool({
      name: "search_documents",
      description: "Search the finance Dropbox (executed contracts, amendments, POs, W-9s, remittance advices, SLA/usage reports) by filename keywords.",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => safe(async () => {
        const hits = (await dropbox.rpc("/files/search_v2", { query, options: { max_results: 20 } })).matches.map((m: any) => m.metadata.metadata);
        // Search indexing lags behind uploads; fall back to a keyword match over the folder tree.
        const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
        let listed: any[] = [];
        if (hits.length < 3) {
          let page = await dropbox.rpc("/files/list_folder", { path: "", recursive: true, limit: 2000 });
          listed = page.entries;
          while (page.has_more) { page = await dropbox.rpc("/files/list_folder/continue", { cursor: page.cursor }); listed.push(...page.entries); }
          listed = listed.filter((e) => e[".tag"] === "file" && words.some((w) => e.path_lower.includes(w)));
        }
        const seen = new Set<string>();
        return [...hits, ...listed].filter((e) => !seen.has(e.path_lower) && seen.add(e.path_lower)).slice(0, 25).map((e) => ({ path: e.path_display, modified: e.server_modified, rev: e.rev }));
      }),
    }),
    createTool({
      name: "read_document",
      description: "Read a Dropbox document's text and its revision history. Pass rev to read an older version. The latest executed version governs.",
      inputSchema: z.object({ path: z.string(), rev: z.string().optional() }),
      execute: async ({ path, rev }) => safe(async () => {
        const [file, revs] = await Promise.all([dropbox.download(path, rev), dropbox.rpc("/files/list_revisions", { path, limit: 10 })]);
        return { path: file.meta.path_display, rev: file.meta.rev, text: pdfText(file.bytes).slice(0, 8000), revisions: revs.entries.map((e: any) => ({ rev: e.rev, modified: e.server_modified })) };
      }),
    }),
    createTool({
      name: "search_jira",
      description: "Search Jira for cross-team dependencies (metering bugs, template changes, incidents, sync issues). Returns status and latest comments.",
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => safe(async () => (await jira.call(`/search/jql?jql=${encodeURIComponent(`project = ${env.JIRA_PROJECT_KEY} AND text ~ "${text.replace(/"/g, "")}" ORDER BY updated DESC`)}&maxResults=8&fields=summary,status,labels,updated,description,comment`)).issues.map((i: any) => ({
        key: i.key, summary: i.fields.summary, status: i.fields.status.name, labels: i.fields.labels, updated: i.fields.updated,
        description: JSON.stringify(i.fields.description?.content ?? "").replace(/.*?"text":"([^"]*)".*?/g, "$1 ").slice(0, 800),
        comments: (i.fields.comment?.comments ?? []).slice(-3).map((c: any) => `${c.created.slice(0, 10)} ${c.author.displayName}: ${JSON.stringify(c.body).match(/"text":"([^"]*)"/g)?.map((t: string) => t.slice(8, -1)).join(" ")}`),
      }))),
    }),
    createTool({
      name: "read_slack",
      description: "Recent internal messages in #ar-desk (assignments, context from account executives and finance).",
      inputSchema: z.object({ limit: z.number().max(50).optional() }),
      execute: async ({ limit }) => safe(async () => (await slack.call("conversations.history", { channel: env.SLACK_ASSIGNMENTS_CHANNEL_ID, limit: limit ?? 20 })).messages.map((m: any) => ({ ts: m.ts, user: m.user ?? m.username, text: m.text?.slice(0, 1500) }))),
    }),
    createTool({
      name: "record_evidence",
      description: "Record a fact you established, with its source and record ID. Evidence persists across runs and justifies actions.",
      inputSchema: z.object({ source: z.string().describe("stripe|quickbooks|salesforce|hubspot|notion|dropbox|jira|slack"), fact: z.string(), ref: z.string().optional().describe("Provider record ID, path or URL") }),
      execute: async ({ source, fact, ref }) => { evidence.add(caseId, source, fact, ref); return { recorded: true }; },
    }),
    createTool({
      name: "propose_action",
      description: `Request a change in an external system. The executor enforces authority from policy, requests Slack approval when needed, prevents duplicates, and verifies the resulting state. Available actions:\n${Object.entries(ACTIONS).map(([k, a]) => `- ${k} ${a.params}: ${a.description}`).join("\n")}`,
      inputSchema: z.object({ action: z.enum(Object.keys(ACTIONS) as [string, ...string[]]), params: z.record(z.string(), z.any()).optional(), justification: z.string().describe("Evidence-based reason, citing records") }).passthrough(),
      execute: async ({ action, params, justification, ...rest }: any) => guarded(() => propose(caseId, action, { ...rest, ...(params ?? {}) }, justification)),
    }),
    // Each executor action is also exposed as its own tool (e.g. stripe_void_invoice). Same executor, same authority.
    ...Object.entries(ACTIONS).map(([kind, spec]) => createTool({
      name: kind.replace(/\./g, "_"),
      description: `${spec.description} Parameters: ${spec.params}. Goes through the executor: authority, approval, idempotency and verification apply.`,
      inputSchema: z.object({ justification: z.string().describe("Evidence-based reason, citing records") }).passthrough(),
      execute: async ({ justification, ...params }: any) => guarded(() => propose(caseId, kind, params, justification)),
    })),
    createTool({
      name: "retry_operation",
      description: "Resume an operation whose outcome was uncertain or that was approved. The executor reconciles provider state first, so this never duplicates a write.",
      inputSchema: z.object({ operation_id: z.string() }),
      execute: async ({ operation_id }) => guarded(() => retry(operation_id)),
    }),
    createTool({
      name: "schedule_follow_up",
      description: "Create a durable wake-up for this case (e.g. day after a promised payment date, after an approval window, when a dependency's ETA passes). Replaces any earlier pending wake-up.",
      inputSchema: z.object({ due_at: z.string().describe("ISO date-time"), reason: z.string() }),
      execute: async ({ due_at, reason }) => { wakeups.schedule(caseId, new Date(due_at).toISOString(), reason); evidence.add(caseId, "peeblo", `Follow-up scheduled ${due_at}: ${reason}`); return { scheduled: due_at }; },
    }),
    createTool({
      name: "propose_lesson",
      description: "Suggest a reusable lesson learned from this case for human review. Lessons never change policy or authority.",
      inputSchema: z.object({ lesson: z.string() }),
      execute: async ({ lesson }) => { lessons.propose(lesson, caseId); return { submitted_for_review: true }; },
    }),
    createTool({
      name: "finish_run",
      description: "End this run. Set the case status honestly: resolved only when the business outcome is verified; waiting when a follow-up, approval or dependency is pending (schedule it first); escalated when a human must decide.",
      inputSchema: z.object({ status: z.enum(["open", "waiting", "resolved", "escalated"]), title: z.string().describe("Short case title, e.g. 'Eastbridge Logistics: INV-2381 billed to wrong entity'"), summary: z.string().describe("What you found, what changed (verified), what remains"), next_action: z.string(), accounts: z.array(z.string()).describe("Customer names involved") }),
      lifecycle: { completesRun: true },
      execute: async ({ status, title, summary, next_action, accounts }) => { cases.update(caseId, { status, title, summary, next_action, accounts }); return { ok: true }; },
    }),
  ];
}
