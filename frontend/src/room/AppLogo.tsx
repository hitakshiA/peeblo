import { siStripe, siQuickbooks, siHubspot, siDropbox, siNotion, siJira } from "simple-icons";

export type AppId = "stripe" | "quickbooks" | "salesforce" | "hubspot" | "dropbox" | "notion" | "slack" | "jira" | "lemma" | "arga" | "peeblo";

export const APPS: { id: AppId; name: string; color: string; role: string }[] = [
  { id: "stripe", name: "Stripe", color: "#635BFF", role: "Invoices" },
  { id: "hubspot", name: "HubSpot", color: "#FF7A59", role: "Conversations" },
  { id: "salesforce", name: "Salesforce", color: "#00A1E0", role: "Accounts" },
  { id: "dropbox", name: "Dropbox", color: "#0061FF", role: "Contracts" },
  { id: "quickbooks", name: "QuickBooks", color: "#2CA01C", role: "Ledger" },
  { id: "notion", name: "Notion", color: "#EDEAE4", role: "Policy" },
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
  if (app === "salesforce" || app === "slack") return <img src={`/images/${app}.svg`} width={size} height={size} alt={meta?.name} style={{ display: "block", objectFit: "contain", filter: mono ? "grayscale(1)" : undefined }} />;
  // Peeblo mark for internal steps
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-label="Peeblo"><circle cx="12" cy="12" r="9" fill="none" stroke="#7BE0A6" strokeWidth="2.2" /><circle cx="12" cy="12" r="3.2" fill="#7BE0A6" /></svg>;
}
