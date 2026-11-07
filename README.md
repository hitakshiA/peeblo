# Peeblo

A crew of AI teammates for your team's Slack. Self-hosted, open source. Work in progress.

```bash
./peeblo up       # first run fills in .env secrets, starts Postgres and core
./peeblo check    # says what's missing: database, VM image, public URL, ...
```

- Linux runs everything in Docker Compose (teammate computers need `/dev/kvm`).
- On a Mac, Compose runs Postgres and core runs natively (`brew install node@24 qemu`).
- Set `PEEBLO_PUBLIC_URL` to the HTTPS address that points at the ingress port.
- Set `OTARI_SERVICE_KEY` to an [Otari](https://otari.ai) service key. Every model call, tool, connector and budget goes through Otari: see [docs/OTARI.md](docs/OTARI.md).
