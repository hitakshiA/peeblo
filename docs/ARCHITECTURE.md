# Architecture

Peeblo is one Node process ("core"), a Postgres database, a micro-VM per teammate, and a browser console.
Every model call, connector call, budget and guardrail goes through Otari. Peeblo holds no provider keys.

```
            Slack                                   you (loopback or SSH tunnel)
              │ events, clicks                                │
              ▼                                               ▼
   ingress :8787 (public) ──────────▶ core ◀─────────── API + console :7340
                                       │
           sessions, runs, events ◀────┤────▶ DBOS (runs, approvals, schedules) ── Postgres
                                       │
                         Pi (one per live session, on the host, no keys)
                           │ model calls                  │ tool calls
                           ▼                              ▼
                 model proxy :7341 (loopback)      tool gate: rules → reviewer → approval card
                           │                              │
                           └──────────▶ Otari ◀───────────┤
                                (models, MCP, web,        └──▶ the teammate's computer (Gondolin VM)
                                 budgets, guardrails)
```

## A message, start to finish

1. **Slack → a run.** The ingress checks Slack's signature (`src/ingress/slack.ts`).
   `src/slack/inbound.ts` finds the conversation (a DM, or a thread in a channel) and records a submission.
   A submission is idempotent on its request id, so a redelivered event never makes a second run (`src/store/sessions.ts`).
2. **The run is durable.** Each run is a DBOS workflow named by its run id (`src/durable/runs.ts`).
   If core stops mid-run, the run resumes on restart.
3. **Pi does the turn.** `src/pi/sessions.ts` keeps one Pi process per live session; `src/pi/supervisor.ts` runs the turns.
   Pi gets a per-session token, never an Otari key.
4. **Model calls go through the proxy.** `src/proxy/relay.ts` swaps the token for the teammate's Otari key,
   names the paying person, tags teammate, session and run, checks the budget, and records each call as an event.
5. **Tool calls go through the gate.** Pi's tools are a Pi extension (`src/pi/peeblo-tools.ts`) that calls back into core.
   `src/proxy/tools.ts` checks who may call it, Otari's command and file rules, and the approval rules (`src/rules/reviewer.ts`).
   A write that needs a person waits on a card in Slack (`src/durable/approvals.ts`, `src/slack/approval-card.ts`).
   Connector calls run in Otari on the teammate's own key (`src/connectors/mcp.ts`).
6. **Slack shows it live.** Everything above is written to the `events` table first (`src/store/events.ts`).
   `src/slack/view.ts` draws the live reply from those events, and `src/runs/receipts.ts` builds the receipt.

Schedules, webhook triggers and watches start runs the same way (`src/runs/triggers.ts`, `src/durable/schedules.ts`).
A teammate can hand work to another; chains have depth, call and spend limits (`src/crew/chains.ts`).

## Where things live in `src/`

| Folder | What's in it |
|---|---|
| `ingress/`, `slack/` | Slack: signatures, inbound messages, the live reply, cards, App Home, slash commands, app manifests |
| `durable/` | DBOS workflows: runs, approvals, schedules |
| `pi/` | Running a teammate's turn: the turn loop (`supervisor.ts`), the Pi processes (`sessions.ts`), the facts added to a turn (`notes.ts`), the Stop check, the RPC client and the tools extension |
| `proxy/` | The model relay (`relay.ts`), the tool gate (`tools.ts`), loop rules (`loops.ts`) and what results look like to the model (`results.ts`) |
| `agent-tools/` | The tools a teammate can pick up (Slack, memory, web, computer, repos, hiring, schedules) |
| `connectors/` | MCP servers in Otari: catalog, call classification, repo limits |
| `otari/` | Everything else that talks to Otari: client, catalog, routing policies, keys and budgets, people, guardrail admin |
| `environment/` | Each teammate's computer: Gondolin VMs, images, build recipes, git worktrees |
| `memory/` | Versioned memory: one git repo per teammate, a folder per place |
| `store/` | Postgres access: teammates, people, sessions, events, secrets |
| `api/` | Core's HTTP API, the console's routes, and setup |
| `rules/` | Who may do what, who answers an approval, hiring rules, the reviewer, the guard |
| `crew/` | Peeblo itself, teammates calling teammates, retiring, model changes, skills |
| `runs/` | Schedules and triggers, receipts, how a job's ask reads |
| top level | Config, settings, the database, ids, crypto, `peeblo check`, the CLI entry (`bin.ts`) |

## Where state lives

- **Postgres:** teammates and their versions, people, sessions, submissions, runs, the event log, approvals and grants,
  schedules, Slack apps, computer builds. Migrations are in `db/`, applied in order at start.
- **The data directory:** memory repos, computer images, worktree mirrors, and `settings.json` from the console's setup.
- **Otari:** keys, budgets, spend ceilings, routing policies, guardrails and MCP servers. Peeblo reads them; it doesn't copy them.

## Enforced in code, not in prompts

| Rule | Where |
|---|---|
| Money, deletes, shipping and posting outside the thread always ask a person (except in YOLO mode) | `src/rules/reviewer.ts`, `src/proxy/tools.ts` |
| A call is read, write or destructive by its name and arguments; a server's hint can only make it riskier | `src/connectors/mcp.ts` |
| A read-only connector gets no writes, and Otari refuses them too | `src/proxy/tools.ts`, `src/otari/mcp-access.ts` |
| No call leaves without a price; budgets are checked before the call | `src/proxy/relay.ts`, `src/otari/spend.ts` |
| Outside text is screened and marked untrusted | `src/rules/guard.ts`, `src/proxy/tools.ts` |
| Who may approve, hire, or change a teammate | `src/rules/authority.ts`, `src/rules/approvers.ts`, `src/rules/hire-rules.ts` |
| Secrets are sealed at rest and removed from the environment | `src/crypto.ts`, `src/store/secrets.ts`, `src/config.ts` |

The unit tests in `test/` cover the pure parts of these rules.

## More

- [OTARI.md](OTARI.md): how Peeblo uses each part of Otari, and the limits we hit.
- [CONFIGURATION.md](CONFIGURATION.md): every setting.
- [SETUP.md](SETUP.md): from a fresh machine to a teammate in Slack.
