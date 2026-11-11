import assert from "node:assert/strict";
import { test } from "node:test";

test("a plan card's body fits Slack's 200 characters, however long the plan", async () => {
  const { cardBlocks } = await import("../src/slack/approval-card.ts");
  const steps = Array.from(
    { length: 4 },
    (_, i) =>
      `${i + 1}. Refund $99.00 on a customer's duplicate charge ch_${"x".repeat(24)} (Growth plan, a duplicate of the charge 5 s earlier)`,
  );
  const blocks = await cardBlocks(
    { kind: "plan", title: "Refund the duplicates", summary: steps.join("\n"), steps: steps.map((s) => ({ action: s, tool: "stripe" })) },
    "ap_test",
    "Ledger",
  );
  const card = blocks.find((b) => b.type === "card");
  assert.ok(card.body.text.length <= 200, `body is ${card.body.text.length} characters`);
  assert.ok(card.title.text.length <= 150);
});
