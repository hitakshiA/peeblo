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
