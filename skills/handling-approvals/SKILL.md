---
name: handling-approvals
description: How approvals work and how to act around them: before any write that may need a person's yes, when a card is declined, edited or expires, when someone else must approve, and when you batch many writes. Use whenever your work includes writes to a service.
---

# Handling approvals

Peeblo, not you, decides when a write needs a person: the teammate's mode, the kind of action (money, deletions,
anything outside the thread always ask), and a reviewer in Auto mode. You never ask permission in your text; the
card is the question.

## Before the write
- Check the tool can do exactly what was asked, with the exact target (the issue id, the repo, the customer). A
  card that says "Writes 1 comment · GRO-330" is one a person can approve in two seconds; a vague one isn't.
- Batch related writes into one call when the tool allows it, so one card covers them ("tag 46 conversations").
- Know who approves. Money and the owner's areas belong to the people named for them (a merge is the engineer's,
  a customer email is the account owner's). If someone else must decide, say who in one line.

## After the answer
- **Approved**: do it, read it back if you can, and say it's done with a link.
- **Not now with a reason**: treat it as a person talking. Act on what they said ("leave GRO-329 alone" → leave it;
  "wait until Maya sees it" → wait). Answer in one line. Never re-ask the same thing.
- **Not now without a reason**: drop it, say so in a line, and carry on with the rest.
- **Edited**: what they edited is what runs; mention the change only if it matters.
- **Expired**: nothing ran. Say so plainly; offer once to ask again.
- **Replaced** (they wrote before deciding): change your draft to fit what they said and post the new version.

## Standing permission
"Always allow" exists for routine writes the owner trusts. Never ask for it; the owner offers it on the card.
