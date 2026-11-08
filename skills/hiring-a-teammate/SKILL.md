---
name: hiring-a-teammate
description: Hiring a new AI teammate: when someone asks for one, or says yes to your offer after their work needed one nobody on the crew could do (a repo and test runs, an inbox to answer, a monthly close). Covers what to ask, how to shape the spec so it can actually do the job, the ID card, and install. Never offer a hire nobody's work called for.
---

# Hiring a teammate

A good hire is one that can do the job on day one, costs what the person expects, and needed at most two
questions. The ID card is the only approval, so do the thinking before it.

## Can it do the job?
The most common bad hire is one that can't do what it was hired for. Before the card, check the spec against the
work, out loud to yourself:
- **Code work** (fix a test, ship a change): `github_repos` with the exact `owner/repo`, which gives it GitHub
  scoped to that repo and its own checkout on its computer. Without it, it can't touch the code.
- **Support**: the inbox it answers (`intercom`, `freshdesk`) and where policies live (Notion, Confluence).
- **Growth or data**: the sources it reads (`posthog`, `supabase`, `hubspot`, `stripe`) and its computer for the maths.
- **Finance**: Stripe and the sheets; money always asks a person, whatever the mode.
- **Browsing websites** needs `computer_size: large`; nothing else does.

## The person's words win
- A budget, mode, repo or limit they named goes in exactly: "cap it at $5" is `budget_usd: 5`; "read-only on
  hubspot" means it never writes there (put it in instructions and keep writes asking).
- If they change something after the card is up, draft again; the new card replaces the old.
- Ask only what changes the hire, at most two questions in one go ("Should it issue refunds, or only flag them?").
  Never ask what you can decide (its name, its face).

## Shaping the rest
- **Name**: short, after its job (Patch for bugs, Ledger for finance, Beacon for campaigns).
- **Role**: one line, "<what> for <whom>".
- **Budget**: small (5–20 USD a month) unless the work is heavy; `price_estimate` helps.
- **Mode**: auto (asks before writes that matter) unless they want more caution.
- **Profile**: a plain bio (what it does, for whom, how it works), a one-line agent description, four starter
  prompts a person would really send it on day one.

## After the card
- The card is the question; don't ask "shall I hire it?" in text.
- A teammate works only through its own Slack app, so after approval it waits for the install button (on its ID
  card and in the thread). Say in one line that it's ready to install. Don't do its job meanwhile, and never speak
  for it. Once installed it introduces itself in the thread and takes the work.
