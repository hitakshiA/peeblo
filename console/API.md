# Console API contract

The console is a React (Vite) app built to `console/dist` and served by core at `/console/` on the private API port
(`http://127.0.0.1:7340/console/`, never the public URL). Every call is same-origin JSON under `/v1`. Errors are
`{ "error": "sentence" }` with a 4xx/5xx status.

## Auth
- `POST /v1/console/login` `{ password }` → `200 { ok: true }` and an httpOnly cookie. `401` on a wrong password.
- `POST /v1/console/logout` → clears it. `GET /v1/console/me` → `{ person: { id, display_name } | null }` (401 when logged out).
- Every other `/v1` call works with the cookie. Actions taken in the console are made as the console's admin person
  (the server fills the person in; the console never sends one).

## Setup
- `GET /v1/setup` → `{ checks: [{ ok: boolean, name: string, detail: string }] }` (the same lines as `./peeblo check`).

## Crew and teammates
- `GET /v1/teammates` → `{ teammates: Teammate[] }` where `Teammate = { id, slug, version, owner_person, config: { name, role, instructions, model: { default, fallback? }, budget: { monthly_usd }, tools: string[], connectors: string[], mode: "ask"|"auto"|"trusted"|"yolo", computer: { size: "small"|"large", recipe, repos? }, git? } }`.
- `GET /v1/teammates/:slug/overview` → `{ teammate: Teammate, spend: { spent, cap } | null, app: { app_id, installed: boolean, install_url: string|null } | null, recent_runs: Run[], schedules: Schedule[], computer: Computer | null, memory: { notes: number, unverified: number } }`.
- `GET /v1/teammates/:slug/face.png` → the teammate's avatar PNG (256 px).
- `PATCH /v1/teammates/:slug` `{ ...config fields to change, note }` → the new `Teammate` (a new version).
- `POST /v1/teammates` `{ slug, name, role, instructions?, model: { default }, budget: { monthly_usd }, tools, connectors, mode, computer?: { size } }` → `Teammate` (a hire from a form).
- `GET /v1/teammates/:slug/versions` → `{ versions: [{ version, changed_by, note, created_at }] }`.

## Talk to a teammate (everything you can do in Slack)
- `POST /v1/teammates/:slug/sessions` `{ kind: "api", place_key: "console:<random>" }` → `{ id }`.
- `POST /v1/sessions/:id/submissions` `{ text, request_id }` → `{ run_id }`.
- `GET /v1/runs/:id` → `{ run: { id, status: "queued"|"running"|"waiting"|"done"|"failed", error }, events: Event[] }`. Poll every 2 s while not done. `Event = { id, type, data, at }`; useful types: `tool.call` (`data.tool`, `data.status`), `plan.updated` (`data.steps[{ step, status }]`), `slack.post` (`data.text`: what the teammate said), `turn.finished` (`data.text`: its final text), `approval.requested` (`data.approval_id`, `data.action`).
- `GET /v1/runs/:id/receipt` → `{ line: string, cost_usd, models, providers, calls, links }`.

## People
- `GET /v1/people` → `{ people: [{ id, display_name, slack_user, spend, cap, tier }] }`.

## Sessions and receipts
- `GET /v1/sessions?teammate=:slug` → `{ sessions: [{ id, kind, place_key, created_at, last_active_at, runs: number }] }`.
- `GET /v1/sessions/:id` → `{ session, runs: [{ id, status, created_at, asked: string, receipt: string|null }] }`.

## Approvals
- `GET /v1/approvals?status=pending` → `{ approvals: [{ id, run_id, teammate, action: object, created_at, expires_at, status }] }`.
- `POST /v1/approvals/:id` `{ decision: "approved"|"denied", scope: "once"|"job"|"always" }` → `{ ok, status }` (`status: "not_allowed"` when only someone else may answer).

## Otari
- `GET /v1/otari` → `{ web_search: { enabled: boolean|null, provider: string|null, keys: {id, name, provider, last4, is_default}[], providers: string[] }, guardrail: { enabled: boolean|null, profile: string }, routing_policies: string[], links: { dashboard, keys, budgets, guardrails, routing } }`.
- `POST /v1/otari/search-key` `{ provider, api_key }` → `{ ok, provider, last4 }`: adds an org search key in Otari and makes it the default; Peeblo doesn't keep the key.
- `POST /v1/otari/web_search` `{ enabled }`, `POST /v1/otari/guardrail` `{ enabled }` → `{ ok, now }` (read back after the change).

## Computers
- `GET /v1/computers` → `{ computers: [Computer] }`, `Computer = { teammate, size, state: "asleep"|"booting"|"awake", pins, l2_reset_at, builds: [{ id, status, purpose, created_at, error }] }`.
- `POST /v1/teammates/:slug/computer/sleep`, `POST /v1/teammates/:slug/computer/reset`, `POST /v1/teammates/:slug/computer/rebuild` → `{ ok }`.

## Memory
- `GET /v1/teammates/:slug/memory` → `{ notes: [{ bank, path, title, verified, updated, source }] }` (`bank`: `ws`, `company`, `dm-<user>`, `ch-<channel>`).
- `GET /v1/teammates/:slug/memory/note?bank=&path=` → `{ note: { bank, path, title, body, verified } }`.
- `PUT /v1/teammates/:slug/memory/note` `{ bank, path, title, body }` → `{ note }` (an owner edit, verified).
- `POST /v1/teammates/:slug/memory/verify` `{ bank, path }` → `{ ok }`.

## Schedules and triggers
- `GET /v1/schedules` → `{ schedules: [{ id, teammate, kind: "cron"|"once"|"webhook"|"watch", name, cron, run_at, enabled, last_run_at, filter, watch, budget_usd }] }`.
- `POST /v1/schedules/:id/run` → `{ run_id }` or `{ result }` (a watch polls).
- `PATCH /v1/schedules/:id` `{ enabled }` → `{ ok }`. `GET /v1/schedules/:id/hook` → `{ url, secret }` (webhooks).

## Feedback
- `GET /v1/feedback` → `{ feedback: [{ run_id, teammate, vote: "up"|"down", by, at, asked }] }`.
