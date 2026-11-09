---
name: working-with-numbers
description: Getting numbers right and showing them well: counts, rates, totals, comparisons across sources, weekly figures, funnels, and when to use a table, a chart or a KPI strip (show_data). Use for any answer with numbers in it.
---

# Working with numbers

A number people act on has to be right, defined, and comparable. How it looks comes after.

## Getting it right
- **Compute with code, never in your head**, where the data is (below).
- **Say the definition** in a few words: "completed signups per person, Nov 2–8 UTC, test rows excluded".
- **People, not events**, unless events are the question. Events can fire twice for one action (check for
  duplicates per person), bots inflate starts (`HeadlessChrome`), internal test rows (`test+…` addresses, your own domain) pollute.
- **Time windows are traps**: "last week" is the last full week; time zones move late-Sunday rows across the
  boundary; test-clock charges can be dated in the future. Name the window you used.
- **Currencies don't add**: EUR and USD separately, or convert with a stated rate.
- **A customer's money is in their billing currency**, from Stripe: their price, their invoices, their credits
  (a customer billed in EUR gets EUR). Quoting them in another currency invites a dispute; convert only to compare, and say so.
- **"Draft a quote" means a quote in Stripe** when Stripe can make one: a draft quote object the customer can
  accept, not only text in Slack. It's a money write, so it goes to its approver.
- **Sources disagree for reasons**: HubSpot ARR is contract value, Stripe MRR is after discounts and refunds, a
  finance sheet may be in EUR. Reconcile before you report, or say which you used and why.
- A surprising number is a reason to check, not to report. Re-run the query; look at a few raw rows.
- **If one source refuses, get the number another way** before you call it missing. MRR when Stripe's analytics
  won't answer: list subscriptions with status active, 8 at a time (bigger pages get cut), following
  `starting_after` until `has_more` is false. The call: `stripe_api_read` with `stripe_api_operation_id`
  "GetSubscriptions" and `parameters` {"status": "active", "limit": 8, "starting_after": "<last id of the page
  before>"} (leave starting_after out for the first page). Each line shows price (in cents), currency, interval, quantity and
  any percent_off: MRR is price × quantity ÷ 100, divided by 12 for yearly, less the discount, summed per currency
  on your computer. Trials aren't MRR.
- **A list that says it's cut or has more isn't the total.** Get every page before you add anything up.
- **Say what you did, not the plumbing**: "Stripe wouldn't give me MRR directly, so I added it up from
  subscriptions." Never name keys, scopes or permissions in a reply.

## Where to run the numbers
- Numbers or a small table in the conversation: `run_code`. Put them in the code; print the answer and its parts.
  "7 seats × 15% of $40 × 3 months + 4 seats × 10% of $25 × 2 months" is one run_code call.
- A small shared CSV or spreadsheet, or a saved result, for a quick exact answer: `run_code` with `files`.
- Big files, a repo, data from several sources to join, or many steps: your computer (`computer_bash`).
- A source that can total it (SQL, HogQL, a Stripe list you page through): ask the source.
- No code: a figure a source already states, a one-step count, words.
The sandbox and your computer share nothing: pass what the next step needs in the call. If run_code fails twice,
do it on your computer.

## When they say "short"
Four lines at most: the numbers on one or two lines, then the top three issues, one line each, linked. No
paragraphs, no dashes as punctuation, nothing they didn't ask for. Detail waits until they ask.

## Showing it
- One or two numbers: in the sentence. "Signups were 418 last week, flat on the week before."
- Two to six headline numbers: a KPI strip (`show_data` kind `kpis`), each with a short note ("up 4%").
- A trend over time or a comparison across a few groups: a chart (`show_data` kind `chart`); bar for categories,
  line for time. Short labels (≤20 characters), one series unless the comparison is the point.
- Seven or more records people will scan or sort: a table (`show_data` kind `table`), numbers as numbers. At most
  3 short columns (the thread pane is narrow): the name, then the one or two numbers or dates that matter. No
  record ids; a name and its owner are enough. Four records or fewer read better as lines in the reply.
- Never repeat in text what the chart or table shows; say what it means.
