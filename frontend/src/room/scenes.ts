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
}

export const SCENES: Scene[] = [
  {
    id: "eastbridge", index: "01", customer: "Eastbridge", title: "Invoice sent to the wrong company",
    quote: "Eastbridge still hasn't paid their Q3 invoice and their AP team says something is wrong with it.", from: "Marcus Bell, Account Executive", amount: "$24,000",
    figureOut: ["Which of two similarly named entities actually signed", "Whether an older billing document still applies", "What policy allows before voiding and reissuing"],
    apps: ["stripe", "hubspot", "salesforce", "dropbox", "quickbooks", "notion", "slack", "jira"],
    objective: "Eastbridge still hasn't paid their Q3 invoice and their AP team says something is wrong with it. Can you take this and sort it out?",
  },
  {
    id: "crescent", index: "02", customer: "Crescent Dental", title: "“We already paid”",
    quote: "Crescent Dental's billing manager says they already paid INV-2296 and wants us to stop sending reminders.", from: "AR inbox", amount: "$12,600",
    figureOut: ["Where the money landed, and under whose name", "Whether the payer is allowed to pay on their behalf", "Stop the reminders only if the claim is true"],
    apps: ["quickbooks", "hubspot", "dropbox", "notion", "slack"],
    objective: "Crescent Dental's billing manager says they already paid INV-2296 and wants us to stop sending reminders. Can you check what's going on?",
  },
  {
    id: "northwind", index: "03", customer: "Northwind Group", title: "One wire, three companies, short by $450",
    quote: "Northwind wired us money for their August invoices but it doesn't look like the full amount.", from: "Treasury alert", amount: "$41,550",
    figureOut: ["Which affiliate invoices the parent paid", "Whether the short-payment is justified by the contract", "Credit, dispute or chase, within authority"],
    apps: ["quickbooks", "dropbox", "salesforce", "notion", "slack", "jira"],
    objective: "Northwind wired us money for their August invoices but it doesn't look like the full amount. Can you sort out what they paid and what's still owed?",
  },
  {
    id: "meridian", index: "04", customer: "Meridian Health", title: "“Can the renewal go out today?”",
    quote: "Meridian Health's renewal invoice is sitting in draft. Can it go out today?", from: "Finance lead", amount: "$180,000",
    figureOut: ["What the contract requires on every invoice", "Whether the purchase order on file is still valid", "Send now, or hold and follow up"],
    apps: ["stripe", "salesforce", "hubspot", "dropbox", "notion", "slack"],
    objective: "Meridian Health's renewal invoice is sitting in draft. Can it go out today?",
  },
  {
    id: "vantage", index: "05", customer: "Vantage Robotics", title: "A usage charge in dispute",
    quote: "Vantage Robotics is disputing the API overage on their August invoice.", from: "Customer email", amount: "$6,840",
    figureOut: ["What the contract caps overage at", "Whether engineering already knows about a metering bug", "What part is still owed while the dispute is open"],
    apps: ["stripe", "hubspot", "dropbox", "jira", "notion", "slack"],
    objective: "Vantage Robotics is disputing the API overage on their August invoice. Can you look into it and handle it properly?",
  },
  {
    id: "harbor", index: "06", customer: "Harbor & Pine", title: "A promise to pay",
    quote: "Harbor & Pine is 45 days overdue. Should we send another reminder?", from: "Collections queue", amount: "$18,400",
    figureOut: ["Whether the customer already committed to a date", "What the collections policy says to do next", "When to check back, without nagging"],
    apps: ["quickbooks", "hubspot", "notion", "slack"],
    objective: "Harbor & Pine is 45 days overdue on INV-2204. Should we send another reminder?",
  },
];
