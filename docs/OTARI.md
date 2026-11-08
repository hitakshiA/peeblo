# How Peeblo uses Otari

Every model call, gateway tool, connector call, budget and guardrail in Peeblo goes through [Otari](https://otari.ai).
Peeblo holds no provider keys. It holds one Otari service key, and optionally an admin's dashboard session.

```
Slack ─▶ core ─▶ run (DBOS) ─▶ Pi (on the host, no keys)
                                  │  per-session token
                                  ▼
                        Peeblo proxy (loopback) ──▶ hosted Otari ──▶ model providers
                          · swaps the token for the key           · web search / fetch
                          · names the person (end user)           · code sandbox
                          · tags teammate / session / run         · org guardrail
                          · reads receipt headers → events        · MCP servers (connectors)
                                  │
                  Pi extension ───┘ connector tools → policy → approval → /mcp/execute
```

## The parts

| Part | What it does | Where |
|---|---|---|
| Client and catalog | One client for hosted Otari: region, retries for safe calls, request ids on errors. The model catalog with prices and context windows, and Peeblo's hand-kept list of open-weight families (the catalog's `/catalog/models` does carry an `open_weights` field; switching to it is a morning item). Cost estimates before a run. | `src/otari/client.ts`, `src/otari/catalog.ts` |
| Model proxy | Pi talks to a loopback proxy with a per-session token. The proxy swaps in the real key and adds the end user, `Otari-Conversation-Id` (the session), `Otari-Tags` (teammate, session, run) and an idempotency key per attempt. It reads `Otari-Request-ID`, `-Provider`, `-Model`, `-Attempt-Count`, `-Fallback`, `-Guardrails` and the inline `cost_usd` into events. | `src/proxy/relay.ts` |
| Receipts | A receipt is a fold over a run's events: models, providers, cost, fallbacks, web and code calls, connector calls, approvals, which guard checked it, and links into the dashboard. A call cut off by a crash is reconciled against Otari's usage record. | `src/receipts.ts` |
| People and budgets | Each Slack person is an Otari end user (`slack-<team>-<user>`) on a budget tier. When Otari refuses a call for budget, the person gets a sentence with Otari's own numbers. | `src/otari/people.ts` |
| Spend per teammate | With a dashboard session, each teammate gets its own service key with a spend ceiling at its monthly budget. Without one, every call is tagged and Peeblo checks spend by tag before a turn. | `src/otari/spend.ts` |
| Routing | A routing policy per role (`peeblo-manager`, `-worker`, `-reviewer`, `-grader`, `-judge`), all open-weight and picked for cost per task, with Otari's fallback inside each; a bigger model for heavy work is opened deliberately, with a price card. A teammate's own fallback model is tried when its first one fails before any output. `/routing/recommend` picks a model for delegated work. | `src/otari/routing.ts`, `src/proxy/relay.ts` |
| Web | `otari_web_search` and `otari_web_fetch`, run by Otari inside the model call, limited to each teammate's allowed and blocked sites. | `src/proxy/relay.ts` |
| Code | `otari_code_execution` in Otari's sandbox. One sandbox per session, kept between turns while Otari holds it. | `src/proxy/relay.ts` |
| Connectors | MCP servers stored in Otari. Peeblo lists a teammate's tools, judges each call's risk from its arguments, asks a person when the teammate's mode says so, then runs exactly that call with `/mcp/execute` and the `server_revision` it listed. A few vendors that Otari can't reach directly are served by a Peeblo bridge that Otari stores as an ordinary server. | `src/connectors/`, `src/proxy/tools.ts`, `src/pi/peeblo-tools.ts` |
| Guardrail | One setting, `PEEBLO_GUARD`: Otari's org guardrail (Lakera, the default), an open guard model through Otari chat, or off. Only one runs, and the receipt names it. A refused message is removed from the teammate's history so the thread keeps working. | `src/guard.ts` |
| Rule engine | Commands and file access on a teammate's computer are checked with `/hooks/check` against `policies/teammate.yaml`: a required gate refuses, an advisory gate asks a person. | `src/otari/rules.ts`, `policies/` |
| Admin | Keys, budgets, spend ceilings, routing policies, the guardrail switch, MCP servers and web search can only be changed by a signed-in Otari admin. An admin can sign Peeblo in once; Peeblo keeps only the session cookie, sealed. Without a session, Peeblo links to the right dashboard page. | `src/otari/admin.ts`, `src/otari/links.ts` |
| Search | Embeddings and rerank for memory search (keyword and vector candidates, fused, then reranked). When rerank is unavailable, the fused order stands. | `src/otari/search.ts`, `src/agent-tools/memory.ts` |
| Vision | A large teammate's `look` asks one question about a screenshot through the `peeblo-vision` routing policy (Nemotron 3.5 Super VL, Qwen3-VL as fallback) and returns text. | `src/agent-tools/browser.ts` |
| Reviewer gate | In Auto mode, an outward write that isn't money, deletion, shipping or a post outside the thread goes to a typed judge (the judge policy, another model family than the worker), which sees only the person's own words, the action and the names of untrusted sources. | `src/reviewer.ts` |
| Decisions | Typed yes/no, choice and score questions. Uses `/decisions` when the deployment has a decision provider, and otherwise the judge policy with a strict JSON schema; it switches by itself when a provider appears. | `src/otari/decisions.ts` |
| Traces | Otari groups a session's calls into one trace named after the session. Receipts link to each request and to that trace. | `src/otari/traces.ts` |

## What the agent picks up and what the harness enforces

Teammates are agents: they choose what to do. Code holds only what must always or never happen.

| The agent chooses (tools) | Code enforces |
|---|---|
| `models_list`, `routing_recommend`: which model fits work that's about to start, by tier, cost per task and speed (`config/model-tiers.json`) | The open-weight allowlist, who may change a teammate's model, and that it changes at a session boundary (or now, with a note) |
| `price_estimate`, `budget_status` | The proxy refuses a call whose estimate goes over the teammate's budget or the person's tier, before it reaches Otari |
| `otari_read_setting`, `otari_prepare_change` | — |
| `otari_set_web_search`, `otari_set_guardrail`, `otari_set_routing_policy` | Admins only, always a person's yes for that one change, then read back from Otari |
| `web_search` (Otari's, in the call), `web_fetch` (Otari's `/fetch`), code execution | Each teammate's sites; page text and connector results are labelled `<untrusted source=…>` and screened by the guard, which adds a warning when it flags something |
| Connector tools (Otari MCP servers) | Risk per call from its arguments, repo scopes, approval by mode (a lower mode applies at once), writes one at a time, the `server_revision` the tools were listed with |

Not agent tools: the guardrail itself, receipts, budgets and caps, the rule engine, and **typed judges** (`decisions.ts`). Judges are classifiers that code calls at fixed points (the reviewer gate, the Stop check, routine pre-filters, the input guard); they answer `{value, reason}` or unknown, are validated and retried once, and fall back to the caller's safe default.

A session's tool list is fixed when it starts. Modes change what the gate allows, never which tools exist.

`./peeblo check` shows each part as on, off or missing. `scripts/otari-check/` has a live check per part (they spend a few cents).

## Settings

| Variable | Default | |
|---|---|---|
| `OTARI_SERVICE_KEY` | — | Peeblo's key. A service key, so each person can be named and capped. |
| `OTARI_REGION` / `OTARI_BASE_URL` | US | `eu` for Otari's EU region. |
| `PEEBLO_GUARD` | `lakera` | `lakera`, `open` or `off`. |
| `PEEBLO_GUARD_MODEL` | `alibaba/qwen3guard-gen-8b` | The open guard model. |
| `PEEBLO_LAKERA_PROJECT` | — | The Lakera project whose policy the org guardrail uses. Peeblo writes it into Otari's guardrail definition. |
| `PEEBLO_TEAMMATE_SPEND` | `auto` | `key` (a key per teammate), `tag`, or `auto` (key when an admin session exists). |
| `PEEBLO_POLICY_FILE` | `policies/teammate.yaml` | The rule engine's policy. |
| `PEEBLO_ADMINS` | — | Slack user ids who may change Otari settings. |
| `PEEBLO_DECISION_MODEL` | `typesafe:jev-latest` | Used when Otari has a decision provider. |
| `PEEBLO_EMBED_MODEL` / `PEEBLO_RERANK_MODEL` | Qwen3 embedding 0.6B / Qwen3 reranker 8B | For memory search. |

## Known limits

- **No management key.** Admin work needs a person's dashboard session (about 7 days). Peeblo re-asks when it ends and falls back to links.
- **End users belong to a key.** With a key per teammate, a person is a separate end user on each key, so Peeblo adds up their spend across its keys before a turn.
- **No per-request fallback list.** Cross-model fallback lives in routing policies; Peeblo adds its own retry for a teammate's chosen fallback model.
- **A new routing policy takes about 10 seconds to settle.** Right after it's created, calls to it alternate between answers and "unknown model". Peeblo waits until it answers several times in a row before using it.
- **Policy targets and recommend candidates need pinned names** (`provider:model`). Peeblo learns them from a one-token call.
- **Gateway tools aren't in the agent's history.** Pi keeps only the answer, so the next turn gets a short note of the web and code calls that ran.
- **The org guardrail checks the whole input.** A refused message is forked out of the history. Lakera's default policy also refuses ordinary requests (output instructions, multi-step asks), and Otari has no score threshold for it; point the guardrail at a Lakera project with a less sensitive policy (`PEEBLO_LAKERA_PROJECT`), or use the open guard.
- **Streamed responses carry no guardrail verdict.** Receipts use the mandate state Peeblo last read.
- **Command rules match per command segment**, so a rule can't say "piped into a shell". The teammate's VM is the sandbox; the rules catch mistakes.
- **No hosted decision provider** today, so decisions use the judge model.
- **Connector calls aren't billed per person.** `/mcp/execute` has no end-user field.
- **Trace ids aren't in responses.** Finding one needs the dashboard session; without it, receipts link to a search.
- **The served-model header names the provider's model id**, not the catalog id (`deepseek-ai/DeepSeek-V4.1-Flash-1017` for `deepseek/deepseek-v4.1-flash-1017`). Receipts show it as Otari sends it.
- **With a routing policy as the model, the body's `model` is the policy name.** Peeblo reads the served model from `Otari-Model`.
- **`/decisions` refuses an end-user id in `user`.** Peeblo doesn't send one there.
- **A code-sandbox outage refuses the whole chat call.** Peeblo retries that call once without the code tool, so the turn goes on.
- **Rerank can be unavailable for hours.** Memory search falls back to keyword and embedding order.
- **Some vision models always reason**, and no setting turns it off; `look` gives them room (1,500 tokens).
