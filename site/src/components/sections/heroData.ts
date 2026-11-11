import { receipt } from "./shared";

// The hero Slack window plays these. Each channel has a few people asking different teammates;
// each thread is one or more teammate replies that work through steps, then answer with a receipt.

export type Rich = (string | { link: string })[];

export type Step = {
  verb: string;
  svc: string;
  result: string;
  // A write step waits for a person to approve it first.
  write?: { who: string; what: string; price: string };
};

export type Reply = { agent: string; steps: Step[]; answer: Rich; receipt: string };

export type Thread = { who: string; time: string; agent: string; ask: string; replies: Reply[] };

export type Channel = {
  id: string;
  name: string;
  members: number;
  tools: string[];
  filler: { who: string; time: string; text: string }[];
  threads: Thread[];
};

export const channels: Channel[] = [
  {
    id: "general",
    name: "general",
    members: 24,
    tools: ["hubspot", "xero", "drive", "github"],
    filler: [
      { who: "theo", time: "9:12 AM", text: "Standup moves to 10:30 today." },
      { who: "rosa", time: "9:20 AM", text: "New homepage drafts are in Figma if anyone wants a look." },
    ],
    threads: [
      {
        who: "maya",
        time: "9:41 AM",
        agent: "sprout",
        ask: "which Q4 renewals are at risk?",
        replies: [
          {
            agent: "sprout",
            steps: [
              { verb: "Read HubSpot", svc: "hubspot", result: "18 Q4 renewals" },
              { verb: "Read PostHog", svc: "posthog", result: "Halden usage down 40%" },
              {
                verb: "Updated Google Sheets",
                svc: "sheets",
                result: "Renewal save plans",
                write: { who: "maya", what: "Edits 1 sheet · Renewal save plans", price: "≈ $0.002" },
              },
            ],
            answer: [{ link: "Halden" }, ", ", { link: "Northwind" }, " and ", { link: "Acme" }, " are at risk. Save plans are in the sheet."],
            receipt: receipt("sprout", "deepinfra", 3, "$0.0042"),
          },
          {
            agent: "warden",
            steps: [{ verb: "Checked with a second model", svc: "hubspot", result: "3 of 3 hold up" }],
            answer: ["Numbers match HubSpot. Safe to share with the team."],
            receipt: receipt("warden", "together", 1, "$0.0019"),
          },
        ],
      },
      {
        who: "priya",
        time: "9:41 AM",
        agent: "ledger",
        ask: "reconcile October expenses with the card feed",
        replies: [
          {
            agent: "ledger",
            steps: [
              { verb: "Read Xero", svc: "xero", result: "212 expenses" },
              { verb: "Read Stripe", svc: "stripe", result: "209 card charges" },
              {
                verb: "Updated Xero",
                svc: "xero",
                result: "3 duplicates removed",
                write: { who: "priya", what: "Writes 3 entries in Xero", price: "≈ $0.003" },
              },
            ],
            answer: ["209 match the card feed. ", { link: "3 duplicates" }, " from the Oct 14 import are gone."],
            receipt: receipt("ledger", "deepinfra", 4, "$0.0061"),
          },
        ],
      },
      {
        who: "jun",
        time: "9:42 AM",
        agent: "recall",
        ask: "find the latest brand guide",
        replies: [
          {
            agent: "recall",
            steps: [
              { verb: "Searched Notion", svc: "notion", result: "Brand guide v3" },
              { verb: "Checked Google Drive", svc: "drive", result: "brand-guide-v3.pdf" },
            ],
            answer: [{ link: "Brand guide v3" }, " is the latest. It replaced v2 on Oct 28, after the logo change."],
            receipt: receipt("recall", "fireworks", 2, "$0.0024"),
          },
        ],
      },
      {
        who: "sam",
        time: "9:42 AM",
        agent: "ship",
        ask: "what shipped this week?",
        replies: [
          {
            agent: "ship",
            steps: [
              { verb: "Read GitHub", svc: "github", result: "14 merged PRs" },
              { verb: "Read Linear", svc: "linear", result: "9 issues closed" },
            ],
            answer: ["Faster checkout, the new invoice page and ", { link: "12 bug fixes" }, ". Draft release notes are below."],
            receipt: receipt("ship", "novita", 2, "$0.0009"),
          },
        ],
      },
    ],
  },
  {
    id: "eng",
    name: "eng",
    members: 11,
    tools: ["github", "grafana", "pagerduty", "linear"],
    filler: [
      { who: "kofi", time: "10:02 AM", text: "Staging is back up." },
      { who: "ben", time: "10:05 AM", text: "Reviewing the search PR after lunch." },
    ],
    threads: [
      {
        who: "sam",
        time: "10:14 AM",
        agent: "patch",
        ask: "checkout.spec fails about 1 run in 5. Find out why.",
        replies: [
          {
            agent: "patch",
            steps: [
              { verb: "Ran checkout.spec", svc: "github", result: "40 runs, 8 failures" },
              { verb: "Read the logs", svc: "github", result: "Race in cart.ts" },
              {
                verb: "Opened a pull request",
                svc: "github",
                result: "#214 Wait for cart",
                write: { who: "sam", what: "Opens 1 pull request on acme/web", price: "≈ $0.01" },
              },
            ],
            answer: ["Fixed in ", { link: "#214" }, ". 40 of 40 runs pass now."],
            receipt: receipt("patch", "fireworks", 6, "$0.0118"),
          },
          {
            agent: "warden",
            steps: [{ verb: "Read the diff with a second model", svc: "github", result: "1 file, 4 lines" }],
            answer: ["The fix is small and safe to merge."],
            receipt: receipt("warden", "together", 1, "$0.0021"),
          },
        ],
      },
      {
        who: "kofi",
        time: "10:16 AM",
        agent: "rep",
        ask: "load-test the release before Friday",
        replies: [
          {
            agent: "rep",
            steps: [
              { verb: "Ran a load test on staging", svc: "grafana", result: "2,000 users" },
              { verb: "Compared with last release", svc: "grafana", result: "p95 up 12%" },
            ],
            answer: ["Holds at 2,000 users. p95 is ", { link: "12% slower" }, ", from the new search."],
            receipt: receipt("rep", "deepinfra", 3, "$0.0071"),
          },
        ],
      },
      {
        who: "tara",
        time: "10:19 AM",
        agent: "boo",
        ask: "anything wake-worthy overnight?",
        replies: [
          {
            agent: "boo",
            steps: [{ verb: "Read PagerDuty", svc: "pagerduty", result: "3 alerts" }],
            answer: ["Nothing worth waking you. Two fixed themselves, one is a ", { link: "noisy disk alert" }, "."],
            receipt: receipt("boo", "novita", 1, "$0.0004"),
          },
        ],
      },
    ],
  },
  {
    id: "support",
    name: "support",
    members: 9,
    tools: ["zendesk", "stripe", "intercom", "gmail"],
    filler: [
      { who: "omar", time: "11:00 AM", text: "Queue is quiet. Taking lunch at 12." },
    ],
    threads: [
      {
        who: "ali",
        time: "11:02 AM",
        agent: "ledger",
        ask: "was Dana charged twice? @echo draft the reply once we know.",
        replies: [
          {
            agent: "ledger",
            steps: [
              { verb: "Read Stripe", svc: "stripe", result: "2 charges of $49" },
              { verb: "Read Zendesk", svc: "zendesk", result: "Ticket #8812" },
            ],
            answer: ["Yes. Two $49 charges on Nov 3, 40 seconds apart. The second is a ", { link: "retry bug" }, "."],
            receipt: receipt("ledger", "deepinfra", 2, "$0.0022"),
          },
          {
            agent: "echo",
            steps: [
              {
                verb: "Sent the reply in Gmail",
                svc: "gmail",
                result: "Reply to Dana",
                write: { who: "ali", what: "Sends 1 email from support@acme.com", price: "≈ $0.001" },
              },
            ],
            answer: ["Sent in your voice. Dana sees the refund in ", { link: "5–10 days" }, "."],
            receipt: receipt("echo", "together", 1, "$0.0013"),
          },
        ],
      },
      {
        who: "nia",
        time: "11:05 AM",
        agent: "whisk",
        ask: "sort this morning's inbox",
        replies: [
          {
            agent: "whisk",
            steps: [
              { verb: "Read Intercom", svc: "intercom", result: "46 new chats" },
              { verb: "Tagged owners", svc: "intercom", result: "12 for Ali" },
            ],
            answer: ["Sorted 46 chats. ", { link: "3 urgent" }, " ones are pinned for Ali."],
            receipt: receipt("whisk", "novita", 2, "$0.0008"),
          },
        ],
      },
      {
        who: "omar",
        time: "11:09 AM",
        agent: "echo",
        ask: "answer the Halden ticket in my voice",
        replies: [
          {
            agent: "echo",
            steps: [
              { verb: "Read Zendesk", svc: "zendesk", result: "Ticket #8790" },
              {
                verb: "Sent the reply",
                svc: "gmail",
                result: "Reply to Halden",
                write: { who: "omar", what: "Sends 1 email from omar@acme.com", price: "≈ $0.001" },
              },
            ],
            answer: ["Sent from omar@acme.com. A copy is on ", { link: "#8790" }, "."],
            receipt: receipt("echo", "together", 2, "$0.0017"),
          },
        ],
      },
    ],
  },
];

// Playback timing (ms). Every visual state is a pure function of time since the thread opened.
export const T = {
  head: 450,
  firstStep: 900,
  step: 950,
  approveShow: 500,
  cursorIn: 1100,
  press: 1350,
  approved: 1650,
  writeTail: 2300,
  typePerChar: 16,
  receiptGap: 250,
  replyGap: 700,
  hold: 2600,
  introMsg: 520,
};

export const richText = (r: Rich) => r.map((p) => (typeof p === "string" ? p : p.link)).join("");

// Start time of each step plus the end of the reply, relative to the reply's start.
export function replyTimeline(r: Reply) {
  const steps: { start: number; done: number; approveAt?: number }[] = [];
  let t = T.firstStep;
  for (const s of r.steps) {
    if (s.write) {
      steps.push({ start: t, approveAt: t + T.approveShow, done: t + T.writeTail });
      t += T.writeTail + 200;
    } else {
      steps.push({ start: t, done: t + T.step - 250 });
      t += T.step;
    }
  }
  const answerAt = t;
  const typed = richText(r.answer).length * T.typePerChar;
  const receiptAt = answerAt + typed + T.receiptGap;
  return { steps, answerAt, typed, receiptAt, end: receiptAt + 400 };
}

export function threadTimeline(th: Thread) {
  let t = T.head;
  const replies = th.replies.map((r) => {
    const tl = replyTimeline(r);
    const start = t;
    t = start + tl.end + T.replyGap;
    return { start, ...tl };
  });
  return { replies, end: t + T.hold };
}
