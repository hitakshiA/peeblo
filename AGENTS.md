# Notes for coding agents

Peeblo is a crew of AI teammates in Slack. TypeScript on Node 24, run directly (no build step), pnpm, Postgres, DBOS.
Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## Commands

```bash
pnpm install --frozen-lockfile
pnpm typecheck        # tsc, strict, unused locals are errors
pnpm lint             # Biome, lint only
pnpm test             # node:test unit tests, no database or network
pnpm knip             # unused files, exports and dependencies
pnpm format           # Biome formatter; CI runs format:check
pnpm test:integration # needs PEEBLO_TEST_DATABASE_URL: an empty Postgres it may wipe
(cd console && pnpm install --frozen-lockfile && pnpm build)
```

All three core checks must pass before a commit. CI runs them, plus the console build and the Docker image.

## Rules

- Imports use the `.ts` extension, and type-only imports use `import type`.
- Money, approvals, read-only access, budgets and the guard are enforced in code. Never move one into a prompt.
  A change to one of them comes with a test in `test/`.
- Prompts, tool descriptions and skills must work for any company: no names, people or data from a real workspace.
- A new setting goes in `src/config.ts` where it can, and always in [docs/CONFIGURATION.md](docs/CONFIGURATION.md).
- A schema change is a new file in `db/` (`NNN_name.sql`). Never edit an applied migration.
- No new runtime dependency without an issue first.
- Never commit `.env`, `local/` or anything from the data directory.
