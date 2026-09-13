# Peeblo: system and reliability brief

This brief explains how Peeblo is built, what it guarantees, how each guarantee was tested, and where each one stops. Every claim links to the code or the recorded evidence behind it.

- **Revision:** `main` at the time of writing. Later commits may change details.
- **Model:** `cline-pass/glm-5.3-flash` through the Cline SDK. It can be changed with `PEEBLO_MODEL`.
- **Environment:** real Stripe, QuickBooks, Salesforce, HubSpot, Dropbox, Notion, Slack and Jira **sandbox** accounts, filled with a seeded business ([`seed/`](../seed/)). Fault tests also use an **Arga Stripe twin**.

---

## 1. Summary

- **The job:** fix accounts receivable exceptions, meaning invoices that customers can't or won't pay because something about the billing is wrong.
- **The split:**
  - A language model does the investigation. It decides what to read, what the evidence means, and which correction applies.
  - A deterministic **executor** does every write. It decides whether the change is allowed, who must approve it, whether it already happened, and whether it worked.
- **Where it's strong:**
  - Approvals are bound to the exact change.
  - Proposals with incomplete or invalid inputs are rejected before approval.
  - A write whose response was lost is reconciled before any retry.
  - Multi-step corrections resume where they stopped.
  - Financial writes are verified by re-reading the provider.
- **Where it stops:**
  - Duplicate protection is per case, not global.
  - Verification strength differs by action.
  - The model chooses the final case status.
  - Cross-app corrections are sequential, not atomic.
  - Scheduling runs in a single process.
- **Measured reliability:**
  - 1 of 3 clean-reset trials of the wrong-company case passed.
  - The 2 failures were diagnosed and fixed (section 7).
  - Post-fix trials are recorded in section 7 as they complete.

## 2. Vocabulary

| Term | Meaning here |
|---|---|
| **Bill-to entity** | The legal company an invoice is addressed to. It must match the company that signed the contract, or that company's AP team will reject it. |
| **Cash application** | Matching a payment the business already received to the invoice(s) it pays. |
| **Unapplied cash** | Money received but not yet matched to any invoice. |
| **Short-pay** | A customer paid less than the invoice. The gap stays owed unless someone authorizes a credit. |
| **Payment conservation** | When one payment is split across invoices, the parts must still add up to exactly the amount received. |
| **Exception resolved vs. receivable settled** | Fixing a billing error is not the same as getting paid. Peeblo reports them separately. |
| **Operation** | One requested change, like "void invoice X". It is recorded before anything is sent to an app. |
| **Idempotency key** | A fingerprint of an operation's business meaning, used to recognize the same change when it's asked for again. |

## 3. The example used throughout: the wrong-company invoice

The seeded business sells software seats. One customer group has two legal entities with similar names:

- **Eastbridge Holdings, Inc.** is the parent company.
- **Eastbridge Logistics LLC** is the subsidiary. It signed the contract and pays its own bills.

A $24,000 quarterly invoice was addressed to the parent. The subsidiary's AP team rejected it, so it went overdue. Everything needed to fix it exists, but it's spread out:

| Question | Where the answer is |
|---|---|
| Which invoice, what state? | Stripe (billing) and QuickBooks (ledger) |
| Why wasn't it paid? | An AP rejection email in HubSpot |
| Which company is the right one? | Salesforce account hierarchy, plus the signed order form and W-9 in Dropbox |
| Which billing instructions are current? | Dropbox: an older document says "bill the parent"; the executed newer one says "bill the subsidiary" |
| What is Peeblo allowed to do? | Notion policy: voiding and reissuing an issued invoice needs AR approver approval |

There are also deliberate traps: a lookalike company (*East Bridge Coffee Roasters*) and the parent's own unrelated invoices, which must stay untouched.

**Correct outcome:**
- The wrong invoice is voided in both systems.
- Exactly one replacement is billed to the subsidiary for $24,000.
- Nothing else changes.
- The case ends **waiting for payment**, not "resolved as paid".

## 4. Architecture

![Peeblo agent harness](assets/architecture.svg)

### Who decides what

| Decision | Made by | Where |
|---|---|---|
| Which records to read, in what order | Model | [`tools.ts`](../agent/src/tools.ts): 11 read tools shared by every case |
| What the evidence means (which entity signed, which document is current) | Model | Recorded with `record_evidence` |
| Which correction applies | Model picks from a fixed action registry | [`executor.ts`](../agent/src/executor.ts) `ACTIONS` |
| How a correction is carried out (which API calls, in what order) | **Code** | Each action's `execute` |
| Whether the change needs approval, and whose | **Code** | Each action's `authority` (for example credits: ≤$250 autonomous, ≤$5,000 AR approver, above that CFO) |
| Whether inputs are complete and records exist | **Code** | Required params checked at `propose`; `precheck` re-reads the records |
| Whether the change already happened | **Code** | Idempotency key plus `reconcile` |
| Whether it worked | **Code** | Each action's `verify` re-reads the provider |
| Final case status (resolved, waiting, escalated) | Model | `finish_run` (see limits, section 8) |

This is the core design choice: **the investigation is open-ended, the execution is not.** Peeblo has no per-customer scripts. It does have authored procedures for each kind of financial change. For example, `billing.reissue_to_correct_entity` defines the five ordered steps of a wrong-company correction. The model decides *when* that procedure applies; code decides *how* it runs.

### What persists

Everything a case needs is stored durably (SQLite in WAL mode, [`store.ts`](../agent/src/store.ts)):
- cases
- evidence with its source
- the plan
- operations with their status
- approvals
- scheduled wake-ups
- run history

A model session is disposable. Each new run rebuilds its context from these records, so a case can span days, several runs and an interruption.

## 5. Life of a financial write

Every change the model proposes goes through the same path in `propose()` and `run()`:

1. **Validate inputs.**
   - Required fields are checked against the action's declared parameters.
   - For the wrong-company correction, `precheck` also re-reads the Stripe invoice (it must exist and be open) and the QuickBooks invoice, and checks the email format.
   - If anything is wrong, the proposal is rejected. **Nothing is recorded or sent for approval**, and the agent is told exactly which field to fix.
2. **Identify the change.**
   - The idempotency key hashes case, action and the action's *business identity*. For the reissue, that's the original Stripe invoice, the QuickBooks invoice and the correct legal name.
   - So a later run that words the same request differently maps to the same operation.
   - If that operation already succeeded, the answer is `already_done`.
3. **Check authority.** The action's rule returns `autonomous`, `ar_approver` or `cfo`.
4. **Request approval if needed.**
   - A Slack message shows the exact change and the evidence.
   - The approval stores a fingerprint of action, parameters and amount, and expires after 48 hours.
   - When someone approves, the executor checks that the approval is still pending, the person is a listed approver, it hasn't expired, and the fingerprint still matches.
5. **Record intent, then write.**
   - The operation is marked `submitted` **before** the API call.
   - Stripe calls carry provider-level idempotency keys, and created records are tagged with the operation key.
6. **If the outcome is unknown** (timeout, lost response, process interrupted):
   - The operation stays `submitted` or `uncertain`.
   - The next attempt runs `reconcile`, which searches the provider for the tagged record, before writing anything.
   - If the action has no way to reconcile, the executor refuses to retry blindly and escalates.
7. **Multi-step corrections resume.**
   - The reissue runs as resumable steps: ensure customer, void Stripe, create Stripe replacement, void QuickBooks, create QuickBooks replacement.
   - On resume, each step checks whether it's already done and skips it.
8. **Verify.** The executor re-reads the app and records what it observed. The operation only becomes `succeeded` if verification passes.

![Recovery sequence](assets/recovery.svg)

### How strong is verification, per action?

| Action | What verification re-reads |
|---|---|
| Wrong-company reissue (composite) | Both original invoices void or zeroed; replacements exist in both systems for the correct customer; balances match |
| `stripe.create_invoice`, `qbo.create_invoice` | Total amount **and** customer match the request |
| `stripe.create_credit_note`, `qbo.create_credit_memo` | Amount matches |
| `qbo.apply_payment` | The payment is linked to each target invoice |
| `qbo.allocate_payment_across_customers` | Linked invoices, plus the split parts summing to the original payment (payment conservation) |
| `stripe.void_invoice`, `qbo.void_invoice` | Status is void, or total and balance are $0 |
| `stripe.finalize_invoice`, `stripe.update_draft_invoice` | Invoice status |
| `stripe.create_customer`, `qbo.create_customer` | Record exists and is active |
| `jira.comment`, `jira.create_issue`, `hubspot.log_note` | Record exists |
| `slack.post`, `customer.send_email` | Provider returned an ID. The email is **recorded** as outbound activity in HubSpot, not delivered. |

## 6. What wakes Peeblo, and how events map to cases

| Trigger | Handling |
|---|---|
| Stripe webhook (`invoice.payment_failed`, `invoice.overdue`, `invoice.marked_uncollectible`, `charge.dispute.created`) | Signature verified; deduplicated by Stripe event ID; one case per invoice and event type |
| Scheduled wake-up | Polled every 15s; the due wake-up is marked fired, then its run starts |
| Approval decision | The approved operation executes, then the case resumes |
| Live console | Starts or resumes a case |

**Two layers of deduplication:**
- **Events:** a redelivered webhook is dropped.
- **Operations:** a repeated change is recognized.

An in-memory map prevents two runs of the same case from overlapping *within one process*.

## 7. Evidence

There are three kinds of evidence, and they measure different things.

### 7.1 Agent runs against real sandbox apps

The model investigates on its own; no step is scripted. The test harness [`e2e.ts`](../agent/src/e2e.ts) then:
1. assigns the case
2. lets the agent work until it requests approval
3. approves as the configured approver
4. **arms an interruption** that raises an exception right after the next accepted write
5. starts a new run to resume

Note: this is an injected in-process interruption, not a killed operating-system process.

**Recorded cases** (outcome checks in [`eval-results.md`](eval-results.md)):

| Case | Required outcome | Result |
|---|---|---|
| Wrong-company invoice | Original void in both systems, exactly one replacement to the subsidiary, no duplicate customer | Pass |
| "We already paid" via a management company | $12,600 applied to the right invoice; lookalike customer's invoices untouched | Pass |
| One wire from a parent covering three affiliates, $450 short | Affiliates paid, exactly $450 left open, no credit issued without approval | Pass, after an executor fix: the first run hit a gap, and the agent filed Jira SCRUM-16 instead of forcing a write |
| Renewal without a valid purchase order | Invoice **not** sent; follow-up scheduled | Pass |

**16/16** is the number of passing *checks* on the recorded end state. It is not 16 runs. The first evaluation scored 15/16: it found an operation still marked uncertain on a resolved case, which was then reconciled.

### 7.2 Repeat trials from a clean reset

Each trial:
1. resets the wrong-company scenario ([`seed/scenarios/eastbridge.ts`](../seed/scenarios/eastbridge.ts))
2. runs the full agent flow above
3. re-runs the 4 case checks plus 4 operation-log invariants against live Stripe and QuickBooks

| Trial | Agent time | Checks | What happened |
|---|---|---|---|
| 1 | 15.5 min | **8/8** | Correct entity, approval, interruption after the Stripe replacement, resume skipped completed steps, both systems verified |
| 2 | 6.4 min | **5/8** | The agent's approved proposal had missing record IDs. Execution failed safely: no change was made in any app. The correction never completed. |
| 3 | 3.8 min | **5/8** | Same cause (Stripe invoice ID passed as `undefined`). The agent re-proposed with correct IDs, but that created a *new* operation needing a *new* approval, which the harness didn't grant. |

**Diagnosis:**
- The executor accepted a proposal with incomplete parameters and sent it for approval.
- The approval was then spent on a change that could not run.
- No bad write happened, because the provider calls failed and the invariants held (5/8 are the "nothing wrong changed" checks). But the business outcome was not reached.

**Fix** ([`executor.ts`](../agent/src/executor.ts), commit "validate required params and referenced records before requesting approval"):
- Required parameters are now checked at proposal time.
- The reissue re-reads both invoices before approval.
- Invalid proposals go back to the agent with the specific problem, and nothing is recorded.

**Post-fix trials:** 3 clean-reset trials are running and will be added here.

### 7.3 Deterministic fault tests in an Arga Stripe twin

[`arga-test.ts`](../agent/src/arga-test.ts) points the unmodified executor at an Arga Stripe twin, seeds the wrong-company state, and injects faults. **These test the executor, not the model's investigation.** Pass/fail is read from the twin's own state.

| Fault | How it's injected | Expected | Result |
|---|---|---|---|
| Write accepted, response lost | `PEEBLO_FAULT=lose_response:stripe.create_invoice`: the create succeeds at Stripe, the response is dropped before Peeblo records it | Operation `uncertain`; retry reconciles, finds the created invoice, creates no second one | Pass: exactly one replacement ([log](evidence/arga-stripe-twin-report.json), [recording](evidence/arga-stripe-twin-interrupted-reissue.mp4)) |
| Same event delivered twice | The same Stripe event ID is received twice | Second delivery dropped; one case; one customer | Pass ([log](evidence/arga-stripe-twin-duplicate-and-stale-report.json)) |
| Stale approval | Customer pays the invoice while a void awaits approval | Approved void refused because the invoice is no longer open | Pass (same log) |

**Twin limitation found:** the Stripe twin ignored invoice-item amounts (totals were $0), so dollar-amount checks run in the real Stripe sandbox instead.

## 8. Limits of the current implementation

These are the boundaries a reviewer should know. Each one follows from the design above.

1. **Duplicate protection is per case.** The idempotency key includes the case ID. The same change requested from two independently created cases would not be recognized as a duplicate. Event deduplication reduces how often that happens, but doesn't prevent it.
2. **Re-proposing a failed change needs a new approval.** A corrected proposal has a different business identity, so the earlier approval doesn't carry over. That's intentional, since the approval covered different parameters, but it can leave a case waiting on an approver.
3. **Verification strength varies by action** (table in section 5). Financial writes re-read amounts and associations. Notes, comments and messages only confirm the record exists.
4. **The model sets the final case status.** `finish_run` doesn't block `resolved` while operations are pending or uncertain. The offline evaluator checks this afterward (the invariant "no uncertain operation on a resolved case"), not at close time.
5. **Cross-app corrections are sequential, not atomic.** Stripe can be corrected while QuickBooks is not yet. Recovery continues forward to the intended state; there is no automatic rollback.
6. **Stale-state checks exist for the wrong-company correction (at proposal time) and for a standalone Stripe void (at execution time).** Other actions don't all re-check business preconditions after approval.
7. **Scheduling is single-process.** A wake-up is marked fired before its run starts. If the process dies in between, that wake-up isn't retried automatically.
8. **Interruption testing is in-process.** Killing the process at every internal step, and running concurrent workers, are not tested.
9. **Email is recorded, not delivered.** There is no mail connector.
10. **Repeatability is only partly measured.** One clean trial passed before the fix, two failed; post-fix trials are in progress. Nothing here measures production uptime, time saved or cash collected.

## 9. Observability with Lemma

[`runner.ts`](../agent/src/runner.ts) sends one Lemma trace per run:
- a generation span per model turn (model, tokens, timing)
- a tool span per tool call (input, output, error status)
- a final span with the case status and operation counts

That final span reports the recorded state; it doesn't verify anything itself.

What Lemma's issue detection surfaced, and what changed:

| Lemma issue | Cause | Change |
|---|---|---|
| `read_document used nonexistent path` | Dropbox search indexing lagged, so the agent guessed file paths | `search_documents` falls back to a folder listing so the agent gets real paths |
| `retry_operation repeated without progress` | Precondition failures were treated as uncertain outcomes, so the agent retried them | Precondition failures now return as final (`PreconditionError`) |
| `cross-customer payment application attempted` | The agent tried to apply one customer's payment to another's invoice with a single-customer action | The executor refused. A dedicated `allocate_payment_across_customers` action now requires evidence and conserves the payment total. |

The fixes were made by hand after reading the traces. They are not automatic self-improvement. Peeblo also stores *proposed* lessons separately from *reviewed* ones, and only reviewed lessons are fed into later runs.
