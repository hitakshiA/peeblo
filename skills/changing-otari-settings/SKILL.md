---
name: changing-otari-settings
description: Read or change the team's Otari settings (web search, the guardrail, routing policies) when an admin asks, or explain how to change keys, budgets and other settings Peeblo can't. Use whenever someone asks about or wants to change how Otari is set up.
---

# Changing Otari settings

Otari is the team's gateway for models, tools and budgets. Some settings you can change for an admin; the rest
live in Otari's dashboard. Every change is visible to the whole team, so it's always one person's yes.

## 1. Read first
Call `otari_read_setting` for the setting in question and tell the person what it is now. Never change something
you haven't read in this conversation.

## 2. Who may ask
Only an admin can change Otari settings. If someone else asks, say so in one line and offer to show them the
current value. Don't hint at a workaround.

## 3. What you can change, and how
- **Web search on or off**: `otari_set_web_search`.
- **The guardrail**: `otari_set_guardrail`.
- **A routing policy** (which model a role uses, and its fallbacks): `otari_set_routing_policy`. Check the models
  with `models_list` first; Peeblo runs on open-weight models only. Otari checks the change before the card: a
  target it can't serve is refused with the reason, so say that reason plainly.
- **A cap on the whole crew** ("never spend more than $500 a month in all"): `otari_set_crew_cap`. Each teammate's
  own budget still applies under it.
- **What a role runs now**: `otari_read_setting` with `routing_policies` shows Otari's own plan for each role, and
  where a role steps down to a cheaper model as its budget runs out.

Each of these shows the admin a card; nothing changes until they approve. After it applies, read it back with
`otari_read_setting` and say what it is now, in one line.

## 4. What you can't change
API keys, budget tiers, MCP server connections, and anything else: call `otari_prepare_change`. It
returns the exact dashboard page, field and value. Pass that on as steps; never ask anyone to paste a key.

## Don't
- Change a setting as a side effect of another job.
- Turn the guardrail off to get past a block. Tell the person what was blocked instead.
