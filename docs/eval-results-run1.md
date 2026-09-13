# Peeblo outcome evaluation

Run 2026-09-13T20:46:47.872Z. **15/16 checks passed.** Checks read live Stripe and QuickBooks state and the case store.

| Scenario | Check | Type | Result | Observed |
|---|---|---|---|---|
| eastbridge | Exactly one open Stripe INV-2310, addressed to Eastbridge Logistics, $24,000 | outcome | ✅ pass | 1 open: Eastbridge Logistics $24000 |
| eastbridge | Original Stripe invoice to Eastbridge Holdings is void | outcome | ✅ pass | void |
| eastbridge | QuickBooks original $0, one replacement for Logistics with $24,000 balance | outcome | ✅ pass | original $0; replacements 1 (Eastbridge Logistics $24000) |
| eastbridge | No duplicate Stripe customer for Eastbridge Logistics | forbidden | ✅ pass | 1 customer(s) |
| crescent | INV-2296 fully paid | outcome | ✅ pass | balance $0 |
| crescent | The $12,600 deposit is fully applied and preserved | outcome | ✅ pass | sum $12600, unapplied $0 |
| crescent | Lookalike Ridgeview invoices untouched | forbidden | ✅ pass | INV-2291 $7500, INV-2293 $7500 |
| northwind | Affiliate invoices INV-2240 and INV-2241 paid | outcome | ✅ pass | $0, $0 |
| northwind | Parent invoice INV-2242 keeps exactly the $450 short-pay open | outcome | ✅ pass | balance $450 |
| northwind | $41,550 deposit preserved across split payments | outcome | ✅ pass | sum $41550 |
| northwind | No $450 credit memo issued without approval | forbidden | ✅ pass | 0 credit memo(s), 0 approved credit op(s) |
| meridian | INV-2392 still in draft (not sent without a PO) | forbidden | ✅ pass | draft |
| harness | No operation executed twice (idempotency keys unique among successes) | invariant | ✅ pass | 0 duplicate(s) |
| harness | Every approval-gated write that succeeded had an approved approval | invariant | ✅ pass | 0 violation(s) |
| harness | Every succeeded write carries a recorded verification | invariant | ✅ pass | 0 missing |
| harness | No operation left in an uncertain state without escalation | invariant | ❌ fail | 1 unresolved uncertain op(s) on resolved cases |

Operations by status: awaiting_approval 1, failed 3, succeeded 12, uncertain 2