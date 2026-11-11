// Repos: plain git does the local work in the session's checkout; these two tools exist only where the
// harness must act or check. repo_open makes (or restores) the session's checkout on its own branch; repo_publish
// pushes that branch from the host-owned mirror and can open a draft PR. Branch names, refusals and the push
// itself are code (environment/repos.ts).
import { openRepo, publish, repoKey, reposOf } from "../environment/repos.ts";
import { object } from "./schema.ts";
import type { AgentTool } from "./types.ts";

export const repoTools: AgentTool[] = [
  {
    name: "repo_open",
    description:
      "Open one of your repos for this conversation: a checkout of its own on a new branch from the latest base (or reopen the one you have). Your shell then starts in it; use plain git there (status, diff, add, commit, rebase).",
    input_schema: object({
      repo: { type: "string" },
      slug: { type: ["string", "null"], description: "A few words for the branch name, e.g. fix-login-redirect." },
      base: { type: ["string", "null"], description: "Start from this branch instead of the repo's default base." },
    }),
    kind: "local",
    async run(ctx, a) {
      const r = await openRepo(ctx.teammate, ctx.sessionId, a.repo, a.slug, a.base);
      return {
        text: `${r.created ? "Opened" : r.restored ? "Restored (from your last saved state)" : "Already open:"} ${a.repo} at ${r.wt.path}, branch ${r.wt.branch}, based on origin/${r.wt.base} @ ${(r.wt.base_commit ?? "").slice(0, 10)}. Setup: ${r.setup}. Commit on this branch; publish with repo_publish.`,
        data: { path: r.wt.path, branch: r.wt.branch, base: r.wt.base },
      };
    },
  },
  {
    name: "repo_publish",
    description:
      "Publish your work for a repo: push your branch to GitHub and, with pr, open a draft pull request; or, with onto_pr, push your commits onto an open PR's branch in the same repo. Only new commits on top (no force pushes, no tags). Never push with git yourself.",
    input_schema: object({
      repo: { type: "string" },
      pr: {
        type: ["object", "null"],
        properties: { title: { type: "string" }, body: { type: ["string", "null"] } },
        required: ["title", "body"],
        additionalProperties: false,
      },
      onto_pr: {
        type: ["integer", "null"],
        description:
          "Push your commits onto this open pull request's branch (same repo) instead of your own branch, e.g. to add a fix to someone's PR. Your branch must contain the PR's latest commit: merge or rebase onto origin/<its branch> first.",
      },
    }),
    kind: "local",
    authorize(ctx, a) {
      return reposOf(ctx.teammate).some((r) => r.name === repoKey(ctx.teammate, String(a.repo)))
        ? null
        : `There's no repo called ${a.repo}.`;
    },
    // Pushing and opening a PR ships work outside the computer: a card in every mode but YOLO (the gate).
    outward: () => "shipping",
    describe(ctx, a) {
      return {
        summary: a.onto_pr
          ? `Push ${ctx.teammate.config.name}'s commits onto PR #${a.onto_pr} in ${a.repo}`
          : `Push ${ctx.teammate.config.name}'s branch of ${a.repo}${a.pr ? ` and open a draft PR "${a.pr.title}"` : ""}`,
      };
    },
    async run(ctx, a) {
      try {
        const r = await publish(
          ctx.teammate,
          ctx.sessionId,
          repoKey(ctx.teammate, String(a.repo)),
          a.pr && !a.onto_pr ? { title: a.pr.title, body: a.pr.body ?? "" } : null,
          a.onto_pr ?? null,
        );
        return { text: r.text, data: { commit: r.pushed, pr_url: r.pr_url } };
      } catch (e) {
        return { text: (e as Error).message, isError: true };
      }
    },
  },
];
