import { test } from "node:test";
import assert from "node:assert/strict";
import { argClass, modeRule, NEVER_WITHOUT_ASKING, riskOf, type Risk } from "../src/reviewer.ts";
import { tool } from "./helpers.ts";

test("riskOf: the connector's own kind wins for reads and destructive calls", () => {
  assert.equal(riskOf(tool("stripe", "anything"), {}, "read"), "read");
  assert.equal(riskOf(tool("linear", "create_issue"), {}, "destructive"), "destructive");
});

test("riskOf: Stripe's meta-tool is read by its operation", () => {
  const write = tool("stripe", "stripe_api_write");
  assert.equal(riskOf(write, { stripe_api_operation_id: "PostRefunds" }, "write"), "money");
  assert.equal(riskOf(write, { stripe_api_operation_id: "DeleteCustomersCustomer" }, "write"), "destructive");
  assert.equal(riskOf(write, { stripe_api_operation_id: "PostCustomersCustomer" }, "write"), "write");
});

test("riskOf: tool names map to shipping, destructive and outside-the-thread", () => {
  assert.equal(riskOf(tool("github", "merge_pull_request"), {}, "write"), "shipping");
  assert.equal(riskOf(tool("linear", "delete_issue"), {}, "write"), "destructive");
  assert.equal(riskOf(tool("slack", "post_message"), {}, "write"), "outside_thread");
  assert.equal(riskOf(tool("linear", "create_comment"), {}, "write"), "write");
  // Posting counts as outside the thread only on messaging servers.
  assert.equal(riskOf(tool("github", "post_comment"), {}, "write"), "write");
});

test("argClass: a grant covers the same repo, Stripe operation or PostHog command", () => {
  assert.equal(argClass(tool("github", "create_issue"), { owner: "Acme", repo: "Web" }), "acme/web");
  assert.equal(argClass(tool("stripe", "stripe_api_write"), { stripe_api_operation_id: "PostRefunds" }), "PostRefunds");
  assert.equal(argClass(tool("linear", "create_issue"), { teamId: "T1" }), "T1");
  assert.equal(argClass(tool("posthog", "exec"), { command: "  call query-trends {}" }), "call query-trends");
  assert.equal(argClass(tool("notion", "create_page"), {}), null);
});

test("modeRule: what each mode does with each risk, before the reviewer", () => {
  const risks: Risk[] = ["read", "write", "money", "destructive", "shipping", "outside_thread"];
  const table = Object.fromEntries((["ask", "auto", "trusted", "yolo"] as const).map((m) => [m, risks.map((r) => modeRule(m, r))]));
  assert.deepEqual(table, {
    ask: ["allow", "card", "card", "card", "card", "card"],
    auto: ["allow", "review", "card", "card", "card", "card"],
    trusted: ["allow", "allow", "card", "card", "card", "card"],
    yolo: ["allow", "allow", "allow", "allow", "allow", "allow"],
  });
});

test("the never-without-asking set", () => {
  assert.deepEqual(NEVER_WITHOUT_ASKING, ["money", "destructive", "shipping", "outside_thread"]);
});
