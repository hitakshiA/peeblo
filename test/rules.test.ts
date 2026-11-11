import { test } from "node:test";
import assert from "node:assert/strict";
import { localCheck, parseGates, policyYaml } from "../src/otari/rules.ts";

test("parseGates reads every gate of the shipped policy", () => {
  const gates = parseGates(policyYaml().yaml);
  assert.ok(gates.length >= 7);
  const push = gates.find((g) => g.id === "ask-before-push");
  assert.equal(push?.enforcement, "advisory");
  assert.deepEqual(push?.forbidden, ["git push"]);
  assert.ok(gates.find((g) => g.id === "no-secret-files")?.forbidden.includes("**/.env"));
});

test("localCheck applies the same policy when Otari is unreachable", () => {
  const y = policyYaml().yaml;
  assert.equal(localCheck(y, ["git push --force origin main"], [], "pre_tool_use.edit_target").blocked, true);
  const push = localCheck(y, ["git push origin feature"], [], "pre_tool_use.edit_target");
  assert.equal(push.blocked, false);
  assert.ok(push.results.some((r) => r.gate_id === "ask-before-push" && r.outcome === "fail"));
  // GitHub reads don't ask; writes do.
  assert.ok(localCheck(y, ["gh pr view 12"], [], "pre_tool_use.edit_target").results.every((r) => r.outcome !== "fail"));
  assert.ok(localCheck(y, ["gh pr merge 12"], [], "pre_tool_use.edit_target").results.some((r) => r.outcome === "fail"));
  assert.equal(localCheck(y, [], ["sessions/x/.env"], "pre_tool_use.read_target").blocked, true);
  assert.equal(localCheck(y, [], ["sessions/x/notes.md"], "pre_tool_use.read_target").blocked, false);
});
