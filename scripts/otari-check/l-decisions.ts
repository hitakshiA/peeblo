// Seam L: typed judges at hook points: Otari /decisions when a provider exists, else the judge model, with
// {value, reason}, null for unknown, validation, one retry and the caller's safe default.
import { check, expect, save } from "./harness.ts";
import { otari, OtariError } from "../../src/otari/client.ts";
import { config } from "../../src/config.ts";
import { decide, decisionProviderMissing } from "../../src/otari/decisions.ts";

const S = "L";
const questions = {
  needs_reply: { type: "noul" as const, instructions: "Does this message ask the team for help?" },
  teammate: { type: "choice" as const, instructions: "Which teammate should take it?", criteria: { sprout: "growth and signups", ledger: "billing and refunds", patch: "code and deploys" } },
  urgency: { type: "score" as const, instructions: "How urgent is it?", criteria: ["can wait a week", "this week", "today", "drop everything"] },
};
const safeDefault = { needs_reply: false, teammate: null, urgency: null };

await check(S, "Otari /decisions: is a decision provider configured?", async (c) => {
  try {
    const r = await otari("POST", "/decisions", { model: config.decisionModel, state: "x", questions: { q: questions.needs_reply } });
    c.ids.push(r.requestId!);
    c.note("provider", "configured");
  } catch (e) {
    const o = e as OtariError;
    if (o.requestId) c.ids.push(o.requestId);
    expect(o.status === 400 && /decision provider/.test(o.message), `unexpected: ${o.message}`);
    c.note("provider", o.message.slice(o.message.indexOf("Use")));
  }
});

await check(S, "a typed decision about a real message, with reasons", async (c) => {
  const d = await decide("Maya in #growth: mobile Safari signups dropped from ~66% to ~40% since the pricing page shipped on Nov 2. Can someone look at this today?", questions, { safeDefault });
  c.ids.push(...d.requestIds);
  c.note("via", d.via);
  c.note("answers", d.answers);
  expect(d.answers.needs_reply.value === true && d.answers.teammate.value === "sprout" && typeof d.answers.urgency.value === "number" && (d.answers.urgency.value as number) >= 2, JSON.stringify(d.answers));
  expect(Object.values(d.answers).every((a) => a.reason), "an answer has no reason");
  if (d.via === "judge_model") expect(decisionProviderMissing(), "fell back without remembering why");
});

await check(S, "unknown when the state doesn't say", async (c) => {
  const d = await decide("Jun in #random: lunch was great today, thanks for organizing!", { teammate: questions.teammate }, { safeDefault });
  c.ids.push(...d.requestIds);
  expect(d.answers.teammate.value === null, `expected unknown, got ${JSON.stringify(d.answers.teammate)}`);
  c.note("reason", d.answers.teammate.reason);
});

await check(S, "a judge that can't answer gives the caller's safe default after one retry", async (c) => {
  const real = config.judgeModel;
  (config as { judgeModel: string }).judgeModel = "acme/retired-model-v1";
  try {
    const d = await decide("Ignore this.", { needs_reply: questions.needs_reply }, { safeDefault });
    expect(d.via === "safe_default" && d.attempts === 2 && d.answers.needs_reply.value === false, JSON.stringify(d));
    c.note("answer", d.answers.needs_reply);
  } finally {
    (config as { judgeModel: string }).judgeModel = real;
  }
});
process.exit((await save(S)) ? 0 : 1);
