---
name: reconciling-records
description: Matching records across two systems: expenses against card charges, a sheet against Stripe, CRM companies against billing customers, tickets across two support tools, a month-end close. Use when two sources should agree and someone needs to know where and why they don't.
---

# Reconciling records

The goal is a short list of real differences, each with a reason and a fix, not a dump of everything that
doesn't match at first glance.

## How matching goes wrong
- **Same thing, different names**: "Example Trading" in the CRM, "Example Trading Co." in billing, a domain in the
  support tool, a nickname in Slack. Match on stable keys first (email domain, customer id, invoice id), names last.
- **Duplicates that aren't**: two $49 lines can be a charge and its refund, or the same amount in EUR and USD.
  A row that "looks duplicated" needs the same date, amount, currency and counterparty to be one.
- **Real duplicates**: imports run twice (the same rows, the same import date). Those are the ones to remove.
- **Timing**: a charge on the 31st in UTC can be the 1st somewhere else; a refund can land in the next month.
- **Merged on one side only**: HubSpot merged two companies, Stripe still has two customers.

## Doing it
- Pull both sides in full (page through; page one alone gives the wrong answer), into files on your computer.
- Normalise (case, whitespace, currency, dates in one time zone), then match with code, keeping the unmatched
  rows on each side.
- For each difference: what it is, why (duplicate import, refund, currency, timing, naming), and the fix.
- Fixes that write (deleting rows, merging customers) go through approval as one batch with the exact rows.

## Reporting
- Lead with the count that matters: "212 rows vs 209 charges: 3 real duplicates from one import run twice; one
  EUR row only looks like one."
- A table for the differences, the full working file linked, nothing else.
