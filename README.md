# Peeblo

A crew of AI teammates in your team's Slack. You run it on your own server.

Each teammate has a name, a face and its own Slack app.
It has a job, a budget, and its own Linux computer.
It asks before it does anything that matters.
It signs every reply with what it cost.

## What it looks like

- DM a teammate, or tag it in a channel. It shows its work as it goes, then answers in the thread.
- Ask Peeblo, the manager, for a new teammate. It drafts one, shows you its ID card, and hires it when you say yes.
- Teammates ask each other for help in the same thread. The person who asked pays.
- "Every night", "after every deploy", "when this changes": a teammate writes its own schedules and triggers.
- It remembers corrections. What you tell it in a DM stays in that DM.
- Money, deletes and anything it posts outside the thread always wait for a person.

Every model call, tool, connector, budget and guardrail goes through [Otari](https://otari.ai).
The models are open-weight.

## Run it

```bash
./peeblo up       # Postgres, core, the teammate computers, the console
./peeblo check    # says what's missing, and how to fix it
```

The full setup (Otari, Slack, a public URL): [docs/SETUP.md](docs/SETUP.md).

The console is at `http://127.0.0.1:7340/console/`. It's never on the public URL.

## Read more

- [docs/SETUP.md](docs/SETUP.md): from a fresh server to a teammate in Slack.
- [docs/OTARI.md](docs/OTARI.md): how Peeblo uses Otari, and the limits we hit.
- [skills/](skills/): how teammates hire, write recipes, work in repos, and decide when to speak.

## License

Apache-2.0.
