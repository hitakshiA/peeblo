---
name: writing-recipes
description: Make a computer setup permanent. Use when you installed something ad hoc and will need it again, when a job needs tools your computer lacks, or when a repo has setup hints (.devcontainer, mise.toml, .tool-versions, .cursor/environment.json).
---

# Writing recipes

Your computer has layers. What you install with `apk add` (or `apt-get install` on a Debian computer), `npm i -g` or `pip install` in a
session lands on the
working disk, which is thrown away at the next computer reset. A recipe is what survives: your owner approves it
once, and it is built into your computer.

## When to propose one
- You installed something in a session and will need it in other conversations.
- A job keeps failing for a missing tool.
- Don't propose for a one-off. Install it for this session and move on.

## How to write it
1. Prefer `packages` over `run`. Packages are declarative and cheap to review:
   `{"packages": {"apk": ["postgresql16-client"], "npm": ["pnpm@9.15.4"], "pip": ["uv==0.9.2"]}}`.
   System packages go under `apk` on Alpine and `apt` on Debian (`cat /etc/os-release` tells you which). A
   large computer is Debian when the host has Docker; list both if you aren't sure.
2. Pin versions (`pkg=1.2.3-r0` on apk, `pkg=1.2.3-1` on apt, `name@1.2.3`, `name==1.2.3`) so the same recipe builds the same computer.
3. Use `run` only for what no package manager does. Each step needs a `name`, runs as root in `/root`, and must
   be idempotent: running it twice changes nothing.
4. Put config files in `files` (`{"path": "/root/.npmrc", "content": "...", "mode": "0600"}`). For a credential,
   write `${secret:NAME}`. It becomes a placeholder that only works on the secret's own hosts; the real value
   never enters the computer.
5. Add hosts that only the build needs (a vendor's download site) to `network.hosts`. Your normal web access
   doesn't change.
6. Add `verify` commands (`jq --version`). They must pass, or the build fails and nothing changes.
7. Put services that must run on every start in `start` (`{"name": "postgres", "run": "...", "ready": "pg_isready"}`).

## Ready-made recipes
- **OCR for scanned PDFs (ocrmypdf).** Propose this patch as-is when a job needs text out of scanned pages and
  `tesseract` alone isn't enough:
  `{"packages": {"apt": ["ocrmypdf=16.7.0+dfsg1-3"], "apk": ["ocrmypdf"]}, "verify": ["ocrmypdf --version", "gs --version"]}`.
  In the reason, tell your owner it installs Ghostscript, which is licensed AGPL-3.0; that's why it isn't in the
  base computer.

## What doesn't belong in a recipe
- A repo's own dependencies (`pnpm install`, `uv sync`). Those belong in the repo's worktree setup, which runs per
  checkout and is skipped when the lockfile hasn't changed. Tell your owner if a repo needs one.
- Secrets as values, and anything on `/workspace`.

## Reading a repo's hints
`.devcontainer/devcontainer.json` (features, postCreateCommand), `mise.toml` or `.tool-versions` (tool versions)
and `.cursor/environment.json` tell you what a repo expects. Turn them into `packages` with pinned versions, not
copied shell.

## Proposing
Call `recipe_propose` with a patch (what to add) and a reason your owner will understand. It trial-builds first.
If the build fails, read the error, fix the patch, and propose once more; after a second failure, tell the person
what's missing. If it builds, your owner gets one approval. The new setup starts the next time your computer starts
with no other conversation open. `build_status` shows where things stand.
