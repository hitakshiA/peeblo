---
name: working-in-repos
description: Changing code in a repo you were given: your own checkout, running tests (many times for flaky ones), commits, keeping up with the base, conflicts, and a draft PR a person merges. Use for any change to a repo's files or any test run.
---

# Working in repos

Use the exact `owner/repo` names you were given (start context or memory). If you don't have them, list the repos
before guessing: one GitHub `search_repositories` call with `user:<login>` or `org:<org>` (`get_me` gives the login).

Each conversation gets its own checkout of a repo on its own branch, so parallel conversations never step on each
other. Plain git works for everything local. Two tools exist where Peeblo has to act for you:

- `repo_open(repo, slug?, base?)` gives you a checkout on a new branch from the latest base. Your shell starts in
  it. Pass a short `slug` (`fix-login-redirect`) so people can read the branch name. Reopening returns the same
  checkout, restored if your computer was reset.
- `repo_publish(repo, pr?)` pushes your branch to GitHub and, with `pr: {title, body}`, opens a draft PR.
- `repo_check(repo)` runs the repo's own guardrails on your branch, the same check `repo_publish` runs first.

## The repo's own guardrails
A repo can keep rules in `.otari/guardrails.yml` and `.otari/guardrails/*.yml` (read from the base, not your
branch). Read them right after `repo_open`; they say what every change needs:
- paths you may never touch or add, and commands you may never run (refused as you go);
- commands that must have run in this conversation after a matching change (a type check, the tests);
- verifier scripts under `.otari/verifiers/` that must pass on your branch (exit 0), e.g. a changelog line;
- review rubrics a judge reads against your diff (advisory: they're reported, they don't block).
Run `repo_check` before publishing and fix what fails. A required rule that fails stops the push; the refusal names
each rule and what it saw. Never edit a repo's guardrails to get past them: they're read from the base anyway.

## Flaky tests
A flaky test is a timing or ordering bug until proven otherwise. Reproduce it first: run it many times (40 is a
good number) and count failures. Read the failing output for the shared cause (a timer, a clock, an unawaited
promise, shared state). Fix the cause, not the test's timeout. Then run it 40 times again; "40/40" is the proof
that goes in the PR body, with the before count.

## The loop
1. `repo_open`, then read before you change: `git log --oneline -5`, `rg`, the README.
2. Make small commits with clear messages (`git add -p` or named paths, never blind `git add -A` over secrets).
3. Before publishing, catch up with the base on your own branch: `git fetch` isn't available (no credentials in
   your computer). Call `repo_open` again to refresh `origin/<base>`, then `git rebase origin/<base>`.
4. Resolve conflicts yourself: read both sides, keep what the base changed plus what you changed, run the tests,
   then `git rebase --continue`. Explain what you chose in the PR body.
5. `repo_check`, fix what it names, then `repo_publish` with a PR title that says what changed and a body that says
   why and how you checked it.

## Rules the harness enforces (don't fight them)
- You publish only your own branch. Pushing to main or the base, force pushes and tags are refused.
- After you have published, don't rewrite published commits (`--amend`, rebase of pushed commits). Add new commits
  on top; a rewritten branch is refused.
- `git push` from your shell is blocked. Use `repo_publish`.
- Your uncommitted work is saved after every turn, but only commits are shared. Commit before you stop.
- A person merges PRs. You never merge into the default branch.

## Other conversations
Each turn you're told which branches your other conversations have open and which paths they touch. If you're
both touching the same files, say so in your PR body, and keep your change narrow.

## Before proposing new work
Search open pull requests and issues touching the same files first: duplicate tickets and competing PRs cost
reviewers more than they save. Link what exists, and propose only what's missing.
