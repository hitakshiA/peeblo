import { test } from "node:test";
import assert from "node:assert/strict";
import { minorDigits } from "../src/slack/approval-card.ts";
import { money } from "../src/slack/look.ts";

test("money: cents above a cent, a few places below, one digit for tiny costs", () => {
  const cases: [number, string][] = [[0, "$0"], [0.00007, "$0.00007"], [0.0012345, "$0.0012"], [0.01, "$0.01"], [12.5, "$12.50"]];
  for (const [usd, text] of cases) assert.equal(money(usd), text);
});

test("minorDigits: decimal places of a currency's smallest unit", () => {
  assert.equal(minorDigits("USD"), 2);
  assert.equal(minorDigits("JPY"), 0);
  assert.equal(minorDigits("BHD"), 3);
  assert.equal(minorDigits(null), 2);
  assert.equal(minorDigits("not-a-currency"), 2);
});
