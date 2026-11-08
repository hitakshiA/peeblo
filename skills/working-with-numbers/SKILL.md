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

## Showing it
- One or two numbers: in the sentence. "Signups were 418 last week, flat on the week before."
- Two to six headline numbers: a KPI strip (`show_data` kind `kpis`), each with a short note ("up 4%").
- A trend over time or a comparison across a few groups: a chart (`show_data` kind `chart`); bar for categories,
  line for time. Short labels (≤20 characters), one series unless the comparison is the point.
- Seven or more records people will scan or sort: a table (`show_data` kind `table`), numbers as numbers.
- Never repeat in text what the chart or table shows; say what it means.
