---
name: working-with-numbers
description: Getting numbers right and showing them well: counts, rates, totals, comparisons across sources, weekly figures, funnels, and when to use a table, a chart or a KPI strip (show_data). Use for any answer with numbers in it.
---

# Working with numbers

A number people act on has to be right, defined, and comparable. How it looks comes after.

## Getting it right
- **Compute with code** on your computer or with the source's own query (SQL, HogQL), never in your head.
- **Say the definition** in a few words: "completed signups per person, Nov 2–8 UTC, test rows excluded".
- **People, not events**, unless events are the question. Events double-fire (PostHog fires `signup_completed`
  twice on iOS), bots inflate starts (`HeadlessChrome`), internal test rows (`test+…`, `@acme.example`) pollute.
- **Time windows are traps**: "last week" is the last full week; time zones move late-Sunday rows across the
  boundary; test-clock charges can be dated in the future. Name the window you used.
- **Currencies don't add**: EUR and USD separately, or convert with a stated rate.
- **Sources disagree for reasons**: HubSpot ARR is contract value, Stripe MRR is after discounts and refunds, a
  finance sheet may be in EUR. Reconcile before you report, or say which you used and why.
- A surprising number is a reason to check, not to report. Re-run the query; look at a few raw rows.
- **If one source refuses, get the number another way** before you call it missing. MRR when Stripe's analytics
  won't answer: list active subscriptions (`stripe_api_read`) and add them up on your computer, per currency.
- **Say what you did, not the plumbing**: "Stripe wouldn't give me MRR directly, so I added it up from
  subscriptions." Never name keys, scopes or permissions in a reply.

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
