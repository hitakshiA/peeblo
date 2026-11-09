# Setting up Peeblo

From a fresh machine to a teammate answering in Slack: one command, then your browser.

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

Everything else is set up in your browser.

## 1. Start it

```bash
git clone <this repo> peeblo && cd peeblo
./peeblo up
```

It prints the console's address: `http://127.0.0.1:7340/console/`. Open it in your browser (on a server, first
`ssh -L 7340:127.0.0.1:7340 <server>`). The console stays on this machine; it's never on the public address.

## 2. Follow the setup in the console

The console walks you through six steps and checks each one live. What you'll need for each:

1. **A console password** you choose.
2. **An Otari service key.** In Otari: Keys → New key → Service key, and give it a default end-user budget (a tier
   in Budgets, for example $2 a day; every person in Slack gets one). Paste it in.
3. **Your Otari dashboard login**, once, so Peeblo can set itself up in your Otari: a routing policy per role, a key
   and spend ceiling per teammate, the guardrail screening, connector access. The password isn't stored.
4. **The Otari checklist.** The console checks what Peeblo needs and links each fix in Otari's dashboard: web search
   and code execution on (Tools), a Lakera guardrail named **`peeblo-lakera`** (Guardrails), and your connectors
   (Tools → MCP servers: Linear, GitHub, Stripe, Notion, PostHog, Intercom, … any service with an MCP server).
5. **A public address** Slack can reach: a domain with HTTPS in front of port `8787`, or a tunnel to it.
6. **Slack.** At [api.slack.com/apps](https://api.slack.com/apps), under **Your App Configuration Tokens**, generate
   a token for your workspace and paste both parts. Then **Create Peeblo's Slack app** and **Add Peeblo to Slack**.
   Whoever adds it becomes Peeblo's first admin.

`./peeblo check` shows the same checks in the terminal, any time.

## 3. Say hello

Peeblo DMs you in Slack: what it can already reach and what to do next.

## 4. Your first teammate

In Slack, DM Peeblo:

> I need a teammate who keeps an eye on our Linear issues and summarizes them when I ask.

Peeblo may ask a question, then shows the new teammate's ID card. Approve it, click **Add … to Slack** on the card,
and the teammate introduces itself. Every teammate works only through its own Slack app.

Give a teammate more tools by asking Peeblo: "give Quill github too, read only". Anything that raises what a
teammate can do (tools, budget, approval mode) asks its owner or an admin first.

Teammates that browse websites need the large computer image, built once: `./peeblo image large` (about 4.4 GB
with Docker running).

## On a Linux server

Everything runs in Docker Compose. Teammate computers are small virtual machines, so the server needs `/dev/kvm`:
bare metal, or a cloud VM with nested virtualization.

### The network, in one picture

```
Slack ──HTTPS 443──▶ Caddy (TLS) ──▶ 127.0.0.1:8787  Peeblo ingress (events, clicks, sign-in callback)
you   ──SSH 22 ───▶ tunnel      ──▶ 127.0.0.1:7340  Peeblo console + API (never public)
Peeblo ──HTTPS out──▶ otari.ai, slack.com (and package registries for teammate computers)
```

Open to the internet: **443** (and **80**, so Caddy can get its certificate). Open to you only: **22**. Never open:
7340 (console), 8787 (Caddy fronts it), 55432 (database: it isn't published on Linux at all).

### Example: AWS (what we run, about $85 a month)

1. **Instance:** `m8i.large` (2 vCPU, 8 GB; the c8i, m8i and r8i families support nested virtualization), Ubuntu
   24.04, a 40 GB gp3 disk. Turn nested virtualization on at launch:
   ```bash
   aws ec2 run-instances --instance-type m8i.large --image-id <ubuntu-24.04-ami> --key-name <your-key> \
     --security-group-ids <sg> --cpu-options NestedVirtualization=enabled \
     --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=40,VolumeType=gp3}'
   ```
   Check after login: `ls -l /dev/kvm` must exist.
2. **Security group:** inbound TCP 22 from your IP only; TCP 80 and 443 from anywhere. Nothing else.
3. **A name for the server:** point a DNS A record (e.g. `peeblo.example.com`) at its public IP. To try it without
   a domain, `<ip-with-dashes>.sslip.io` (e.g. `44-200-237-52.sslip.io`) resolves to that IP and gets a real certificate.

### Install

```bash
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git caddy
sudo usermod -aG docker $USER && exit                     # log in again so the docker group applies
git clone <this repo> peeblo && cd peeblo
./peeblo up                                               # builds the image and the small computer image, then starts
```

HTTPS: write `/etc/caddy/Caddyfile` with your name, reload, and check it answers:

```
peeblo.example.com {
  reverse_proxy 127.0.0.1:8787
}
```
```bash
sudo systemctl reload caddy
curl -I https://peeblo.example.com/                      # a certificate and any answer from Peeblo means it works
```

The console, from your laptop:

```bash
ssh -L 7340:127.0.0.1:7340 ubuntu@<server>              # keep it open, then browse http://127.0.0.1:7340/console/
```

In the console's setup, the public address is `https://peeblo.example.com`. Then follow [step 2](#2-follow-the-setup-in-the-console).
`./peeblo image large` builds the browser computer, only if a teammate needs to browse websites.

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
