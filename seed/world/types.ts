// World model shared by every app seeder. Amounts are USD dollars with 2 decimals.
// Keys are stable, lowercase, and unique within their collection.

export type Crm = "salesforce" | "hubspot" | "both" | "none";

export interface Account {
  key: string;
  name: string; // name as it appears in CRM and billing
  legalName: string; // legal entity that signs contracts
  domain: string;
  parentKey?: string;
  industry: string;
  segment: "enterprise" | "mid_market" | "smb";
  crm: Crm;
  stripe: boolean; // has a Stripe customer
  qbo: boolean; // has a QuickBooks customer
  city: string;
  state: string;
  taxId?: string;
  paymentTerms: "Due on receipt" | "Net 15" | "Net 30" | "Net 45" | "Net 60";
  poRequired?: boolean;
  renamedFrom?: string; // CRM rename history (HubSpot may still hold the old name)
  notes?: string;
}

export interface Contact {
  key: string;
  accountKey: string;
  firstName: string;
  lastName: string;
  email: string;
  title: string;
  role: "billing" | "ap" | "champion" | "exec" | "procurement" | "legal";
  phone?: string;
  crm: Crm; // where the contact exists
  status?: "active" | "left_company";
}

export interface Product {
  key: string;
  name: string;
  sku: string;
  unitAmount: number;
  unit: string;
  recurring?: "month" | "year";
  qboIncomeAccount: string;
}

export interface Line {
  productKey: string;
  description?: string;
  quantity: number;
  unitAmount: number; // price actually charged on this document
}

export interface Contract {
  key: string;
  accountKey: string; // account that signed (legal entity)
  title: string;
  status: "active" | "draft" | "expired";
  startDate: string;
  termMonths: number;
  billing: "annual_upfront" | "monthly" | "quarterly" | "one_time";
  lines: Line[];
  discountPct?: number;
  paymentTerms: Account["paymentTerms"];
  poRequired?: boolean;
  poNumber?: string;
  upliftPct?: number;
  overageCapMonthly?: number;
  slaCreditPctPerBreach?: number;
  signedBy: string; // "Name, Title, Legal Entity"
  clauses: string[]; // human-readable clauses used in generated documents
}

export interface Opportunity {
  key: string;
  accountKey: string;
  name: string;
  stage: "Prospecting" | "Negotiation/Review" | "Closed Won" | "Closed Lost";
  amount: number;
  closeDate: string;
  contractKey?: string;
  type: "New Business" | "Renewal" | "Expansion";
  nextStep?: string;
}

export interface Subscription {
  key: string;
  accountKey: string;
  contractKey: string;
  productKey: string;
  quantity: number;
  unitAmount: number;
  interval: "month" | "year";
  status: "active" | "past_due" | "canceled";
  paymentMethod: "card_ok" | "card_fails" | "send_invoice";
}

export type StripeInvoiceState = "draft" | "open" | "paid" | "void" | "payment_failed" | "uncollectible";
export type QboInvoiceState = "open" | "paid" | "partial" | "void";

export interface Invoice {
  key: string;
  number: string; // business invoice number, e.g. INV-2381 (Stripe metadata + QBO DocNumber)
  accountKey: string; // customer the document is addressed to (may be wrong on purpose)
  contractKey?: string;
  issueDate: string;
  dueDate: string;
  lines: Line[];
  poNumber?: string;
  memo?: string;
  stripe?: { state: StripeInvoiceState; subscriptionKey?: string; paidDate?: string };
  qbo?: { state: QboInvoiceState; amountPaid?: number; duplicateOf?: string };
}

export interface Payment {
  key: string;
  system: "qbo" | "stripe";
  payerName: string; // as it appears on the bank remittance
  accountKey?: string; // QBO customer the deposit was recorded under (may be a lookalike)
  amount: number;
  date: string;
  method: "ACH" | "Wire" | "Check" | "Card";
  reference: string;
  applications: { invoiceKey: string; amount: number }[]; // empty = unapplied
}

export interface CreditMemo {
  key: string;
  accountKey: string;
  invoiceKey?: string;
  date: string;
  amount: number;
  reason: string;
  system: "qbo" | "stripe" | "both";
}

export interface DocVersion {
  date: string;
  body: string[]; // paragraphs rendered into the PDF
  note?: string; // revision note
}

export interface Document {
  key: string;
  accountKey?: string;
  path: string; // path inside the Dropbox app folder
  title: string;
  kind: "msa" | "order_form" | "amendment" | "po" | "remittance" | "w9" | "statement" | "correspondence" | "sla_report";
  versions: DocVersion[]; // uploaded in order; later versions overwrite the same path
}

export interface Communication {
  key: string;
  accountKey?: string;
  channel: "hubspot_email" | "hubspot_note" | "slack";
  slackChannel?: "assignments" | "approvals";
  date: string; // ISO date-time
  from: string;
  to?: string;
  subject?: string;
  body: string;
  direction?: "inbound" | "outbound";
}

export interface JiraIssue {
  key: string;
  accountKey?: string;
  type: "Task" | "Story" | "Epic" | "Subtask";
  summary: string;
  description: string;
  status: "To Do" | "In Progress" | "In Review" | "Done";
  labels: string[];
  created: string;
  comments?: { date: string; author: string; body: string }[];
}

export interface Policy {
  key: string;
  title: string;
  markdown: string;
}

export interface Case {
  key: string;
  split: "demo" | "dev" | "holdout";
  responsibilities: number[]; // ARCHITECTURE.md responsibility numbers 1-20
  accountKeys: string[];
  title: string;
  trigger: string; // how the work arrives: event, schedule, or Slack assignment
  expected: string[]; // verified end state
  forbidden: string[]; // prohibited side effects
  approvalRequired?: string;
}
