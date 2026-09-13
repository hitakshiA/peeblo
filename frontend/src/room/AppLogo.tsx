import { siStripe, siQuickbooks, siHubspot, siDropbox, siNotion, siJira } from "simple-icons";

export type AppId = "stripe" | "quickbooks" | "salesforce" | "hubspot" | "dropbox" | "notion" | "slack" | "jira" | "lemma" | "arga" | "peeblo";

export const APPS: { id: AppId; name: string; color: string; role: string }[] = [
  { id: "stripe", name: "Stripe", color: "#635BFF", role: "Invoices" },
  { id: "hubspot", name: "HubSpot", color: "#FF7A59", role: "Conversations" },
  { id: "salesforce", name: "Salesforce", color: "#00A1E0", role: "Accounts" },
  { id: "dropbox", name: "Dropbox", color: "#0061FF", role: "Contracts" },
  { id: "quickbooks", name: "QuickBooks", color: "#2CA01C", role: "Ledger" },
  { id: "notion", name: "Notion", color: "#FFFFFF", role: "Policy" },
  { id: "slack", name: "Slack", color: "#E01E5A", role: "Approvals" },
  { id: "jira", name: "Jira", color: "#2684FF", role: "Dependencies" },
];

const SIMPLE: Partial<Record<AppId, { path: string }>> = {
  stripe: siStripe, quickbooks: siQuickbooks, hubspot: siHubspot, dropbox: siDropbox, notion: siNotion, jira: siJira,
};

export function AppLogo({ app, size = 18, mono = false }: { app: AppId | string; size?: number; mono?: boolean }) {
  const meta = APPS.find((a) => a.id === app);
  const fill = mono ? "currentColor" : meta?.color ?? "currentColor";
  const icon = SIMPLE[app as AppId];
  if (icon) return <svg width={size} height={size} viewBox="0 0 24 24" aria-label={meta?.name}><path d={icon.path} fill={fill} /></svg>;
  if (app === "salesforce")
    return <svg width={size} height={size} viewBox="0 0 24 24" aria-label="Salesforce"><path fill={fill} d="M10 5.2a4.2 4.2 0 0 1 3.1-1.3 4.3 4.3 0 0 1 3.7 2.1 5 5 0 0 1 2.1-.4A5.1 5.1 0 0 1 24 10.7a5.1 5.1 0 0 1-6.1 5 3.9 3.9 0 0 1-3.4 2 3.8 3.8 0 0 1-1.7-.4 4.4 4.4 0 0 1-8.2-.3 4.1 4.1 0 0 1-.8.1A3.9 3.9 0 0 1 0 13.2a4 4 0 0 1 2-3.4 4.5 4.5 0 0 1 4.1-6.3 4.5 4.5 0 0 1 3.9 1.7z" /></svg>;
  if (app === "slack")
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-label="Slack">
        <path fill={mono ? fill : "#E01E5A"} d="M5 15.1a2.5 2.5 0 1 1-2.5-2.5H5zm1.3 0a2.5 2.5 0 0 1 5 0v6.3a2.5 2.5 0 1 1-5 0z" />
        <path fill={mono ? fill : "#36C5F0"} d="M8.9 5a2.5 2.5 0 1 1 2.5-2.5V5zm0 1.3a2.5 2.5 0 0 1 0 5H2.5a2.5 2.5 0 1 1 0-5z" />
        <path fill={mono ? fill : "#2EB67D"} d="M19 8.9a2.5 2.5 0 1 1 2.5 2.5H19zm-1.3 0a2.5 2.5 0 0 1-5 0V2.5a2.5 2.5 0 1 1 5 0z" />
        <path fill={mono ? fill : "#ECB22E"} d="M15.1 19a2.5 2.5 0 1 1-2.5 2.5V19zm0-1.3a2.5 2.5 0 0 1 0-5h6.3a2.5 2.5 0 1 1 0 5z" />
      </svg>
    );
  // Peeblo mark for internal steps
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-label="Peeblo"><circle cx="12" cy="12" r="9" fill="none" stroke="#7BE0A6" strokeWidth="2.2" /><circle cx="12" cy="12" r="3.2" fill="#7BE0A6" /></svg>;
}
