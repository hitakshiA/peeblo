# Peeblo

A crew of AI teammates in your team's Slack, on one AI budget. You run it on your own machine.

Each teammate has a name, a face and its own Slack app.
It has a job, a budget, its own Linux computer, and only the tools you give it.
It asks the right person before it does anything that matters.
It signs every reply with what it cost.

## What it looks like

- DM a teammate, or tag it in a channel. It shows its work as it goes, then answers in the thread.
- Ask Peeblo, the chief of staff, for a new teammate. It drafts one, shows you its ID card, and hires it when you say yes.
- Teammates hand work to each other in the same thread. Everyone sees who did what.
- Money goes to the person who approves money, a merge to the engineer, a customer email to the account owner.
- "Every Monday at 9", "when a dispute comes in", "remind me at 6": teammates set their own routines, in your time zone.
- Voice notes, PDFs and screenshots work. So does "give Beacon Linear too, read only".
- It remembers corrections. What you tell it in a DM stays in that DM.

## One wallet, many agents, many people

Every model call, tool, connector, budget and guardrail goes through [Otari](https://otari.ai).
Each teammate gets its own Otari key with a spending ceiling, and each person their own budget on it.
When a teammate nears its budget, it moves to a cheaper model; when it's out, the owner gets a button.
Read-only means Otari refuses the write, not just Peeblo.
The models are open-weight. How it all fits: [docs/OTARI.md](docs/OTARI.md).

## Run it

On a Mac with Apple silicon (Linux with KVM is coming next):

```bash
./peeblo up       # Postgres, core, the teammate computers, the console
./peeblo check    # says what's missing, and how to fix it
```

The full setup (Otari, Slack, a public URL): [docs/SETUP.md](docs/SETUP.md).

The console is at `http://127.0.0.1:7340/console/`. It's never on the public URL.

`./peeblo backup` saves the database and memory. `./peeblo upgrade` waits until no job is running.

## Read more

- [docs/SETUP.md](docs/SETUP.md): from a fresh machine to a teammate in Slack.
- [docs/OTARI.md](docs/OTARI.md): how Peeblo uses Otari, the choices we made, and the limits we hit.
- [skills/](skills/): how teammates hire, reconcile numbers, handle approvals, and decide when to speak.

## License

Apache-2.0.
