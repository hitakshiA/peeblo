# Contributing to Peeblo

Thanks for helping. Bug fixes, docs, new skills and connector notes are all welcome.

## Before you start

- Search the open issues and pull requests first; someone may already be on it.
- For anything bigger than a fix (a new tool, a change to approvals or budgets, a new dependency), open an issue
  first and say what you want to change and why. It saves you rework.
- Read the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately, as [SECURITY.md](SECURITY.md)
  describes, never in a public issue.

## Set up

You need Node 24, pnpm (the version in `package.json`'s `packageManager`), Docker, and either a Mac with Apple
silicon or a Linux machine with KVM. You also need an [Otari](https://otari.ai) account and a Slack workspace you
can install apps in; a free test workspace is fine.

```bash
pnpm install
pnpm typecheck                     # core: types
pnpm lint                          # core: Biome
pnpm test                          # core: unit tests (no database or network)
pnpm knip                          # core: unused files, exports and dependencies
pnpm format                        # format core, tests and console (CI checks it)
PEEBLO_TEST_DATABASE_URL=postgres://… pnpm test:integration   # on an empty Postgres (it is wiped)
(cd console && pnpm install && pnpm build)   # the console
./peeblo up                        # Postgres, core, the console; then open http://127.0.0.1:7340/console/
```

`./peeblo logs` follows core's log, `./peeblo check` lists what is set up and what isn't, and `./peeblo down` stops
everything. [docs/SETUP.md](docs/SETUP.md) covers the rest, including a Linux server.

## Where things live

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) follows a message from Slack to a reply and says where each rule is enforced.

| Folder | What's in it |
|---|---|
| `src/otari/` | Everything that talks to Otari: the client, routing policies, keys and budgets, MCP access, usage |
| `src/proxy/` | The model relay and the tool gate (approvals, read-only, the guardrail on outside text) |
| `src/agent-tools/` | The tools a teammate can pick up |
| `src/slack/` | Slack: inbound events, the live reply, cards, App Home, slash commands |
| `src/pi/`, `src/durable/` | Running a teammate's turn (Pi) and keeping runs and schedules durable (DBOS) |
| `src/environment/` | Each teammate's computer (Gondolin micro-VMs) |
| `src/rules/`, `src/crew/`, `src/runs/` | Who may do what and the guard; the crew (Peeblo, hiring, teammates calling teammates); schedules, triggers and receipts |
| `skills/` | How teammates do recurring kinds of work, in plain words |
| `config/` | Model roles (`model-tiers.json`) and notes about each connector |
| `console/` | The browser console (React) |
| `site/` | The landing page at peeblo.xyz (Next.js, its own `npm` install) |
| `db/` | SQL migrations, applied in order at start |
| `test/` | Unit tests (`node:test`), one file per area |
| `docs/` | Setup, architecture, Otari, configuration |

## Making a change

- Keep a pull request to one change, and write its description for someone with no context: what changes for a
  person using Peeblo, and how to see it work.
- Run `pnpm typecheck`, `pnpm lint` and `pnpm test` (and `pnpm build` in `console/` if you touched it) before you
  push. CI runs the same.
- A change to a rule enforced in code (approvals, risk classes, read-only, budgets, the guard) comes with a test in
  `test/`. Tests import from `src/` and touch no database or network.
- Test against real services: your own Otari org and Slack workspace. Say in the PR what you tried.
- Prompts, tool descriptions and skills must work for any company. Don't put names, people or data from your own
  workspace in them.
- Money, approvals, read-only access and the guardrail are enforced in code, not in prompts. A change there needs a
  sentence on why it stays safe.
- Never commit secrets. `.env`, `local/` and the data volume are ignored for a reason.
- Say in the PR whether and how you used AI to write it.

## License

By contributing you agree that your work is released under the [Apache 2.0 license](LICENSE).
