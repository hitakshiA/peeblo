import { test } from "node:test";
import assert from "node:assert/strict";
import { filterMiss } from "../src/triggers.ts";

test("filterMiss: null when every field matches, by event name or dotted path", () => {
  const filter = { event: "deployment_status", "deployment_status.state": "success" };
  assert.equal(filterMiss(filter, "deployment_status", { deployment_status: { state: "success" } }), null);
  assert.equal(filterMiss({ event: ["a", "b"] }, "b", {}), null);
  // Values compare as text.
  assert.equal(filterMiss({ a: 1 }, "x", { a: "1" }), null);
});

test("filterMiss: names the first field that doesn't match", () => {
  assert.equal(filterMiss({ "deployment.environment": "production" }, "x", { deployment: { environment: "staging" } }), 'deployment.environment is "staging", wants "production"');
  assert.match(filterMiss({ "a.b.c": "1" }, "x", {}) ?? "", /^a\.b\.c is undefined/);
});
