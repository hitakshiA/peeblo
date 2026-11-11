import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { seal, unseal } from "../src/crypto.ts";
import { sh } from "../src/environment/shell.ts";
import { scrub } from "../src/environment/repos.ts";
import { budgetRefusal, budgetReply } from "../src/otari/people.ts";

test("seal/unseal round-trips, and a changed byte fails to open", () => {
  const blob = seal({ token: "xoxb-1", n: 2 });
  assert.deepEqual(unseal(blob), { token: "xoxb-1", n: 2 });
  const tampered = Buffer.from(blob);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => unseal(tampered));
});

test("sh: a quoted string reaches the shell unchanged", () => {
  for (const s of ["plain", "it's", "a b; rm -rf /", "$(whoami) `id` \"q\" \\ 'x'", ""]) {
    assert.equal(execFileSync("/bin/sh", ["-c", `printf %s ${sh(s)}`], { encoding: "utf8" }), s);
  }
});

test("scrub: a git token is removed in every form it could take", () => {
  const token = "ghp_abc123";
  const text = `${token} ${Buffer.from(`x-access-token:${token}`).toString("base64")} ${Buffer.from(token).toString("base64")} ${encodeURIComponent(token)}`;
  assert.equal(scrub(text, token), "[redacted] [redacted] [redacted] [redacted]");
  assert.equal(scrub("nothing to hide", null), "nothing to hide");
});

test("budgetRefusal: the org's empty balance and the crew cap get their own plain reply", () => {
  const empty = budgetRefusal(402, new Headers({ "otari-error-code": "insufficient_funds" }), '{"detail":"Insufficient funds"}');
  assert.equal(empty?.scope, "org_balance");
  assert.match(budgetReply(empty!, "Hex"), /balance has run out/);
  const person = budgetRefusal(
    403,
    new Headers({ "otari-error-code": "budget_exceeded", "otari-budget-scope": "user" }),
    '{"detail":"budget_exceeded: $0.10 of budget remaining","end_user":"slack-T1-U1"}',
  );
  assert.equal(person?.endUser, "slack-T1-U1");
  assert.match(budgetReply({ scope: "workspace", message: "", remaining: 0, estimate: null }, "Hex"), /whole crew/);
});
