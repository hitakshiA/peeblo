// The teammate's own view of its computer setup: it can read its builds and propose a recipe change,
// never apply one. A proposal is validated in code and trial-built in a build VM (the live computer is untouched);
// only a built proposal reaches the owner, as one approval. Approving writes the new config version, and the
// already-built disk is adopted at the next boundary (no second build).
import { askApproval } from "../durable/approvals.ts";
import { config } from "../config.ts";
import { pool } from "../db.ts";
import { normalizeRecipe, type Recipe } from "../environment/recipe-schema.ts";
import { buildStatus, queueBuild, waitForBuild } from "../environment/recipes.ts";
import { diskOf, isAwake, sleep } from "../environment/controller.ts";
import type { Tier } from "../environment/image.ts";
import { updateTeammate } from "../store/teammates.ts";
import { object } from "./schema.ts";
import type { AgentTool } from "./types.ts";
import { rmSync } from "node:fs";

// A patch adds to the current recipe: package lists and hosts are unioned, steps and files appended (a file at an
// existing path replaces it), env merged; `remove` takes packages out.
function applyPatch(cur: Recipe, patch: any): unknown {
  const uniq = (a: string[]) => [...new Set(a)];
  const rm = new Set<string>(Array.isArray(patch?.remove) ? patch.remove.map(String) : []);
  const pk = (k: "apk" | "apt" | "npm" | "pip") => uniq([...cur.packages[k], ...(patch?.packages?.[k] ?? [])]).filter((x) => !rm.has(x));
  const files = [...cur.files.filter((f) => !(patch?.files ?? []).some((n: any) => n?.path === f.path)), ...(patch?.files ?? [])];
  return {
    packages: { apk: pk("apk"), apt: pk("apt"), npm: pk("npm"), pip: pk("pip") },
    run: [...cur.run, ...(patch?.run ?? [])], files, env: { ...cur.env, ...(patch?.env ?? {}) },
    secrets: uniq([...cur.secrets, ...(patch?.secrets ?? [])]), network: { hosts: uniq([...cur.network.hosts, ...(patch?.network?.hosts ?? [])]) },
    verify: uniq([...cur.verify, ...(patch?.verify ?? [])]), start: [...cur.start, ...(patch?.start ?? [])],
  };
}
const list = (a: string[]) => (a.length ? a.join(", ") : "none");

export const recipeTools: AgentTool[] = [
  {
    name: "recipe_propose",
    description: "Propose a permanent change to your computer's setup (packages, setup steps, config files, services). Installs you make with apk/npm/pip in a session are lost at the next computer reset; a recipe makes them permanent. The change is trial-built first; if it builds, your owner approves it once.",
    input_schema: object({
      patch: { type: "object", description: "Added to the current recipe: {packages: {apk, npm, pip}, run: [{name, run}], files: [{path, content, mode}], env, secrets, network: {hosts}, verify, start: [{name, run, ready}], remove: [package]}. Pin versions (jq=1.8.1-r0, pnpm@9.15.4, uv==0.9.2).", additionalProperties: true },
      reason: { type: "string", description: "Why the change is needed, for your owner." },
    }),
    kind: "local",
    authorize(ctx) { return ctx.teammate.owner_person ? null : "This teammate has no owner to approve a setup change; ask an admin to set one."; },
    async run(ctx, a) {
      const cur = normalizeRecipe(ctx.teammate.config.computer?.recipe).recipe;
      const { recipe, problems } = normalizeRecipe(applyPatch(cur, a.patch));
      if (problems.length) return { text: `The recipe isn't valid: ${problems.join("; ")}. Fix the patch and propose again.`, isError: true };
      const size = (ctx.teammate.config.computer?.size ?? "small") as Tier;
      const q = await queueBuild(ctx.teammate.id, size, "trial", recipe);
      const b = await waitForBuild(q.id);
      if (b?.status !== "built" && b?.status !== "active") {
        return { text: `The trial build failed${b?.error ? `: ${String(b.error).slice(0, 600)}` : ""}. Nothing changed. Fix the patch (see the writing-recipes skill) and propose again.`, isError: true, data: { build_id: q.id, status: b?.status } };
      }
      if (!ctx.runId) return { text: "The trial build worked, but there is no run to ask the owner in.", isError: true };
      const newHosts = recipe.network.hosts.filter((h) => !cur.network.hosts.includes(h));
      const action = {
        kind: "recipe_change", teammate: ctx.teammate.slug, approvers: [ctx.teammate.owner_person], reason: a.reason, build_id: q.id,
        diff: { packages: { apk: list(recipe.packages.apk.filter((x) => !cur.packages.apk.includes(x))), npm: list(recipe.packages.npm.filter((x) => !cur.packages.npm.includes(x))), pip: list(recipe.packages.pip.filter((x) => !cur.packages.pip.includes(x))) }, run_steps: recipe.run.length - cur.run.length, files: recipe.files.map((f) => f.path), start: recipe.start.map((s) => s.name) },
        verify: b.verify ?? [], disk_mb: Math.round(Number(b.bytes ?? 0) / 1e6), new_build_hosts: newHosts, asked_by: ctx.person?.id ?? null,
      };
      const ok = await askApproval(ctx.runId, ctx.sessionId, action, config.approvalTtlSeconds);
      if (ok.status !== "approved") return { text: ok.status === "expired" ? "Your owner didn't answer in time; the setup is unchanged. The trial build stays ready if they approve later." : "Your owner said no; the setup is unchanged. Don't propose it again in this conversation.", isError: true };
      await updateTeammate(ctx.teammate.slug, { computer: { ...ctx.teammate.config.computer, recipe } } as any, { label: `recipe_propose (approved ${ok.approvalId})` }, a.reason);
      return { text: `Approved. The new setup is built (${action.disk_mb} MB) and becomes active the next time your computer starts with no other conversation open. Until then, keep using what you installed in this session.`, data: { build_id: q.id, approval_id: ok.approvalId } };
    },
  },
  {
    name: "build_status",
    description: "Read your computer's setup: the active recipe build and the latest builds, with their status and any error.",
    input_schema: object({}),
    kind: "read",
    async run(ctx) {
      const s = await buildStatus(ctx.teammate.id);
      const env = (await pool.query("SELECT pins, l2_reset_at FROM environments WHERE teammate_id = $1", [ctx.teammate.id])).rows[0];
      const lines = s.latest.map((b) => `- ${b.id} ${b.size} ${b.status}${b.purpose === "trial" ? " (trial)" : ""}${b.error ? `: ${String(b.error).slice(0, 200)}` : ""}`);
      return { text: `Active build: ${s.active?.id ?? "none (base image only)"}. Base image: ${JSON.stringify(env?.pins ?? {})}. Working disk last reset: ${env?.l2_reset_at ?? "never"}.\nLatest builds:\n${lines.join("\n") || "none"}`, data: s };
    },
  },
  {
    name: "computer_reset",
    description: "Throw away your computer's working disk (ad-hoc installs, caches, checkouts) and start again from your recipe. Committed and saved work in /workspace stays. Your owner must approve.",
    input_schema: object({ reason: { type: "string" } }),
    kind: "write",
    authorize(ctx) { return ctx.teammate.owner_person ? null : "This teammate has no owner to approve a reset."; },
    describe(ctx, a) { return { setting: "computer_reset", approvers: [ctx.teammate.owner_person], reason: a.reason }; },
    async run(ctx) {
      if (isAwake(ctx.teammate.id)) await sleep(ctx.teammate.id, "reset");
      const size = (ctx.teammate.config.computer?.size ?? "small") as Tier;
      rmSync(diskOf(ctx.teammate.slug, size), { force: true });
      await pool.query("UPDATE environments SET l2 = l2 - $2::text, l2_reset_at = now() WHERE teammate_id = $1", [ctx.teammate.id, size]);
      return { text: "Reset. Your computer starts from its recipe at the next command." };
    },
  },
];
