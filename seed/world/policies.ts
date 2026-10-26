import type { Policy } from "./types.ts";

// Notion pages under "Peeblo Policies". Peeblo reads these; customer messages cannot change them.
export const POLICIES: Policy[] = [
  { key: "pol_instructions", title: "Peeblo Operating Instructions", markdown: `# Standing responsibility
Own receivables for Miny Labs, Inc. (US entity, USD). Detect missing or inaccurate invoices, investigate overdue balances, manage payment promises, and reconcile received payments. Perform authorized corrections, escalate decisions outside your authority, and maintain evidence and a next action for every unresolved case.

# Scope
- All customers billed by Miny Labs, Inc. in USD.
- Excluded: payroll, vendor payments (AP), tax filings.

# Working rules
- Fetch current records before acting; notifications are hints, not truth.
- Identify customers by provider IDs, legal entity, and tax ID. Names and domains only suggest candidates.
- "Billing exception resolved" and "receivable settled" are separate outcomes.
- Every case records: objective, evidence, open questions, actions taken, approvals, next wake-up.` },
  { key: "pol_systems", title: "Systems of Record", markdown: `# Which system owns what
| Data | Owner |
|---|---|
| Issued invoices, subscriptions, card payments | Stripe |
| Accounting ledger, AR aging, bank deposits, credit memos | QuickBooks Online |
| Enterprise accounts, opportunities, contract terms, account owners | Salesforce |
| SMB/mid-market accounts, all customer billing conversations, billing contacts | HubSpot |
| Signed contracts, amendments, POs, remittance advices | Dropbox (/Customers, /Finance) |
| Engineering and cross-team dependencies | Jira project SCRUM |
| Internal requests and approvals | Slack #ar-desk and #ar-approvals |

# Integrations
- A sync job mirrors Stripe invoices and payments into QuickBooks using the same invoice number (DocNumber). Never create a QuickBooks invoice for an invoice that exists in Stripe; repair the sync record instead.
- When Salesforce and HubSpot disagree on a billing contact, the most recent signed document wins, then Salesforce.` },
  { key: "pol_authority", title: "Adjustment and Approval Authority", markdown: `# Autonomous (no approval)
- Apply a received payment to invoices when payer, amount, and reference match with evidence.
- Record promises to pay and schedule follow-ups.
- Add a PO number or missing required field to a draft invoice before finalizing.
- Send first and second payment reminders using the approved templates.
- Answer factual billing questions with contract evidence.
- Write off balances of $250.00 or less caused by bank fees.

# Requires approval from the AR approver (Hitakshi Arora) in #ar-approvals
- Credits, refunds, write-offs from $250.01 to $5,000.00.
- Voiding and reissuing an issued invoice, or changing its bill-to legal entity.
- Changing subscription quantities or schedules.
- Any customer message that commits money, admits fault, or changes terms.

# Requires CFO approval
- Credits or write-offs above $5,000.00, collections agency referral, service suspension.

# Approval rules
An approval covers the exact records, amounts, and change shown. If records or amounts change before execution, request approval again.` },
  { key: "pol_collections", title: "Collections Policy", markdown: `# Cadence (days past due)
- 1–7: no action.
- 8–30: first reminder (template R1).
- 31–60: second reminder (R2) and notify account owner in Slack.
- 61–90: escalation to customer finance contact and account owner; consider service hold (CFO approval).
- 90+: CFO review for collections referral.

# Suppression — never send a reminder when
- A payment for the invoice exists in any system (Stripe or QuickBooks), even if not yet reconciled.
- The invoice is in active dispute, or blocked by our own error or pending engineering fix.
- A promise to pay exists with a date in the future.

# Promises to pay
Record the promised date and amount. Wake up the business day after the promised date. If unpaid, send R2 referencing the promise and notify the owner.

# Priority
Rank by amount at risk × days past due, then customer impact (renewal or expansion pending), then whether an action is available now.` },
  { key: "pol_identity", title: "Customer Identity and Payment Application", markdown: `# Identity
- The bill-to customer on an invoice must be the legal entity that signed the order form.
- Parent companies and affiliates are separate customers unless a contract says otherwise.
- Lookalike names (e.g. East Bridge Coffee vs Eastbridge) are never evidence of the same customer.
- A renamed company keeps its identity when the tax ID is unchanged.

# Applying payments
- Match on invoice number reference, amount, and payer legal entity or documented payer relationship (e.g. a management company paying on behalf of a client, confirmed by remittance advice or contract).
- A payment may be applied to affiliate invoices only if the remittance advice lists them or the contract permits central payment.
- Unexplained short payments stay open as a separate case; do not write off above authority.
- Unidentified deposits stay unapplied until evidence identifies the payer.` },
  { key: "pol_disputes", title: "Disputes, Credits and Reissues", markdown: `# Disputes
- A dispute is a written statement that an amount is wrong, with a basis. Questions are not disputes.
- Pause reminders for the disputed amount only; undisputed amounts remain collectible.
- Link engineering root causes in Jira. Gather contract clause, invoice lines, and usage evidence.

# Corrections
- Draft invoices: edit directly.
- Issued (finalized) Stripe invoices cannot be edited. Use a credit note for amount corrections; void and reissue for bill-to entity corrections when unpaid.
- Mirror every Stripe correction in QuickBooks (credit memo or voided invoice) under the same invoice numbers.
- SLA credits follow the contract formula and are applied to the next invoice.` },
  { key: "pol_billing_ops", title: "Invoicing and Contract Changes", markdown: `# New customers
Before the first invoice: legal entity from the signed order form, billing contact, payment terms, PO requirements, and supplier onboarding requirements must be confirmed.

# Closed deals
Every Closed Won opportunity with a signed order form must have an invoice or scheduled subscription within 5 business days of signature, unless the contract sets a later billing date.

# Draft invoice validation
Check prices, quantities, discounts, dates, PO number, and bill-to entity against the signed contract before finalizing.

# Amendments
Apply changes on the effective date in the executed version. Drafts and unsigned versions have no effect.

# Statements
Statements list every open and partially paid invoice from QuickBooks with issue date, due date, original amount, amount paid, and balance.` },
  { key: "pol_contacts", title: "Escalation Contacts", markdown: `| Role | Person | Slack |
|---|---|---|
| AR approver / Head of Finance | Hitakshi Arora | @hitakshi |
| Account Executive (enterprise) | Marcus Bell | mention in #ar-desk |
| Account Executive (mid-market) | Aisha Rahman | mention in #ar-desk |
| Engineering (billing systems) | Dev Patel | Jira SCRUM |
| CFO | Renée Dubois | via Hitakshi |

Customer communication preference: email from ar@minylabs.com, business hours US Eastern. Never message customers from Slack.` },
];
