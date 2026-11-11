import { agentByName, extraPhotos, people } from "@/content/crew";
import { integrationById } from "@/content/integrations";

// Fallback marks downloaded from the source sites (the shared library has no Google Sheets or Pi).
const svcSrc: Record<string, string> = {
  slack: "/logos/slack.svg",
  hubspot: "/logos/hubspot.svg",
  posthog: "/logos/posthog.svg",
  sheets: "/integrations/google-sheets.svg",
  drive: "/logos/google-drive.svg",
  github: "/logos/github.svg",
  notion: "/logos/notion.svg",
  linear: "/logos/linear.svg",
  xero: "/logos/xero.svg",
  stripe: "/logos/stripe.svg",
  gmail: "/logos/gmail.svg",
  zendesk: "/logos/zendesk.svg",
  intercom: "/logos/intercom.svg",
  figma: "/logos/figma.svg",
  jira: "/logos/jira-color.svg",
  pi: "/logos/tile-pi.svg",
};

export const svcName: Record<string, string> = {
  slack: "Slack",
  hubspot: "HubSpot",
  posthog: "PostHog",
  sheets: "Google Sheets",
  drive: "Google Drive",
  github: "GitHub",
  notion: "Notion",
  linear: "Linear",
  xero: "Xero",
  stripe: "Stripe",
  gmail: "Gmail",
  zendesk: "Zendesk",
  intercom: "Intercom",
  figma: "Figma",
  jira: "Jira",
  pagerduty: "PagerDuty",
  grafana: "Grafana",
};

const libId: Record<string, string> = { drive: "google-drive", sheets: "google-sheets" };

// Prefer the shared integration library in public/integrations.
export const svc = (id: string) => integrationById(libId[id] ?? id)?.src ?? svcSrc[id] ?? svcSrc.slack;

// Everyone who can post in the Slack mocks: the six named teammates plus the extra portraits.
const extras: Record<string, { name: string; photo: string }> = Object.fromEntries(
  extraPhotos.map((src) => {
    const id = src.split("/").pop()!.replace(".jpg", "");
    return [id, { name: id[0].toUpperCase() + id.slice(1), photo: src }];
  }),
);

export function human(id: string) {
  const p = people[id];
  if (p) return { name: p.name, photo: p.photo };
  return extras[id] ?? { name: id, photo: extraPhotos[0] };
}

export const allPhotos = [...Object.values(people).map((p) => p.photo), ...extraPhotos];

// The receipt line every teammate signs its answer with.
export function receipt(agent: string, via: string, calls: number, cost: string, fallback = "no fallback") {
  const model = agentByName(agent)?.model ?? "deepseek-v4.1-flash";
  return `receipt · ${model} · via ${via} · ${calls} call${calls === 1 ? "" : "s"} · ${fallback} · ${cost}`;
}

export const avatarOf = (agent: string) => agentByName(agent)?.avatar ?? "sprout";

