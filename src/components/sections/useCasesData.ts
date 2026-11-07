import { receipt } from "./shared";

// One tab per job family, each owned by a teammate from the crew.
export type UseCase = {
  tab: string;
  icon: "search" | "pen" | "code" | "chart" | "sprout" | "brush";
  agent: string;
  title: string;
  body: string;
  tools: string[];
  channel: string;
  thread: { who: string; time: string; text: string }[];
  asker: string;
  ask: string;
  answer: string;
  receipt: string;
  // Monthly AI budget its owner gave it, shown on its hiring badge.
  budget: string;
};

export const useCases: UseCase[] = [
  {
    tab: "Research & answers",
    icon: "search",
    agent: "scout",
    title: "Research & answers",
    body: "Hire a researcher for your team. It reads your docs, old threads and the web, then comes back with sources.",
    tools: ["notion", "drive"],
    channel: "product",
    thread: [
      { who: "theo", time: "10:14 AM", text: "Should SSO make the Q4 roadmap?" },
      { who: "ben", time: "10:18 AM", text: "Sales keeps asking for it." },
      { who: "nia", time: "10:21 AM", text: "How many customers, though?" },
    ],
    asker: "theo",
    ask: "how many customers asked for SSO this year?",
    answer: "31 accounts asked, 9 of them over $20k a year. Sources: 44 HubSpot notes and 12 support tickets.",
    receipt: receipt("scout", "together", 5, "$0.0063"),
    budget: "$5/mo",
  },
  {
    tab: "Writing",
    icon: "pen",
    agent: "echo",
    title: "Writing",
    body: "Hire a writer that drafts replies, briefs and posts in your team's voice. You read it, then you press send.",
    tools: ["gmail", "zendesk"],
    channel: "support",
    thread: [
      { who: "ali", time: "2:02 PM", text: "Halden wants a refund for Tuesday's outage." },
      { who: "omar", time: "2:05 PM", text: "We owe them a real apology, not a template." },
    ],
    asker: "ali",
    ask: "draft the apology to Halden and offer a month free",
    answer: "Draft is ready: \"Hi Mara, Tuesday's outage was on us, and I'm sorry. Your next month is free.\" Send it?",
    receipt: receipt("echo", "together", 1, "$0.0011"),
    budget: "$3/mo",
  },
  {
    tab: "Engineering",
    icon: "code",
    agent: "patch",
    title: "Engineering",
    body: "Hire an engineer that reruns the flaky test until it breaks, finds out why, and opens the fix for review.",
    tools: ["github", "linear"],
    channel: "eng",
    thread: [
      { who: "kofi", time: "4:40 PM", text: "checkout.spec failed on main again." },
      { who: "sam", time: "4:41 PM", text: "Third time this week." },
    ],
    asker: "sam",
    ask: "find out why checkout.spec is flaky",
    answer: "Checkout renders before the cart loads in about 1 run in 5. The fix is in #214 and waits for your approval.",
    receipt: receipt("patch", "fireworks", 6, "$0.0118"),
    budget: "$12/mo",
  },
  {
    tab: "Data & analytics",
    icon: "chart",
    agent: "hex",
    title: "Data & analytics",
    body: "Hire an analyst that answers data questions in plain words and shows the query it ran.",
    tools: ["posthog", "sheets"],
    channel: "data",
    thread: [
      { who: "maya", time: "11:30 AM", text: "Did the new pricing page help?" },
      { who: "priya", time: "11:32 AM", text: "Signups look up, but I'm not sure." },
    ],
    asker: "maya",
    ask: "compare trial signups before and after the pricing change",
    answer: "Trials are up 18% in the 14 days after the change: 412 against 349. The query is in the thread.",
    receipt: receipt("hex", "fireworks", 3, "$0.0047"),
    budget: "$6/mo",
  },
  {
    tab: "Onboarding",
    icon: "sprout",
    agent: "tend",
    title: "Onboarding",
    body: "Hire an onboarding buddy that gets new people through week one, one checklist at a time.",
    tools: ["notion", "slack"],
    channel: "people",
    thread: [
      { who: "priya", time: "9:05 AM", text: "Tara starts on Monday." },
      { who: "theo", time: "9:07 AM", text: "Make sure she has a laptop and all her accounts." },
    ],
    asker: "priya",
    ask: "set up Tara's first week",
    answer: "Checklist is ready: laptop on Friday, 6 accounts, 3 intro calls. I'll check in with Tara each morning.",
    receipt: receipt("tend", "novita", 2, "$0.0009"),
    budget: "$2/mo",
  },
  {
    tab: "Design",
    icon: "brush",
    agent: "brush",
    title: "Design",
    body: "Hire a design assistant that turns a vague ask into a brief a designer can use.",
    tools: ["figma", "notion"],
    channel: "design",
    thread: [
      { who: "maya", time: "3:12 PM", text: "Can the pricing page pop more?" },
      { who: "jun", time: "3:14 PM", text: "Pop how, though?" },
    ],
    asker: "jun",
    ask: "turn Maya's ask into a brief",
    answer: "Brief: bigger plan names, one plan in focus, a short FAQ under the table. Jun owns it, due Thursday.",
    receipt: receipt("brush", "together", 2, "$0.0026"),
    budget: "$4/mo",
  },
];
