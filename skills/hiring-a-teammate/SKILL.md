---
name: hiring-a-teammate
description: Hire a new AI teammate when someone asks for one ("I need someone to watch our Stripe refunds", "hire a growth analyst"). Use only when a person asked; never offer a hire unprompted.
---

# Hiring a teammate

The person asked for help with a kind of work. Your job is a teammate that fits it, at a fair price, with the
fewest questions. The ID card is the only approval: do the thinking first, then show one finished card.

## 1. Understand the job (at most 2 questions)
- From what they said, work out: what the teammate does, for whom, which tools it needs, how often, and anything
  that must never happen.
- Ask only what changes the hire, at most 2 questions in one `ask_human` call. Good: "Should it be able to issue
  refunds, or only flag them?" Bad: "What should its name be?" (pick one).
- If they gave enough, ask nothing.

## 2. Decide the spec yourself
- **name**: short and friendly, after its job (Ledger for finance, Scout for research, Patch for bugs).
- **role**: one line, "<what> for <whom>".
- **connectors**: only Otari servers it really needs (`crew_status` and the person's words tell you which exist:
  linear, github, posthog, stripe, hubspot, notion, …).
- **tools**: `web` for public pages, `code` for numbers and charts, `computer` for files, repos and scripts.
  Pick `computer_size: large` only if it must click through websites.
- **model**: call `routing_recommend` with the job; take the cheapest that fits. Leave it empty for ordinary work.
- **budget**: start small (5–20 USD a month) unless the job is heavy; `price_estimate` helps.
- **mode**: `auto` (asks before outward writes) unless they asked for more caution (`ask`).
- **instructions**: their words, plus the never-do rules.

## 3. One card
Call `teammate_hire` with the spec. The person sees the ID card and approves once. Don't describe the card first,
and don't ask "shall I hire it?" in text: the card is the question.

## 4. Install, then work
A new teammate works only through its own Slack app, so it does nothing until the person clicks its install
button (it's on the ID card and in the thread). Say in one line: "<Name> is ready. Install it to start working with
it." Don't delegate to it before that, and never do its job yourself or speak for it. Once it's installed it says
so in the thread, and the person can ask it directly.

If someone later asks for, or mentions, a teammate that isn't installed, `delegate` tells you so and puts its
install button in the thread again. Tell them it isn't installed yet; don't do the work yourself.
