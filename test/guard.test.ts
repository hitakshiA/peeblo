import { test } from "node:test";
import assert from "node:assert/strict";
import { verdict } from "../src/guard.ts";

test("Qwen3Guard: Safe passes and Unsafe blocks", () => {
  assert.deepEqual(verdict("Safety: Safe\nCategories: None"), { safe: true, categories: [] });
  assert.deepEqual(verdict("Safety: Unsafe\nCategories: Violent"), { safe: false, categories: ["Violent"] });
});

test("Qwen3Guard: Controversial blocks only with a Jailbreak category", () => {
  assert.deepEqual(verdict("Safety: Controversial\nCategories: Politically Sensitive Topics"), {
    safe: true,
    categories: ["controversial", "Politically Sensitive Topics"],
  });
  assert.deepEqual(verdict("Safety: Controversial\nCategories: Jailbreak"), { safe: false, categories: ["controversial", "Jailbreak"] });
});

test("Llama Guard: safe, or unsafe with its category codes", () => {
  assert.deepEqual(verdict("safe"), { safe: true, categories: [] });
  assert.deepEqual(verdict("unsafe\nS7"), { safe: false, categories: ["S7"] });
});

test("anything not clearly safe counts as unsafe", () => {
  assert.equal(verdict("I cannot help with that").safe, false);
  assert.equal(verdict("").safe, false);
});
