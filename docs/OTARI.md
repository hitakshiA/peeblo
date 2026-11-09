# How Peeblo uses Otari

Every model call, gateway tool, connector call, budget and guardrail in Peeblo goes through [Otari](https://otari.ai).
Peeblo holds no provider keys. It holds one Otari service key, and optionally an admin's dashboard session.

```
Slack ─▶ core ─▶ run (DBOS) ─▶ Pi (on the host, no keys)
                                  │  per-session token
                                  ▼
                        Peeblo proxy (loopback) ──▶ hosted Otari ──▶ model providers
                          · swaps the token for a key             · role routing policies
                          · names the person (end user)           · web search / fetch, code sandbox
                          · tags teammate / session / run         · guardrails, budgets, usage
                          · reads receipt headers → events        · MCP servers (connectors)
                                  │
                  Pi extension ───┘ connector tools → policy → approval → /mcp/execute (the teammate's own key)
```

## One wallet, many agents, many people

Peeblo is a crew of agents shared by a whole team, so it leans on the parts of Otari built for that:

- **A key per teammate.** At hire, each teammate gets its own Otari service key with a spend ceiling at its monthly
  budget. Raising the budget in Slack moves the ceiling at once.
- **An end user per person.** Each Slack person is an Otari end user (`slack-<team>-<user>`) on a budget tier, on
  every key that serves them. When Otari refuses for budget, the person gets a sentence with Otari's own numbers,
  and the owner gets a button to raise it.
- **Connector access per teammate.** Each teammate's connector calls run on its own key. Otari holds a grant for
  each server it may write to (every tool, or what the admin allowed Peeblo's key there). A read-only teammate
  gets no grant and falls back to the server's default access, so with that default set to "read tools" Otari
  itself refuses its writes. The console's checklist says which servers still default to every tool.
- **Spend from Otari.** "Who spent what this month" is one read of Otari's org usage summary (by each teammate's
  key, model and end user), with a daily series for a chart.

## The parts

| Part | What it does | Where |
|---|---|---|
| Client and catalog | One client for hosted Otari: region, retries for safe calls, request ids on errors. The catalog with prices, context windows and input types. Price cards count tokens with `/messages/count_tokens`. | `src/otari/client.ts`, `src/otari/catalog.ts` |
| Model proxy | Pi talks to a loopback proxy with a per-session token. The proxy swaps in the teammate's key and adds the end user, `Otari-Conversation-Id`, `Otari-Tags` (teammate, session, run), `session_label` and an idempotency key per attempt. It reads `Otari-Request-ID`, `-Provider`, `-Model`, `-Attempt-Count`, `-Fallback`, `-Guardrails` and the inline `cost_usd` into events. | `src/proxy/relay.ts` |
| Routing | Every agent runs on a routing policy for its role (manager, worker, reviewer, grader, judge, vision, heavy), all open-weight, with Otari's fallback to another family. The heavy role (Kimi K3.1 Pro, for the hard part of a job) steps down to DeepSeek V4.1 Flash once half its key's budget is used (`when: budget_used_pct`). Worker and manager don't step down: with cached prompts DeepSeek V4.1 Flash is already the cheapest capable model per agent call (we tried gpt-oss-120b as the step-down; with no cache price it cost about 5x more per call and dropped tools). Peeblo creates the policies when an admin connects, and later only the ones whose config changed, so a change an admin makes by talking stays. | `src/otari/routing.ts`, `config/model-tiers.json` |
| Hard parts | For one hard part of a job, an agent can ask Otari's router (`/routing/recommend`) which model fits. If it picks a stronger model, that part runs as a helper on it and the answer comes back; the job itself never switches model. | `src/agent-tools/effort.ts` |
| Receipts | A fold over a job's events and its helpers': models, providers, cost, Otari's fallbacks, web and code calls, connector calls, approvals, which guard checked it, links into the dashboard. A call cut off by a crash is reconciled against Otari's usage record. | `src/receipts.ts` |
| Web | `web_search` uses Otari's direct `/search` when the org has a search tool set up, and otherwise Otari's built-in web search in one small call. `web_fetch` reads one page with `/fetch`. Both are tools the agent picks, limited to each teammate's sites, and their text is screened. | `src/agent-tools/web.ts` |
| Code | `run_code` runs Python with `/code/execute` (no model call), one sandbox per conversation. It can take small files from the teammate's computer (Otari Files, `file_ids`) and returns the files it writes. The model picks it for exact figures in a conversation; files, repos and long work stay on the teammate's own computer. | `src/agent-tools/web.ts`, `skills/working-with-numbers` |
| Files | `understand_file` reads what a text-only teammate can't: a voice note, a PDF or an image, with the best open model Otari's catalog lists for that input type (`input_modalities`), falling back to the next. The teammate's computer converts audio to wav first. | `src/agent-tools/media.ts` |
| Guardrail | Text from outside the company (tickets, chats, web pages, shared files however they're read, text a person pastes and the agent checks with `check_text`) is screened before a model sees it. Lakera runs at Otari's gateway: Peeblo makes a screening workspace whose org guardrail mandate (block mode) covers only it, and sends the outside text there with its own key, so Otari answers `403 guardrail_violation` for an attack. An open-weight guard model through Otari confirms; text both flag is held back from the model, and the agent tells the person what was held back. Needs no dashboard session after setup. `./peeblo check` runs a live attack and an ordinary email through it. | `src/guard.ts`, `src/proxy/tools.ts`, `src/agent-tools/media.ts` |
| Privacy | When the workspace requires zero data retention (an Otari setting), every role is pinned to a provider the catalog marks zero-retention. `./peeblo check` says whether that's possible before you turn it on. With `PEEBLO_TRACE_CONTENT=keep`, Otari keeps prompts and answers on traces. | `src/otari/routing.ts`, `src/check.ts` |
| Traces | Every call carries `session_label` (teammate · place · first ask), so Otari's Sessions view reads like the Slack thread. Receipts link to each request and to that session. | `src/proxy/relay.ts`, `src/otari/traces.ts` |
| Rule engine | Commands and file access on a teammate's computer are checked with `/hooks/check` against `policies/teammate.yaml`: a required gate refuses, an advisory gate asks a person. | `src/otari/rules.ts`, `policies/` |
| Admin | Keys, budgets, ceilings, routing policies, MCP grants, the guardrail and web search change only with a signed-in Otari admin. An admin connects once from the console; Peeblo keeps only the session cookie, sealed. Without a session, Peeblo links to the right dashboard page and teammates keep their keys. | `src/otari/admin.ts`, `src/otari/links.ts` |
| Search | Embeddings and rerank for memory search (keyword and vector candidates, fused, then reranked). | `src/otari/search.ts` |
| Reviewer gate | In Auto mode, an outward write that isn't money, deletion, shipping or a post outside the thread goes to a typed judge on another model family, which sees only the person's own words, the action and the names of untrusted sources. | `src/reviewer.ts`, `src/otari/decisions.ts` |

## What the agent picks and what code enforces

Teammates are agents: they choose what to do. Code holds only what must always or never happen.

| The agent chooses (tools) | Code enforces |
|---|---|
| `models_list`, `pick_model`, `price_estimate`, `budget_status`, `usage_report` | The open-weight list, who may change a model, and the budget: a call whose estimate goes over the teammate's or the person's budget is refused before it reaches Otari. No other limit stops a job, except a stuck loop. |
| `web_search`, `web_fetch`, `run_code`, `understand_file`, `check_text` | Each teammate's sites; outside text is labelled `<untrusted source=…>` and screened |
| Connector tools (Otari MCP servers) | Risk per call from its arguments, scopes, approval by mode, the teammate's own key and grants, the `server_revision` the tools were listed with |
| `otari_read_setting`, `otari_prepare_change`, `otari_set_web_search`, `otari_set_guardrail`, `otari_set_routing_policy` | Admins only, a person's yes for that one change, then read back from Otari |

`./peeblo check` shows each part as ok or missing, with a live call where it matters.

## Settings

| Variable | Default | |
|---|---|---|
| `OTARI_SERVICE_KEY` | — | Peeblo's key. A service key, so each person can be named and capped. |
| `OTARI_REGION` / `OTARI_BASE_URL` | US | `eu` for Otari's EU region. |
| `OTARI_END_USER_BUDGET_ID` | the key's default tier | The tier new people start on. |
| `PEEBLO_GUARD` | `lakera` | `lakera`, `open` or `off`. |
| `PEEBLO_GUARD_MODEL` | `alibaba/qwen3guard-gen-8b` | The open guard model. |
| `PEEBLO_LAKERA_PROJECT` | — | The Lakera project whose policy the guardrail uses. |
| `PEEBLO_OTARI_CODE` / `PEEBLO_WEB_FETCH` / `PEEBLO_VISION` | `on` | Otari's code sandbox, page reads and vision, offered to agents that may use them. |
| `PEEBLO_TRACE_CONTENT` | `off` | `keep` asks Otari to keep prompts and answers on traces. |
| `PEEBLO_READONLY_SERVERS` | — | MCP servers that only read, whatever their tool names say. |
| `PEEBLO_TEAMMATE_SPEND` | `auto` | `key` (a key per teammate), `tag`, or `auto` (key when an admin session exists). |
| `PEEBLO_ADMINS` | — | Slack user ids who may change Otari settings and approve money by default. |

## Choices we made, and why

- **Lakera screens outside text, not every call.** With Otari's org-wide mandate on Peeblo's own calls, ordinary
  agent requests were refused as attacks: an agent's prompt and tool definitions are full of imperative text. So the
  mandate covers a separate screening workspace, and only outside text goes there. A pasted "refund everyone" email
  and a PDF with an instruction hidden in it were both stopped (score 1).
- **Two guardrails in series.** Lakera's policy flags some marketing pages; an open-weight guard model confirms each
  flag. On 39 real tickets, issues and web pages, nothing harmless was held back.
- **Our own open-weight list.** `/catalog/models` has an `open_weights` flag, but it's wrong for about a quarter of
  the models, so Peeblo keeps a reviewed family list.
- **Routing at the boundary.** A hard part runs as a helper on the routed model, instead of switching a running
  conversation to another model mid-way.
- **No per-job call caps.** Budgets are the limit, enforced by Otari's key ceilings and checked before each call.

## Known limits

- **No management key.** Admin work needs a person's dashboard session (about 7 days). Teammates keep their keys
  when it ends; `./peeblo check` says when to reconnect.
- **End users belong to a key.** A person is an end user on each key that serves them; Otari's org usage adds them
  up by their id.
- **A new routing policy takes about 10 seconds to settle.** Peeblo waits until it answers several times in a row.
- **Policy targets need pinned names** (`provider:model`), learned from a one-token call (or from the catalog's
  zero-retention offerings when that's required). Targets are checked when a policy is saved.
- **Audio input takes wav or mp3 only**, and of the two models listing audio, one answers with empty text today.
- **The code sandbox has pandas, numpy, matplotlib and openpyxl, but no PDF library**; PDFs go to a model instead.
- **Direct `/search` needs a search tool** set up in Otari; without one, the built-in web search is used.
- **Gateway tools aren't in the agent's history.** The next turn gets a short note of the web and code calls that ran.
- **Per-request guardrail profiles don't work on hosted Otari** (no guardrails service), so Peeblo uses a workspace-scoped mandate.
- **Connector calls aren't billed per person.** `/mcp/execute` has no end-user field.
- **Trace ids aren't in responses.** Receipts link to the session and to each request.
- **The served-model header names the provider's model id**, not the catalog id; receipts show readable names.
