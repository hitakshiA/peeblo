---
name: working-in-repos
description: Work in a git repo: open your own checkout, commit, keep up with the base, resolve conflicts and publish a draft PR. Use for any change to a repo's files.
---

# Working in repos

Each conversation gets its own checkout of a repo on its own branch, so parallel conversations never step on each
other. Plain git works for everything local. Two tools exist where Peeblo has to act for you:

- `repo_open(repo, slug?, base?)` gives you a checkout on a new branch from the latest base. Your shell starts in
  it. Pass a short `slug` (`fix-login-redirect`) so people can read the branch name. Reopening returns the same
  checkout, restored if your computer was reset.
- `repo_publish(repo, pr?)` pushes your branch to GitHub and, with `pr: {title, body}`, opens a draft PR.

## The loop
1. `repo_open`, then read before you change: `git log --oneline -5`, `rg`, the README.
2. Make small commits with clear messages (`git add -p` or named paths, never blind `git add -A` over secrets).
3. Before publishing, catch up with the base on your own branch: `git fetch` isn't available (no credentials in
   your computer). Call `repo_open` again to refresh `origin/<base>`, then `git rebase origin/<base>`.
4. Resolve conflicts yourself: read both sides, keep what the base changed plus what you changed, run the tests,
   then `git rebase --continue`. Explain what you chose in the PR body.
5. `repo_publish` with a PR title that says what changed and a body that says why and how you checked it.

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
