# Changelog

What changed for people running Peeblo. Newest first. `./peeblo upgrade` pulls these.

## Unreleased

### Teammates do longer, bigger work
- No wall clock on real work. A job runs until it's done, with a hard limit of 6 hours (`PEEBLO_TURN_TIMEOUT_MS`). A long job posts a short progress line every 20 minutes without being interrupted.
- A message sent while a teammate is working reaches the running job, between tool calls, instead of waiting for it to end.
- Background commands: `computer_bash` with `run_in_background`, and `computer_job` to see the output, wait for it or stop it. A command still running at its timeout keeps going in the background. The computer stays awake while one runs (up to 2 hours).
- Long command output keeps its start and its end; the whole of it is saved on the computer.
- Teammates attach files they make to the conversation (`share_file`).
- Subagents run commands on their own computer folder, several at once, without the old 8-minute limit.
- After a restart, a job carries on from where it was. The person's message isn't sent again, and a write that already ran isn't run twice.
- The Stop check may send an unfinished job back twice (`PEEBLO_MAX_CONTINUATIONS`).

### Models
- Otari's router picks the everyday or the strong model at the start of each job, and a job sent back moves up to the strong model (`PEEBLO_JOB_ROUTING`).
- Pi knows each model's real context window and asks for reasoning: medium for everyday work, high for the hard part, low for Peeblo's desk work (`PEEBLO_THINKING_LEVEL`).
- One model call may write up to 32k tokens (`PEEBLO_MAX_OUTPUT_TOKENS`).
- The tool list stays the same for a whole session, which keeps the provider's prompt cache: `find_tools` finds a tool (BM25 ranking) and `use_tool` calls it.

### Computers and safety
- Small computers reach the common package registries and code hosts (69 domains, each with its subdomains), so Rust, Go, Ruby, Java and Node installs work.
- Large computers can read any public site but send data only to their allowed hosts.
- Output of commands in a repo is labelled as outside text but no longer screened by the guard; output from the network and from files people shared still is.
- GitHub reads (`gh pr view`, `gh issue list`, `gh run watch`) no longer need a card; writes still do.
- If Otari's rule check can't be reached, the same policy is applied locally.
- The GitHub token and webhook secrets are removed from the environment at start, like the other secrets.

### Otari
- Each teammate's Otari key only reaches open-weight models (and, without the web tool, no search or fetch tools), enforced by Otari. Pausing a teammate switches its key off; `./peeblo rotate-key <teammate>` replaces its secret.
- A cap on the whole crew: money and AI calls a month (`otari_set_crew_cap`). Per-person tiers also cap calls a day (`PEEBLO_PERSON_DAILY_REQUESTS`).
- The org's prepaid balance shows in `budget_status` and `./peeblo check`; when it runs out, people get a plain answer.
- Routing changes are checked with Otari's explain before the card; `otari_read_setting` shows each role's plan and the automatic fallbacks.
- Pictures from a description (`make_image`, FLUX.1 schnell) and many prompts at once as one batch (`batch_run`, `batch_results`).
- A repo's own guardrails (`.otari/guardrails.yml`, `.otari/guardrails/`) apply in its checkout, and their required gates must pass before a push; `repo_check` runs them on demand.
- Conversations can be shared with the admins, or opened under Otari's break-glass, and stored content deleted (with `PEEBLO_TRACE_CONTENT=keep`).
- The console's Otari page adds a search provider's key for direct web search results.
- "stop" sent as a new message in a DM stops the jobs running there, a stopped job ends as stopped (not an error), and cards it was waiting on are withdrawn.

### Smaller changes
- Polling (a status checked again after a pause) is not treated as a loop, and gets a fresh result.
- The stuck check counts only real answers, not failed attempts or retries.
- Memory search sends no end-user id to Otari's embeddings and rerank, which refuse it.
- A skill's scripts are copied to the computer when the skill is opened.
- Longer results from reading a file, a web page, a web search and `run_code`.
- When Pi compacts a long conversation, its summary is kept in work memory.
- Jobs wait in a DBOS queue; subagents and calls to other teammates start at once.
- Routine and chain budgets are settings (`PEEBLO_ROUTINE_BUDGET_USD`, `PEEBLO_ROUTINE_MAX_USD`, `PEEBLO_CHAIN_CAP_USD`).
- The heavy model steps down to the everyday one at 80% of a teammate's budget.

### For contributors
- Unit tests (`pnpm test`), Biome lint for core and console, knip for unused code, and a security workflow (gitleaks, osv-scanner).
- Every setting is read in `src/config.ts` and listed in [docs/CONFIGURATION.md](docs/CONFIGURATION.md).
- `yaml` is now a direct dependency (it already shipped with DBOS and Pi) for reading repo guardrail files.
