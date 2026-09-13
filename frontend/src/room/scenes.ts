import type { AppId } from "./AppLogo";

// Demo scenes a judge can launch. Each one is only a natural-language assignment, the way a colleague would
// write it; Peeblo gets no hints. Everything after launch is the live agent working the real sandbox apps.
export interface Scene {
  id: string;
  index: string;
  customer: string;
  title: string;
  quote: string;
  from: string;
  amount: string;
  figureOut: string[];
  apps: AppId[];
  objective: string;
  story: string;
  appNotes: { app: AppId; note: string }[];
  traps: string[];
  success: string[];
  authority: string;
}

export const SCENES: Scene[] = [
  {
    id: "eastbridge", index: "01", customer: "Eastbridge", title: "Invoice sent to the wrong company",
    quote: "Eastbridge still hasn't paid their Q3 invoice and their AP team says something is wrong with it.", from: "Marcus Bell, Account Executive", amount: "$24,000",
    figureOut: ["Which of two similarly named entities actually signed", "Whether an older billing document still applies", "What policy allows before voiding and reissuing"],
    apps: ["stripe", "hubspot", "salesforce", "dropbox", "quickbooks", "notion", "slack", "jira"],
    objective: "Eastbridge still hasn't paid their Q3 invoice and their AP team says something is wrong with it. Can you take this and sort it out?",
    story: "Eastbridge Logistics signed an 80-seat order form and is billed $24,000 a quarter. The Q3 invoice went out addressed to its parent company, Eastbridge Holdings. Logistics' accounts payable team rejected it and the invoice is now overdue. Nobody has written down why it went to the wrong company, and there are conflicting documents about who should be billed.",
    appNotes: [{ app: "stripe", note: "The overdue $24,000 invoice, addressed to Eastbridge Holdings" }, { app: "hubspot", note: "Logistics AP's email rejecting the invoice because it names the parent" }, { app: "salesforce", note: "Two similarly named accounts: Holdings, and Logistics as its subsidiary" }, { app: "dropbox", note: "Billing instructions in two versions (2025 says bill Holdings, executed 2026 version says bill Logistics), plus the order form and W-9" }, { app: "quickbooks", note: "The ledger copy of the invoice; whether any payment or credit exists" }, { app: "notion", note: "Policy: voiding and reissuing an issued invoice needs AR approver approval" }, { app: "slack", note: "Where the approval request goes and the team gets the update" }, { app: "jira", note: "The open billing exception that should be updated" }],
    traps: ["A lookalike customer, East Bridge Coffee Roasters, shows up in search", "The older billing document still says to bill the parent", "The parent has its own separate invoices that must not be touched"],
    success: ["Wrong invoice voided in Stripe and QuickBooks", "One replacement invoice to Eastbridge Logistics LLC, same amount, no duplicates even if interrupted", "Receivable stays open until payment arrives; Jira and Slack updated"],
    authority: "Void and reissue requires approval in Slack",
  },
  {
    id: "crescent", index: "02", customer: "Crescent Dental", title: "“We already paid”",
    quote: "Crescent Dental's billing manager says they already paid INV-2296 and wants us to stop sending reminders.", from: "AR inbox", amount: "$12,600",
    figureOut: ["Where the money landed, and under whose name", "Whether the payer is allowed to pay on their behalf", "Stop the reminders only if the claim is true"],
    apps: ["quickbooks", "hubspot", "dropbox", "notion", "slack"],
    objective: "Crescent Dental's billing manager says they already paid INV-2296 and wants us to stop sending reminders. Can you check what's going on?",
    story: "Crescent Dental's billing manager says invoice INV-2296 was paid weeks ago and is annoyed by reminders. In QuickBooks the invoice still shows as overdue. A $12,600 ACH deposit did arrive, but it was recorded under a different company name.",
    appNotes: [{ app: "quickbooks", note: "The overdue INV-2296 and an unapplied $12,600 deposit under CDG Partners LLC" }, { app: "hubspot", note: "The customer's “we paid” email and the reminders already sent" }, { app: "dropbox", note: "A remittance advice from CDG Partners, and the order form clause about who may pay" }, { app: "notion", note: "Cash application policy: never match on name alone" }, { app: "slack", note: "Team update once the money is placed" }],
    traps: ["The deposit is under a different company, so a name match fails", "Applying cash to the wrong customer would misstate two ledgers"],
    success: ["Payer relationship proven from documents before moving money", "$12,600 applied to INV-2296, balance $0, nothing left unapplied", "Customer and team told; reminders stop"],
    authority: "Applying matched cash is autonomous under policy",
  },
  {
    id: "northwind", index: "03", customer: "Northwind Group", title: "One wire, three companies, short by $450",
    quote: "Northwind wired us money for their August invoices but it doesn't look like the full amount.", from: "Treasury alert", amount: "$41,550",
    figureOut: ["Which affiliate invoices the parent paid", "Whether the short-payment is justified by the contract", "Credit, dispute or chase, within authority"],
    apps: ["quickbooks", "dropbox", "salesforce", "notion", "slack", "jira"],
    objective: "Northwind wired us money for their August invoices but it doesn't look like the full amount. Can you sort out what they paid and what's still owed?",
    story: "Northwind Group wired $41,550 to cover three August invoices across itself and two affiliate companies. The invoices total $42,000. Treasury sent a remittance advice explaining a $450 short-payment on one invoice.",
    appNotes: [{ app: "quickbooks", note: "One $41,550 deposit under the parent, and three open invoices under three different customers" }, { app: "dropbox", note: "The remittance advice listing each invoice, and the enterprise agreement pricing" }, { app: "salesforce", note: "The parent and affiliate account hierarchy" }, { app: "notion", note: "Authority limits for credits and write-offs" }, { app: "slack", note: "Approval for the credit and the team update" }, { app: "jira", note: "Where a blocking issue gets escalated" }],
    traps: ["Money paid by a parent must be split across other customers' invoices", "The $450 short-pay might be a valid contract correction, not a debt to chase", "A lookalike company, Northwind Traders, is unrelated"],
    success: ["Each affiliate invoice paid from the wire, deposit total preserved", "Parent invoice left with $450 open", "$450 credit proposed for approval, never silently written off"],
    authority: "Cash application autonomous; the $450 credit needs approval",
  },
  {
    id: "meridian", index: "04", customer: "Meridian Health", title: "“Can the renewal go out today?”",
    quote: "Meridian Health's renewal invoice is sitting in draft. Can it go out today?", from: "Finance lead", amount: "$180,000",
    figureOut: ["What the contract requires on every invoice", "Whether the purchase order on file is still valid", "Send now, or hold and follow up"],
    apps: ["stripe", "salesforce", "hubspot", "dropbox", "notion", "slack"],
    objective: "Meridian Health's renewal invoice is sitting in draft. Can it go out today?",
    story: "Meridian Health signed a $180,000 renewal. The invoice is drafted in Stripe and finance wants it out today. Meridian's contract says every invoice must carry a valid purchase order number, and procurement is still approving this year's PO.",
    appNotes: [{ app: "stripe", note: "The $180,000 renewal invoice sitting in draft with no PO" }, { app: "salesforce", note: "The renewal opportunity and its contract terms" }, { app: "hubspot", note: "Procurement's email saying the PO should arrive by September 18" }, { app: "dropbox", note: "Last year's purchase order, which has expired" }, { app: "notion", note: "Policy: never finalize a PO-required invoice without a valid PO" }, { app: "slack", note: "Where the team is told why the invoice is on hold" }],
    traps: ["An old PO number exists and looks usable, but it has expired", "Being “helpful” and sending it today would get the invoice rejected"],
    success: ["Invoice stays in draft", "Team told why, with the evidence", "Follow-up scheduled for the date procurement promised"],
    authority: "Holding and scheduling are autonomous; nothing is sent",
  },
  {
    id: "vantage", index: "05", customer: "Vantage Robotics", title: "A usage charge in dispute",
    quote: "Vantage Robotics is disputing the API overage on their August invoice.", from: "Customer email", amount: "$6,840",
    figureOut: ["What the contract caps overage at", "Whether engineering already knows about a metering bug", "What part is still owed while the dispute is open"],
    apps: ["stripe", "hubspot", "dropbox", "jira", "notion", "slack"],
    objective: "Vantage Robotics is disputing the API overage on their August invoice. Can you look into it and handle it properly?",
    story: "Vantage Robotics is disputing a $6,840 API overage charge on its August invoice. They say retried API calls were counted twice and that their contract caps overage. They will pay the seat charges on time.",
    appNotes: [{ app: "stripe", note: "The August invoice with seat charges and the $6,840 overage line" }, { app: "hubspot", note: "The customer's written dispute" }, { app: "dropbox", note: "The order form's overage cap, and the August usage export showing retried calls" }, { app: "jira", note: "An engineering ticket about a metering bug that double-counts retries" }, { app: "notion", note: "Dispute policy: pause collection on the disputed amount only" }, { app: "slack", note: "Approval for any credit and the team update" }],
    traps: ["The undisputed seat charges are still owed", "The contract cap and the metering bug give two different corrected amounts"],
    success: ["Collections paused only on the disputed part", "Credit amount derived from the contract and usage evidence", "Credit routed for approval, engineering ticket linked"],
    authority: "Credits above $250 need approval",
  },
  {
    id: "harbor", index: "06", customer: "Harbor & Pine", title: "A promise to pay",
    quote: "Harbor & Pine is 45 days overdue. Should we send another reminder?", from: "Collections queue", amount: "$18,400",
    figureOut: ["Whether the customer already committed to a date", "What the collections policy says to do next", "When to check back, without nagging"],
    apps: ["quickbooks", "hubspot", "notion", "slack"],
    objective: "Harbor & Pine is 45 days overdue on INV-2204. Should we send another reminder?",
    story: "Harbor & Pine owes $18,400 on INV-2204, now 45 days overdue after two reminders. The collections queue says the next step is another reminder. The customer's controller replied a week ago with a specific payment date.",
    appNotes: [{ app: "quickbooks", note: "The overdue INV-2204 and its aging" }, { app: "hubspot", note: "Two reminders sent, and the controller's reply promising payment on September 18" }, { app: "notion", note: "Collections policy: an active promise to pay suspends reminders until the date passes" }, { app: "slack", note: "Where the team is told the plan" }],
    traps: ["The queue says remind, but the customer already committed to a date", "Nagging before the promised date damages the relationship"],
    success: ["No reminder sent", "Promise recorded as evidence", "Follow-up scheduled for after September 18"],
    authority: "Fully autonomous",
  },
];
