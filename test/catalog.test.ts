import { test } from "node:test";
import assert from "node:assert/strict";
import { isOpenWeight } from "../src/otari/catalog.ts";

test("open-weight families count as open", () => {
  for (const id of ["deepseek/deepseek-v4", "moonshotai/kimi-k3", "alibaba/qwen3-coder", "google/gemma-3", "mistralai/mistral-large-3", "bge-large"]) {
    assert.equal(isOpenWeight(id), true, id);
  }
});

test("closed models, and hosted-only members of open families, do not", () => {
  for (const id of ["openai/gpt-5", "google/gemini-3", "alibaba/qwen-max", "alibaba/qwen3.5-plus", "mistralai/mistral-large-2", "mistralai/mistral-medium"]) {
    assert.equal(isOpenWeight(id), false, id);
  }
});

test("open-weight models too old for agent work are never offered", () => {
  assert.equal(isOpenWeight("openai/gpt-oss-120b"), false);
});
