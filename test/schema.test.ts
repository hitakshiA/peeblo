import { test } from "node:test";
import assert from "node:assert/strict";
import { object, validate } from "../src/agent-tools/schema.ts";

const spec = object({
  text: { type: "string" },
  n: { type: ["integer", "null"], minimum: 1, maximum: 5 },
  kind: { type: "string", enum: ["a", "b"] },
  tags: { type: "array", items: { type: "string" }, maxItems: 2 },
});
const good = { text: "x", n: null, kind: "a", tags: [] };

test("object() makes every property required and allows no extra keys", () => {
  assert.deepEqual(spec.required, ["text", "n", "kind", "tags"]);
  assert.equal(spec.additionalProperties, false);
});

test("a valid call has no problem", () => {
  assert.equal(validate(spec, good), null);
  assert.equal(validate({ type: "number" }, 3), null);
});

test("each problem is phrased so the model can fix its next call", () => {
  const cases: [unknown, string][] = [
    [null, "arguments must be object, got null"],
    [{ text: "x", n: 1, kind: "a" }, "arguments.tags is missing (send null if you have no value)"],
    [{ ...good, z: 1 }, "arguments.z is not a field of this tool"],
    [{ ...good, text: 1 }, "arguments.text must be string, got integer"],
    [{ ...good, n: 1.5 }, "arguments.n must be integer or null, got number"],
    [{ ...good, n: 0 }, "arguments.n must be at least 1"],
    [{ ...good, n: 9 }, "arguments.n must be at most 5"],
    [{ ...good, kind: "c" }, 'arguments.kind must be one of "a", "b"'],
    [{ ...good, tags: ["1", "2", "3"] }, "arguments.tags can have at most 2 items"],
    [{ ...good, tags: [1] }, "arguments.tags[0] must be string, got integer"],
  ];
  for (const [value, problem] of cases) assert.equal(validate(spec, value), problem);
});
