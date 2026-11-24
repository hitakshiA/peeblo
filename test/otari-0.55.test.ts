import { test } from "node:test";
import assert from "node:assert/strict";
import { blockedReply, guardrailRefusal, plainCategories } from "../src/rules/guard.ts";
import { explainError } from "../src/otari/errors.ts";
import { challengeFor, clientId, keyStopped } from "../src/otari/own-account.ts";

test("guardrail refusal: keeps the categories Otari says fired", () => {
  const body = JSON.stringify({
    detail: {
      message: "Request blocked",
      code: "guardrail_violation",
      guardrails: [
        { profile: "peeblo-lakera", score: 0.97, categories: ["prompt_attack", "pii/phone_number"] },
        { profile: "other", score: null, categories: ["prompt_attack"] },
      ],
    },
  });
  assert.deepEqual(guardrailRefusal(403, body), {
    profile: "peeblo-lakera",
    score: 0.97,
    categories: ["prompt_attack", "pii/phone_number"],
  });
  // An older gateway names nothing.
  assert.deepEqual(guardrailRefusal(403, '{"detail":{"code":"guardrail_violation","guardrails":[{"profile":"x"}]}}')?.categories, []);
  assert.equal(guardrailRefusal(402, body), null);
});

test("guardrail categories read as plain words, and the reply says them", () => {
  assert.equal(plainCategories(["prompt_attack", "pii/phone_number"]), "an attempt to override the AI's instructions and a phone number");
  assert.equal(plainCategories(["moderated_content/self_harm"]), "self harm");
  assert.equal(plainCategories(["S7"]), null);
  assert.match(blockedReply("Lakera", ["unknown_links"]), /flagged it as a link to a site it doesn't know\./);
  assert.match(blockedReply("Lakera"), /flagged it as unsafe, for example/);
});

test("a failed model call keeps Otari's own reason", () => {
  assert.equal(
    explainError('model error: 504 {"detail":"The last candidate timed out; the 2 earlier candidates refused the request."}'),
    "Otari couldn't get an answer in time. The last candidate timed out; the 2 earlier candidates refused the request.",
  );
  assert.equal(
    explainError('400 {"detail":"No model accepted the request (3 attempts): temperature is not supported"}'),
    "Otari refused the call. No model accepted the request (3 attempts): temperature is not supported",
  );
  assert.match(explainError('402 {"detail":{"message":"Insufficient credits"}}'), /no credit left\. Insufficient credits$/);
  assert.equal(explainError("model error: socket hang up"), "socket hang up");
});

test("own account: PKCE challenge, client id and a key Otari stopped accepting", () => {
  // RFC 7636 appendix B.
  assert.equal(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  assert.equal(clientId("https://peeblo.example.com/some/path/"), "https://peeblo.example.com");
  assert.equal(clientId("https://peeblo.example.com:443"), "https://peeblo.example.com");
  assert.equal(clientId(""), null);
  assert.equal(keyStopped(401, "{}"), true);
  assert.equal(keyStopped(403, '{"detail":"API key has been revoked"}'), true);
  assert.equal(keyStopped(402, '{"detail":"Insufficient credits"}'), false);
});
