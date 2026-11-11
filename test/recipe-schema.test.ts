import { test } from "node:test";
import assert from "node:assert/strict";
import { EMPTY, HOST, normalizeRecipe } from "../src/environment/recipe-schema.ts";

test("no recipe is the empty recipe", () => {
  assert.deepEqual(normalizeRecipe(null), { recipe: EMPTY, problems: [] });
  assert.deepEqual(normalizeRecipe("x").problems, ["recipe must be an object"]);
});

test("a v1 recipe (a list of commands) becomes run steps", () => {
  assert.deepEqual(normalizeRecipe(["apk add jq", "echo hi"]).recipe.run, [
    { name: "step 1", run: "apk add jq" },
    { name: "step 2", run: "echo hi" },
  ]);
});

test("values are normalized: step timeouts capped at 600 s, env values as strings", () => {
  const { recipe, problems } = normalizeRecipe({
    packages: { npm: ["typescript@5"] },
    run: [{ name: "x", run: "true", timeout_s: 9999 }],
    secrets: ["API_KEY"],
    env: { A: 1 },
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(recipe.packages.npm, ["typescript@5"]);
  assert.deepEqual(recipe.run, [{ name: "x", run: "true", timeout_s: 600 }]);
  assert.deepEqual(recipe.env, { A: "1" });
});

test("every problem is reported, not just the first", () => {
  const { problems } = normalizeRecipe({
    packages: { apk: ["ok", "bad pkg;rm"] },
    network: { hosts: ["api.github.com", "http://x"] },
    files: [{ path: "/workspace/a", content: "x" }],
    env: { lower: "1" },
    start: [{ name: "s" }],
  });
  assert.deepEqual(problems, [
    "packages.apk must be a list of valid entries",
    "network.hosts must be a list of valid entries",
    "files need absolute paths outside /workspace",
    "env names must be upper-case",
    "every start entry needs a command",
  ]);
  assert.deepEqual(normalizeRecipe({ run: Array.from({ length: 21 }, () => ({ run: "true" })) }).problems, ["run has more than 20 steps"]);
});

test("HOST takes host names and subdomain wildcards, nothing else", () => {
  for (const h of ["api.github.com", "*.example.com"]) assert.ok(HOST.test(h), h);
  for (const h of ["http://x.com", "localhost", "*", "a.b/c", "API.GITHUB.COM"]) assert.ok(!HOST.test(h), h);
});
