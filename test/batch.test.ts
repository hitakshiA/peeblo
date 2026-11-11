import assert from "node:assert/strict";
import { test } from "node:test";
import { parseItems } from "../src/agent-tools/batch.ts";

test("batch inputs: one prompt per line, blank lines skipped", () => {
  assert.deepEqual(parseItems("refund late\n\nlogin broken\n", ".txt"), [
    { id: "r1", prompt: "refund late" },
    { id: "r3", prompt: "login broken" },
  ]);
});

test("batch inputs: jsonl objects keep their ids, strings get one", () => {
  const text = '{"id": 42, "prompt": "a"}\n"b"\n{"text": "c"}\n{"other": 1}\n';
  assert.deepEqual(parseItems(text, ".jsonl"), [
    { id: "42", prompt: "a" },
    { id: "r2", prompt: "b" },
    { id: "r3", prompt: "c" },
  ]);
});

test("batch inputs: a repeated id is refused", () => {
  assert.throws(() => parseItems('[{"id": "x", "prompt": "a"}, {"id": "x", "prompt": "b"}]', ".json"), /used twice/);
});
