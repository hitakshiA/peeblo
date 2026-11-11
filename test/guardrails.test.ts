import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGuardFile } from "../src/environment/guardrails.ts";

const yaml = `schema_version: "1.0"
policy:
  id: sample
gates:
  - id: changelog
    type: verifier
    runs: [stop.verifier]
    enforcement: required
    verifier: .otari/verifiers/changelog.sh
    when_changed: ["src/**"]
    message: Add a changelog line.
  - id: plain-words
    type: judge
    runs: [stop.session]
    enforcement: advisory
    priority: 3
    rubric: |
      User-facing strings are plain English.
    message: Strings should be plain.
`;

test("a repo guardrail file: its gates, with verifier paths and rubrics", () => {
  const f = parseGuardFile(".otari/guardrails.yml", yaml);
  assert.equal(f.error, null);
  assert.deepEqual(
    f.gates.map((g) => [g.id, g.type]),
    [
      ["changelog", "verifier"],
      ["plain-words", "judge"],
    ],
  );
  assert.equal(f.gates[0].verifier, ".otari/verifiers/changelog.sh");
  assert.deepEqual(f.gates[0].when_changed, ["src/**"]);
  assert.equal(f.gates[1].rubric?.trim(), "User-facing strings are plain English.");
  assert.equal(f.hash.length, 16);
});

test("a repo guardrail file that isn't YAML is kept, with the reason", () => {
  const f = parseGuardFile(".otari/guardrails/bad.yml", "gates: [\n  - id: x");
  assert.equal(f.gates.length, 0);
  assert.ok(f.error);
});
