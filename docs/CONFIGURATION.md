# Configuration

Peeblo reads its settings from the environment once, at start.
You rarely need this page: `./peeblo up` generates the secrets, and the console's setup saves the rest.

Where a value comes from, strongest first:

1. `.env` (or the process environment).
2. `settings.json` in the data directory, written by the console's setup.
3. The default below.

Secrets (`DATABASE_URL`, `POSTGRES_PASSWORD`, `PEEBLO_ADMIN_TOKEN`, `PEEBLO_SECRET_KEY`, the Otari key, the console password) are removed from the environment right after they are read, so child processes never see them.

Most changes need a restart: `./peeblo down && ./peeblo up`.
`.env.example` lists the settings most installs touch.

## Set by the console's setup

| Variable | Default | What it does |
|---|---|---|
| `OTARI_SERVICE_KEY` | empty | Peeblo's Otari service key. Empty: core runs only the console, in setup mode. |
| `OTARI_API_KEY` | empty | A plain Otari key, used when there is no service key. No per-person billing. |
| `PEEBLO_PUBLIC_URL` | empty | The public HTTPS origin that reaches the ingress port (Slack events, OAuth, card images). |
| `PEEBLO_SLACK_CONFIG_FILE` | empty | A JSON file with a Slack app configuration token: `{"access_token", "refresh_token", "exp"}`. |
| `PEEBLO_CONSOLE_PASSWORD` | empty | The console's password. |
| `PEEBLO_ADMINS` | empty | Slack user ids of the admins, comma-separated. Empty: whoever adds Peeblo to Slack becomes the first admin. |
| `PEEBLO_SLACK_APP_ID` | empty | Peeblo's own Slack app. |

## Generated on first run

| Variable | What it does |
|---|---|
| `POSTGRES_PASSWORD` | The database password. `DATABASE_URL` is built from it. |
| `DATABASE_URL` | The Postgres connection string. Required. |
| `PEEBLO_ADMIN_TOKEN` | The bearer token for core's API. Required. |
| `PEEBLO_SECRET_KEY` | 32 bytes, base64. Seals secrets at rest (AES-256-GCM). Required. Losing it loses the sealed secrets. |

## Otari

| Variable | Default | What it does |
|---|---|---|
| `OTARI_REGION` | US | Set to `eu` for Otari's EU region. |
| `OTARI_BASE_URL` | from the region | Otari's API address. Overrides the region. |
| `OTARI_END_USER_BUDGET_ID` | the key's default | The budget tier new people start on. |
| `OTARI_WORKSPACE_ID` | the key's workspace | The workspace for admin work, when Peeblo can't find its key's own. |
| `OTARI_DASHBOARD_URL` | `https://otari.ai/dashboard` | Where receipt and console links point. |
| `PEEBLO_TEAMMATE_SPEND` | `auto` | `key`: each teammate gets its own Otari key and spend ceiling. `tag`: calls are tagged by teammate. `auto`: `key` when a dashboard session exists. |
| `PEEBLO_OTARI_CODE` | `on` | Otari's code sandbox, for teammates that choose to run code. |
| `PEEBLO_WEB_FETCH` | `on` | Otari's web fetch. |
| `PEEBLO_VISION` | `on` | Reading images through Otari. |
| `PEEBLO_TRACE_CONTENT` | `off` | `keep` stores each call's prompt and answer on its Otari trace, for debugging. |

## Guard and decision models

| Variable | Default | What it does |
|---|---|---|
| `PEEBLO_GUARD` | `lakera` | How outside text is screened: `lakera`, `open` (an open guard model) or `off`. |
| `PEEBLO_GUARD_PROFILE` | `peeblo-lakera` | The profile of the org guardrail in Otari. |
| `PEEBLO_LAKERA_PROJECT` | empty | The Lakera project whose policy decides what is flagged. |
| `PEEBLO_GUARD_MODEL` | `alibaba/qwen3guard-gen-8b` | The open guard model. Also confirms Lakera's flags. |
| `PEEBLO_GUARD_PROBE_MODEL` | the worker role's cheapest | The model for one-token screening calls. |
| `PEEBLO_JUDGE_MODEL` | `peeblo-judge` | The routing policy for typed decisions (yes or no, pick one, a score): the reviewer and the stop check use it. |
| `PEEBLO_DECISION_MODEL` | `typesafe:jev-latest` | The model for Otari's `/decisions`, when the deployment has a decision provider. |

## Approvals, budgets and limits

| Variable | Default | What it does |
|---|---|---|
| `PEEBLO_APPROVAL_TTL_S` | `1800` | How long an approval card waits while someone is in the conversation. Unattended runs wait 12 hours. |
| `PEEBLO_PRICE_CARD_USD` | `0.5` | Above this estimate, a job shows a price card first. |
| `PEEBLO_TURN_TIMEOUT_MS` | `21600000` (6 h) | The hard limit for one job. Time waiting on an approval card doesn't count. At the limit the job stops and posts its status. |
| `PEEBLO_MAX_OUTPUT_TOKENS` | `32768` | The most one model call may write. Otari reserves budget for all of it. |
| `PEEBLO_CONTEXT_TOKENS` | `262144` | The context window Pi works in; it compacts before reaching it. Models offer up to 1M, at a cost per call. |
| `PEEBLO_THINKING_LEVEL` | `medium` | Teammates' reasoning effort. Peeblo's desk work uses `low`, the hard part (`peeblo-heavy`) `high`. |
| `PEEBLO_JOB_ROUTING` | `on` | Otari's router picks the everyday or the strong model at the start of each job for teammates on the everyday role, and a job the Stop check sends back moves up to the strong model. `off` keeps every job on the teammate's model. |
| `PEEBLO_ROUTINE_BUDGET_USD` | `0.25` | A scheduled or triggered run's budget when the teammate doesn't set one. |
| `PEEBLO_ROUTINE_MAX_USD` | `5` | The most one scheduled or triggered run may be given. |
| `PEEBLO_PROGRESS_EVERY_MS` | `1200000` (20 min) | How often a long job is asked to post a one-line progress note. The note is steered in between tool calls; nothing is interrupted. |
| `PEEBLO_MAX_CONTINUATIONS` | `2` | How many times the Stop check or the outcome grader may send an unfinished job back. |
| `PEEBLO_MAX_RUNNING` | 1 per GB of memory above 2 GB, at least 2 | The most jobs working at once. The rest wait in line. |
| `PEEBLO_CHAIN_DEPTH` | `3` | How deep teammates may hand work to each other. |
| `PEEBLO_CHAIN_CALLS` | `6` | The most hand-offs in one chain. |
| `PEEBLO_CHAIN_CAP_USD` | `5` | The most one chain may spend. |
| `PEEBLO_TRIGGER_RUNS_PER_HOUR` | `6` | Triggered runs per teammate per hour. |
| `PEEBLO_UNPROMPTED_PER_HOUR` | `3` | Posts a teammate may make in a watched channel per hour without being asked. |
| `PEEBLO_MEMBER_WRITES` | `on` | `off`: only admins' requests change connected tools. Everyone can still read. |
| `PEEBLO_MEMBER_HIRES` | no limit | The most teammates one non-admin may keep. |

## Connectors and repos

| Variable | Default | What it does |
|---|---|---|
| `PEEBLO_READONLY_SERVERS` | empty | MCP servers that only read, whatever their tool names say. |
| `PEEBLO_GITHUB_TOKEN` | empty | A GitHub token for teammates that work in repos. Use a fine-grained token. |
| `PEEBLO_GITHUB_REPOS` | no limit | The only repos (`owner/repo`, comma-separated) any teammate may touch. |
| `PEEBLO_HOOK_SECRET_<SERVICE>` | empty | The signing secret for webhooks from a service, e.g. `PEEBLO_HOOK_SECRET_STRIPE`. |
| `PEEBLO_POLICY_FILE` | `policies/teammate.yaml` | The command and file rules Otari checks. |

## Teammate computers

| Variable | Default | What it does |
|---|---|---|
| `PEEBLO_AWAKE_CAP_SMALL` | `8` | Small computers awake at once. |
| `PEEBLO_AWAKE_CAP_LARGE` | `2` | Large computers awake at once. |
| `PEEBLO_HOST_RESERVE_MB` | `1024` | Memory kept free for the host. |
| `PEEBLO_VM_IDLE_MS` | `300000` | A computer sleeps after this long idle. |
| `PEEBLO_VM_ARCH` | the host's | `aarch64` or `x86_64`. |
| `PEEBLO_VM_IMAGE` | built image | A custom image for small computers. |
| `PEEBLO_LARGE_DISTRO` | Debian when Docker or Podman is present | Set to `alpine` to build the large computer on Alpine. |
| `PEEBLO_BROWSER_DRIVER` | `agent-browser` | The browser driver on large computers. |
| `PEEBLO_SESSION_TTL_HOURS` | `24` | Worktrees of sessions idle this long are cleaned up. |

## Memory and Slack

| Variable | Default | What it does |
|---|---|---|
| `PEEBLO_EMBED_MODEL` | `alibaba/qwen3-embedding-0.6b` | The embedding model for memory recall. |
| `PEEBLO_EMBED_DIMS` | `256` | Embedding size. |
| `PEEBLO_RERANK_MODEL` | `alibaba/qwen3-reranker-8b` | The rerank model for memory recall. |
| `PEEBLO_SLACK_BATCH_MS` | `500` | Quick follow-up messages from one person within this window are one request. |
| `PEEBLO_PI_IDLE_MS` | `600000` | A teammate's Pi process stops after this long idle. |

## Ports, paths and names

Change these only to run two copies side by side.

| Variable | Default | What it does |
|---|---|---|
| `PEEBLO_PROJECT` | `peeblo` | The Compose project name. |
| `PEEBLO_DATA_DIR` | `/data` (`local/data` on a Mac) | Where Peeblo keeps memory, images and `settings.json`. |
| `PEEBLO_DB_PORT` | `55432` | Postgres on the host. |
| `PEEBLO_API_HOST` / `PEEBLO_API_PORT` | `127.0.0.1` / `7340` | Core's API and the console. Never public. |
| `PEEBLO_INGRESS_HOST` / `PEEBLO_INGRESS_PORT` | `127.0.0.1` / `8787` | The public ingress: Slack events, interactions, OAuth. |
| `PEEBLO_PROXY_PORT` | `7341` | The loopback model proxy Pi talks to. |
| `PEEBLO_EXECUTOR_ID` | `core-1` | Fixed per install, so a restarted core resumes its own runs. |
| `PEEBLO_CORE_URL` | found | Where `peeblo check` reaches core. |
