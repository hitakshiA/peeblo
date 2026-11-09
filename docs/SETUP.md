# Setting up Peeblo

From a fresh machine to a teammate answering in Slack, in about half an hour.

## What you need

- **A Mac with Apple silicon, or a Linux server with `/dev/kvm`** ([On a Linux server](#on-a-linux-server)). Each awake
  teammate computer uses about 250 MB (small) or 1.5 GB (large, with a browser).
- **Docker** (Compose v2), plus on a Mac:
  ```bash
  brew install node@24 pnpm qemu e2fsprogs
  brew link --overwrite --force node@24      # node@24 isn't put on your PATH otherwise; `node -v` should say v24
  ```
- **An [Otari](https://otari.ai) account** with credit. Peeblo calls only Otari; it holds no model-provider keys.
- **A Slack workspace** where you can add apps.
- **A public HTTPS address** that reaches this machine: a domain with TLS (Caddy works), or a tunnel (Tailscale
  Funnel, a Cloudflare named tunnel, zrok). Only Slack's events, sign-in callbacks and webhooks use it. With a free
  zrok share, reserve it and turn off its warning page (`zrok reserve public … --skip-interstitial`), or Slack's
  install link stops on that page.

## 1. Otari

In the Otari dashboard:

1. **Keys:** create an org **service key**. It lets Peeblo name each person (an end user) and cap them.
2. **Budgets:** make an end-user budget tier (for example $2 a day), then open the service key and set that tier as
   its **default end-user budget**. Without a default tier, every message to Peeblo fails.
3. **Tools:** turn on **web search** and **code execution**. Teammates use them only when they choose to.
4. **Guardrails (recommended):** add a Lakera Guard guardrail with the profile name **`peeblo-lakera`**. Peeblo
   uses it to check text from outside your company (customer tickets, web pages, files) before a teammate acts on
   it. Without it, Peeblo uses an open guard model through Otari instead.
5. **Tools → MCP servers:** add the services your teammates should use (Linear, GitHub, Stripe, Notion, PostHog,
   Intercom, Atlassian, Sanity, Supabase and others with an MCP server). You can add more at any time.
   For each one, set **default access** to the read tools (`@read`) and give Peeblo's service key the write tools it
   may use. Each teammate then gets its own key with the same access, minus anything you make read-only, and Otari
   itself refuses writes a teammate isn't allowed. (With default access left at every tool, Peeblo still keeps
   read-only teammates from writing, but Otari can't.)

## 2. Configure

```bash
git clone <this repo> peeblo && cd peeblo
./peeblo up          # writes .env with random secrets, then stops and lists what you still need to set
```

Open `.env` and set the five required settings (the file explains each one):

| Setting | |
|---|---|
| `OTARI_SERVICE_KEY` | the key from step 1 |
| `PEEBLO_PUBLIC_URL` | your public HTTPS address, e.g. `https://peeblo.example.com` |
| `PEEBLO_SLACK_CONFIG_FILE` | a JSON file with your Slack app configuration token (step 3) |
| `PEEBLO_CONSOLE_PASSWORD` | the console's password |
| `PEEBLO_ADMINS` | Slack user ids of the admins (comma-separated) |

Point the public address at the ingress port (`8787` by default). Everything else (the API on `7340`, the console)
stays on this machine.

## 3. Slack token

At [api.slack.com/apps](https://api.slack.com/apps), under **Your App Configuration Tokens**, generate a token for
your workspace and save it as `{"access_token": "...", "refresh_token": "...", "exp": <unix time>}` in the file
named by `PEEBLO_SLACK_CONFIG_FILE`. Peeblo stores it sealed and rotates it every 12 hours.

## 4. Start

```bash
./peeblo up          # first start builds the console and the small computer image (a minute)
./peeblo check       # every line should say ok, or say exactly what to fix
```

## 5. Peeblo's Slack app

```bash
./peeblo slack-app   # makes Peeblo's app and prints an install link: open it and click Allow
```

Run it again any time: it prints the link until Peeblo is installed. Peeblo greets you in a DM.

## 6. Connect Otari (once)

Open the console at `http://127.0.0.1:7340/console/` (from this machine, or through an SSH tunnel), sign in with
the console password, and on **Setup** click **Connect Otari**. Sign in with your Otari dashboard login: the
password is used for that one sign-in and never stored.

With that session, Peeblo sets itself up in Otari: a routing policy for each role (a model, Otari's fallback, and a
cheaper model when a teammate's budget is mostly used), and its own key with a spend ceiling for every teammate.
The session lasts about a week; connect again when `./peeblo check` says it has expired. Teammates keep their own
keys in the meantime.

## 7. Your first teammate

In Slack, DM Peeblo:

> I need a teammate who keeps an eye on our Linear issues and summarizes them when I ask.

Peeblo may ask a question, then shows the new teammate's ID card. Approve it, click **Add … to Slack** on the card,
and the teammate introduces itself. Every teammate works only through its own Slack app.

Give a teammate more tools by asking Peeblo: "give Quill github too, read only". Anything that raises what a
teammate can do (tools, budget, approval mode) asks its owner or an admin first.

Teammates that browse websites need the large computer image, built once: `./peeblo image large` (about 4.4 GB
with Docker running).

## On a Linux server

Everything runs in Docker Compose. The server needs `/dev/kvm` (bare metal, or a VM with nested virtualization)
for teammate computers.

```bash
sudo apt install docker.io docker-compose-v2 git      # or Docker's own packages
sudo usermod -aG docker $USER                          # then log in again
git clone <this repo> peeblo && cd peeblo
./peeblo up                                            # writes .env, then stops: fill in the five settings
./peeblo up                                            # builds the image and the small computer image, starts
./peeblo check
./peeblo slack-app
./peeblo image large                                   # only for teammates that browse (it lends Docker for this command)
```

- `PEEBLO_SLACK_CONFIG_FILE` is a path on the server; Peeblo reads it once and keeps the token sealed.
- Put a reverse proxy with TLS (Caddy, nginx) in front of the ingress port (`8787`) for `PEEBLO_PUBLIC_URL`. Keep
  `7340` (the console and API) private: open it with `ssh -L 7340:127.0.0.1:7340 <server>`.
- `./peeblo logs`, `./peeblo backup`, `./peeblo upgrade` work the same as on a Mac.

## Connectors

Teammates use tools through MCP servers stored in Otari. Services with their own MCP server work as soon as you add
them in Otari. HubSpot, Google Sheets, Grafana, PagerDuty and Sentry have no MCP server that Otari can reach
directly yet, so they aren't available out of the box in this release.

**Events from Stripe or PagerDuty** ("if we get a dispute, tell me in #finance"): the service sends its events to
Peeblo once you set it up. In Stripe (Developers → Webhooks → Add endpoint) or PagerDuty (Integrations → Generic
Webhooks v3), send events to `https://<your public address>/hooks/source/stripe` (or `/pagerduty`), copy the
webhook's signing secret into `.env` as `PEEBLO_HOOK_SECRET_STRIPE` (or `_PAGERDUTY`), and restart. Other services
(GitHub and so on) get their own URL from the teammate when you ask for the trigger.

Stripe: an agent restricted key is subject to Stripe's own approval rules (Settings → Approvals → Rules). If you keep
the "Refund created" rule on, you approve twice: once on Peeblo's card, then again in Stripe.

## Day to day

- `./peeblo status`, `./peeblo logs`, `./peeblo down`. After pulling an update, run `./peeblo down` then
  `./peeblo up`.
- Approvals wait 30 minutes in a live conversation and 12 hours for scheduled work, then count as no.
- Money, deletes, shipping and posts outside the thread always ask, whatever a teammate's mode.
- Routines run on UTC times; Peeblo tells you the time in yours.
- Everything a teammate does is in the console under **Sessions**, with a receipt for each job.
