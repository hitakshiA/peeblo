---
name: answering-incident-questions
description: Judgement for "anything on fire?", "is checkout down?", "what happened overnight?", an alert or incident someone forwards, and incidents you're asked to coordinate. Use before you look at alerts, incidents or errors.
---

# Answering incident questions

The person wants to know whether to act. Everything else is detail.

## Where the truth is
- **PagerDuty** says what paged and whether it's still open. **Better Stack** says what users saw (monitors, the
  status page). **Sentry** says what broke in code. **Grafana** shows the shape (when it started, whether it's
  recovering). Look at the three that apply, once each, in parallel; a fourth look rarely changes the answer.
- Tools that take an org or project slug need the real one, never a guess: check company memory, or list them
  first (`sentry_organizations`, `sentry_projects`). A 404 usually means the slug is wrong; fix it and look once more.
- Who's on call: a person saying "that's me this week" wins over a schedule that's missing or out of date. Use
  them, and say the schedule disagrees only if it names someone else.
- The window matters: "overnight" means since the end of the working day, in the asker's time zone.

## Judging what's real
- **One place to follow.** In an incident, link the coordinating thread instead of starting another, so people
  don't split across threads.
- **Say a cause only when the evidence shows it.** Until then say what's known and what's being checked; a cause
  stated early sends people to fix the wrong thing.
- **A deploy window, if the team has one, is for routine releases.** An incident fix usually may ship outside it;
  check company memory for the team's rule. It still needs whoever approves deploys (the card asks them).
- **Still open and customer-facing** is wake-worthy. Resolved on its own with no action left is not.
- **Check history before calling something new.** The same alert most nights (the same check at the same hour,
  during a nightly job) is known noise; say so in a few words. A first-time alert, or a known one that
  behaves differently (longer, louder, at a new time), is news.
- Counts aren't severity. Ten auto-resolved pages are quieter than one open checkout error spike.

## How to answer
- **Verdict first**: "Nothing worth waking you." / "Yes: checkout 500s since 02:10, still open, the on-call has it."
- Then at most two short lines: what fixed itself, what's noise, what's open and who owns it. Link the incident.
- Leave out what you checked and how. Don't list every alert unless asked.

## Coordinating a live incident
- One thread, one owner, one current status line people can read in five seconds.
- Customer-facing words (status page, replies) go through approval; say what you'd post and why.
- Afterwards: a short timeline from the tools' own timestamps, and the follow-ups as tickets, not prose.
