# Setting up Peeblo

From a fresh machine to a teammate answering in Slack. About half an hour.

## What you need

- **A machine.** Linux with `/dev/kvm` (a server or a mini PC), or a Mac with Apple silicon.
  Each awake teammate computer uses about 250 MB (small) or 1.5 GB (large, with a browser).
- **Docker** (Compose v2). On a Mac also `brew install node@24 qemu pnpm`.
- **An [Otari](https://otari.ai) account** with credit. Peeblo calls only Otari; it holds no model-provider keys.
- **A Slack workspace** where you can add apps.
- **A public HTTPS address** that reaches the machine: a domain with TLS (Caddy works), or a tunnel
  (Tailscale Funnel, a Cloudflare named tunnel, zrok). Only Slack's events, OAuth callbacks and webhooks use it.

## 1. Otari

In the Otari dashboard:

1. Create an **org service key**. A service key lets Peeblo name each person (an end user) and cap them.
2. Turn on **web search** if teammates should search the web.
3. Under **Budgets**, make an end-user budget tier (for example $2 a day). New people get it.
4. Optional: add an org **guardrail** (Lakera Guard in block mode). Peeblo can also use an open guard model instead.
5. Note your **email and password**. Peeblo can sign in once to make a key and a spend ceiling per teammate and
   its routing policies; it keeps only the session, sealed. Without it, Peeblo links you to the right page.

## 2. Configure

```bash
git clone <this repo> peeblo && cd peeblo
./peeblo up          # the first run writes .env with random secrets, then stops to let you fill in the rest
```

Open `.env` and set:

| Setting | |
|---|---|
| `OTARI_SERVICE_KEY` | the key from step 1 |
| `PEEBLO_PUBLIC_URL` | your public HTTPS address, e.g. `https://peeblo.example.com` |
| `PEEBLO_ADMINS` | Slack user ids of the people who may change Otari settings (comma-separated) |
| `PEEBLO_CONSOLE_PASSWORD` | the console's password |
| `PEEBLO_SLACK_CONFIG_FILE` | a JSON file with your Slack app configuration token (step 3) |

Point the public address at the ingress port (`8788` by default). Everything else (the API on `7340`, the console)
stays on the machine.

## 3. Slack

1. At [api.slack.com/apps](https://api.slack.com/apps), under **Your App Configuration Tokens**, generate a token for
   your workspace. Save `{"access_token": "...", "refresh_token": "...", "exp": <unix time>}` to the file named in
   `PEEBLO_SLACK_CONFIG_FILE`. Peeblo rotates it every 12 hours and keeps it sealed.
2. Make Peeblo's own app and install it:

   ```bash
   ./peeblo slack-app   # prints an install link: open it and click Allow
   ```

Each teammate you hire later gets its own app the same way: Peeblo makes it, gives it a face, and posts an
**Add to Slack** button (on its ID card, in the hire thread, and in Peeblo's App Home). A teammate works only
through its own app: until someone clicks it, it doesn't work at all, and Peeblo won't do its job for it.
`./peeblo check` lists who is still waiting. On a free Slack workspace you can have 10 apps in all, Peeblo included.

## 4. Start

```bash
./peeblo up
./peeblo check       # every line should say ok; each failure says what to fix
```

The first start builds the small computer image (a minute). For teammates that browse websites, build the large one
once: `./peeblo image large`. With Docker or Podman running, the large computer is Debian 13 with Chromium, bun and
Playwright MCP (about 4.4 GB, a few minutes the first time). Without either, it's Alpine with Chromium and the same
browser tools. `./peeblo check` says which one you have; `PEEBLO_LARGE_DISTRO=alpine` keeps Alpine anyway.

## 5. Your first teammate

In Slack, DM Peeblo:

> I need a teammate who keeps an eye on our Linear issues and summarizes them when I ask.

Peeblo asks at most two questions, then shows the new teammate's ID card. Approve it, and the teammate introduces
itself and starts.

Or use the console: `http://127.0.0.1:7340/console/` (from the machine itself, your LAN, or an SSH tunnel), sign in
with the console password, and hire from **Crew**.

## Connectors

Teammates use tools through MCP servers stored in Otari (Linear, GitHub, PostHog, Stripe, Notion, and others).
Add a server in Otari's dashboard (**Tools → MCP servers**), then give it to a teammate by name: "Ledger, you can use
stripe now", or in the console under the teammate's settings.

Stripe: an agent restricted key is subject to Stripe's own approval rules (Settings → Approvals → Rules). If you keep
the "Refund created" rule on, you approve twice: once on Peeblo's card, then again in Stripe.

## Day to day

- `./peeblo status`, `./peeblo logs`, `./peeblo down`.
- Approvals wait 30 minutes in a live conversation and 12 hours for scheduled work, then count as no.
- Money, deletes, shipping and posts outside the thread always ask, whatever a teammate's mode.
- Everything a teammate does is in the console under **Sessions**, with a receipt for each job.
