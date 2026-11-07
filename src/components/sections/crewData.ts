// The six live cards in "A few that people are using right now." Each one is a teammate from
// src/content/crew.ts doing a job on its own. `beats` are the ms offsets where the card's window
// moves one step forward; the last beat is the finished state (what reduced motion shows).

export type Tone = "run" | "ok" | "warn";

export type Live = {
  agent: string;
  window: string;
  trigger: string;
  title: string;
  body: string;
  tools: [string, string, string];
  beats: number[];
  clock: string[];
  status: { label: string; tone: Tone }[];
  receipt: string;
  // The rubber stamp that thumps onto the window when the job is done.
  stamp: { label: string; tone: "ember" | "moss" | "ink" };
};

export const live: Live[] = [
  {
    agent: "boo",
    window: "Incident · checkout",
    trigger: "Noticed 500s at 3:12 AM",
    title: "Wakes you only if it matters.",
    body: "Watches the alerts overnight, finds the cause, and has the fix ready when you look.",
    tools: ["sentry", "datadog", "linear"],
    beats: [500, 1500, 2600, 3700, 4500],
    clock: ["3:12 AM", "3:12 AM", "3:13 AM", "3:14 AM", "3:15 AM", "3:15 AM"],
    status: [
      { label: "Running", tone: "run" },
      { label: "Running", tone: "run" },
      { label: "Running", tone: "run" },
      { label: "Running", tone: "run" },
      { label: "Running", tone: "run" },
      { label: "Needs Sam", tone: "warn" },
    ],
    receipt: "qwen3.8-27b · deepinfra · $0.0061",
    stamp: { label: "Needs Sam", tone: "ember" },
  },
  {
    agent: "sprout",
    window: "Weekly numbers",
    trigger: "Every Monday, 9:00 AM",
    title: "Tells you what actually moved.",
    body: "Reads PostHog and Analytics before standup and posts the numbers that changed.",
    tools: ["posthog", "google-analytics", "stripe"],
    beats: [500, 1400, 2900, 3800],
    clock: ["9:00 AM", "9:00 AM", "9:01 AM", "9:01 AM", "9:02 AM"],
    status: [
      { label: "Reading", tone: "run" },
      { label: "Reading", tone: "run" },
      { label: "Charting", tone: "run" },
      { label: "Charting", tone: "run" },
      { label: "Posted", tone: "ok" },
    ],
    receipt: "deepseek-v4.1-flash · deepinfra · $0.003",
    stamp: { label: "Posted", tone: "moss" },
  },
  {
    agent: "snap",
    window: "pr-482.preview",
    trigger: "After every deploy",
    title: "Clicks through every page.",
    body: "Opens the preview on phone and desktop, screenshots each page, and files what broke.",
    tools: ["vercel", "linear", "figma"],
    beats: [400, 800, 1200, 1600, 2000, 2400, 2800, 3200, 4000],
    clock: ["2:40 PM", "2:40 PM", "2:40 PM", "2:41 PM", "2:41 PM", "2:41 PM", "2:42 PM", "2:42 PM", "2:42 PM", "2:43 PM"],
    status: [
      ...Array.from({ length: 9 }, () => ({ label: "Testing", tone: "run" as const })),
      { label: "1 broke", tone: "warn" },
    ],
    receipt: "kimi-k3 · fireworks · $0.0094",
    stamp: { label: "Filed", tone: "ember" },
  },
  {
    agent: "ledger",
    window: "Reconcile · Nov",
    trigger: "Every night, 11:00 PM",
    title: "Closes the books overnight.",
    body: "Matches every Stripe charge to an invoice in QuickBooks and flags the ones that don't.",
    tools: ["stripe", "quickbooks", "gmail"],
    beats: [400, 1700, 2300, 2900, 3700],
    clock: ["11:00 PM", "11:00 PM", "11:01 PM", "11:01 PM", "11:02 PM", "11:02 PM"],
    status: [
      { label: "Matching", tone: "run" },
      { label: "Matching", tone: "run" },
      { label: "Matching", tone: "run" },
      { label: "Matching", tone: "run" },
      { label: "Matching", tone: "run" },
      { label: "Done", tone: "ok" },
    ],
    receipt: "deepseek-v4.1-flash · deepinfra · $0.001",
    stamp: { label: "Matched", tone: "moss" },
  },
  {
    agent: "whisk",
    window: "Support inbox",
    trigger: "When a ticket arrives",
    title: "Sorts the inbox before you open it.",
    body: "Reads each new ticket, tags it, and hands it to the right person with the context.",
    tools: ["zendesk", "intercom", "notion"],
    beats: [500, 1300, 2100, 2900, 3700],
    clock: ["8:14 AM", "8:14 AM", "8:15 AM", "8:15 AM", "8:16 AM", "8:16 AM"],
    status: [
      { label: "Sorting", tone: "run" },
      { label: "Sorting", tone: "run" },
      { label: "Sorting", tone: "run" },
      { label: "Sorting", tone: "run" },
      { label: "Sorting", tone: "run" },
      { label: "Done", tone: "ok" },
    ],
    receipt: "qwen3.8-27b · deepinfra · $0.0008",
    stamp: { label: "Sorted", tone: "moss" },
  },
  {
    agent: "recall",
    window: "Notion · Pricing FAQ",
    trigger: "Noticed a change in #sales",
    title: "Keeps the wiki true.",
    body: "When a thread changes a decision, it edits the page and links back to the thread.",
    tools: ["notion", "slack", "confluence"],
    beats: [500, 1500, 2500, 3500],
    clock: ["4:52 PM", "4:52 PM", "4:53 PM", "4:53 PM", "4:54 PM"],
    status: [
      { label: "Reading", tone: "run" },
      { label: "Reading", tone: "run" },
      { label: "Editing", tone: "run" },
      { label: "Editing", tone: "run" },
      { label: "Updated", tone: "ok" },
    ],
    receipt: "deepseek-v4-pro · nebius · $0.0047",
    stamp: { label: "Updated", tone: "ink" },
  },
];
