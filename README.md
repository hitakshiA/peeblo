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
- Big jobs run for hours: background builds and tests, helpers working in parallel, files handed back in the thread.

## One wallet, many agents, many people

Every model call, tool, connector, budget and guardrail goes through [Otari](https://otari.ai).
Each teammate gets its own Otari key with a spending ceiling, and each person their own budget on it.
Heavy work moves to a cheaper model as its budget runs down; when a teammate is out, the owner gets a Raise button, and the job runs again.
Read-only is held twice: Peeblo never offers the write tools, and Otari refuses them once a server's default access is "read tools" (the console checks).
The models are open-weight. How it all fits: [docs/OTARI.md](docs/OTARI.md).

## Run it

On a Mac with Apple silicon, or a Linux server with KVM (an AWS `m8i.large` works):

```bash
./peeblo up       # Postgres, core, the teammate computers, the console
```

Then open `http://127.0.0.1:7340/console/` and follow the setup there: your Otari key, Slack, a public address.
Everything after `up` happens in the browser. The console is never on the public address.

The full guide, with the server's network (ports, HTTPS, DNS, the SSH tunnel to the console):
[docs/SETUP.md](docs/SETUP.md).

`./peeblo backup` saves the database and memory. `./peeblo upgrade` waits until no job is running.

## Read more

- [docs/SETUP.md](docs/SETUP.md): from a fresh machine to a teammate in Slack.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how a message becomes a run, and where each rule is enforced.
- [docs/OTARI.md](docs/OTARI.md): how Peeblo uses Otari, the choices we made, and the limits we hit.
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md): every setting, with its default.
- [skills/](skills/): how teammates hire, reconcile numbers, handle approvals, and decide when to speak.
- [CONTRIBUTING.md](CONTRIBUTING.md): set up a dev copy, where things live, and what a good pull request has.
- [SECURITY.md](SECURITY.md): report a vulnerability privately.
- [CHANGELOG.md](CHANGELOG.md): what changed.
- [site/](site/): the landing page at [peeblo.xyz](https://peeblo.xyz).

## License

Apache-2.0.
