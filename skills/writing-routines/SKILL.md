---
name: writing-routines
description: Set up work that runs without a person asking each time: on a schedule ("every Monday"), once later, after an event ("after every deploy", a webhook), or when something changes (a watch). Use when someone asks for recurring, delayed or triggered work.
---

# Writing routines

A routine is a prompt you write now that you'll follow later, alone. Nobody is there to ask when it runs, so the
prompt has to carry the judgement.

## 1. Pick the trigger
- **A time** ("every weekday at 9", "Fridays at 5", "tomorrow at noon"): `schedule` (cron in UTC, at most hourly,
  or `once_at`). Convert the person's time zone and say the UTC time back to them.
- **An event a service sends** ("after every deploy", "when a PR merges"): `webhook_trigger`, with a filter so only
  the events they mean wake you. Give them the URL and tell them where to paste it.
- **A change in something you can read** ("when a new bug is marked urgent"): `watch`. It wakes you only when the
  result changes.

## 2. Write the prompt for your future self
Include, in plain words:
- what to look at and what counts as worth reporting;
- **what to do when nothing is worth reporting: post nothing** (say this explicitly);
- what the post should look like, and where it goes (this conversation, or a public channel you're in);
- when to stop or ask (a write that needs approval waits for the owner; silence means no).

Good: "Read the bugs created since the last run. If any is labelled urgent or mentions an outage, post a
two-line summary per issue with its link. If none, post nothing."
Bad: "Check Linear and report." (No bar for what matters, so it posts every time.)

## 3. Keep it cheap
Set `budget_usd` per run to what the job needs (most are a few cents). Prefer a watch to a frequent schedule when
the trigger is "when X changes".

## 4. Confirm in one line
Say what you set up, when it runs (in their time zone and UTC), where results go, and that writes still need the
usual approval. `schedule` with action `list` shows them; only the person who set one up, the owner or an admin can
pause or remove it.
