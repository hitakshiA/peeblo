// Seam C: people and budgets, and per-teammate spend (own key + ceiling, or tag + pre-flight).
// Key mode needs a dashboard session (run j-admin.ts first, or sign in from the console).
import { check, expect, save } from "./harness.ts";
import { migrate, pool } from "../../src/db.ts";
import { otari, OtariError } from "../../src/otari/client.ts";
import { budgetRefusal, budgetReply, endUser, ensureEndUser, tiers } from "../../src/otari/people.ts";
import { capCheck, personSpend, retireTeammateKey, teammateKey } from "../../src/otari/spend.ts";
import { session } from "../../src/otari/admin.ts";
import { createTeammate, getTeammate, updateTeammate } from "../../src/store/teammates.ts";

const S = "C";
await migrate();
const chat = (user: string, auth?: Record<string, string>, maxTokens = 400) =>
  otari("POST", "/chat/completions", { model: "deepseek/deepseek-v4.1-flash-1017", max_tokens: maxTokens, user, messages: [{ role: "user", content: "Write one sentence about budgets." }] }, { auth });

await check(S, "tiers the service key may assign", async (c) => {
  const t = await tiers();
  expect(t.some((x) => x.is_default), "no default tier");
  c.note("tiers", t.map((x) => `${x.name}=${x.max_budget}`));
});

await check(S, "a person over their tier gets Otari's refusal as a plain sentence", async (c) => {
  const cap = (await tiers()).find((x) => x.name === "peeblo-person-capcheck");
  expect(cap, "no capcheck tier");
  const person = `peeblo-check-cap-${Date.now().toString(36)}`;
  await ensureEndUser(person, "Budget check", cap.budget_id);
  let refusal = null;
  for (let i = 0; i < 12 && !refusal; i++) {
    // Otari holds back the estimate for max_tokens; a long allowance does not fit the $0.0005 tier.
    try { const r = await chat(person, undefined, 4000); c.ids.push(r.requestId!); }
    catch (e) {
      const o = e as OtariError;
      if (o.status !== 403) throw e;
      c.ids.push(o.requestId!);
      refusal = budgetRefusal(o.status, o.headers, o.body);
    }
  }
  expect(refusal && refusal.scope === "user" && Number.isFinite(refusal.estimate) && Number.isFinite(refusal.remaining),`no parsed refusal: ${JSON.stringify(refusal)}`);
  const text = budgetReply(refusal, "Scout");
  expect(text.includes("your personal Otari budget") && text.includes("$"), text);
  c.note("reply", text);
  c.note("spend", (await endUser(person))?.spend);
});

await check(S, "a teammate's own key with its own ceiling (key mode)", async (c) => {
  expect(await session(), "no dashboard session; run j-admin.ts first");
  process.env.PEEBLO_TEAMMATE_SPEND = "key";
  const slug = `check-spend-${Date.now().toString(36)}`;
  let tm = await createTeammate(slug, { name: "Spend check", role: "checks spend", model: { default: "deepseek/deepseek-v4.1-flash-1017" }, budget: { monthly_usd: 0.3 } }, { personId: null, label: "otari-check" });
  try {
    const k = await teammateKey(tm);
    expect(k, "no key made");
    const auth = { authorization: `Bearer ${k.secret}` };
    const b = (await otari<any>("GET", "/key/budget", undefined, { auth })).data;
    expect(b.limits?.some((l: any) => Number(l.limit_usd) === 0.3), `ceiling not 0.3: ${JSON.stringify(b.limits)}`);
    const r = await chat("slack-T0CFKBN3YPM-U0CGL01BU72", auth);
    c.ids.push(r.requestId!);
    tm = await updateTeammate(slug, { budget: { monthly_usd: 0.4 } }, { label: "otari-check" });
    await teammateKey(tm);
    const b2 = (await otari<any>("GET", "/key/budget", undefined, { auth })).data;
    expect(b2.limits?.some((l: any) => Number(l.limit_usd) === 0.4), `ceiling did not follow the budget: ${JSON.stringify(b2.limits)}`);
    c.note("limits", [b.limits?.map((l: any) => l.limit_usd), b2.limits?.map((l: any) => l.limit_usd)]);
  } finally {
    await retireTeammateKey(tm.id);
    await pool.query("UPDATE teammates SET archived_at = now() WHERE id = $1", [tm.id]);
  }
});

await check(S, "the cap check refuses a call over the teammate's monthly budget", async (c) => {
  const scout = await getTeammate("scout");
  expect(scout, "no scout teammate");
  const over = await capCheck({ ...scout, config: { ...scout.config, budget: { monthly_usd: 0.0001 } } }, null, "deepseek/deepseek-v4.1-flash-1017", 0.001);
  expect(over?.scope === "teammate", `expected a teammate refusal at $0.0001: ${JSON.stringify(over)}`);
  const fine = await capCheck({ ...scout, config: { ...scout.config, budget: { monthly_usd: 50 } } }, null, "deepseek/deepseek-v4.1-flash-1017", 0.001);
  expect(fine === null, `expected room at $50: ${JSON.stringify(fine)}`);
  c.note("message", over.message);
});
await check(S, "the cap check holds a person's tier across teammate keys", async (c) => {
  const scout = (await getTeammate("scout"))!;
  const tiny = (await tiers()).find((x) => x.name === "peeblo-person-capcheck")!;
  const capped = `peeblo-check-cross-${Date.now().toString(36)}`;
  await ensureEndUser(capped, "Cross-key check", tiny.budget_id);
  const refused = await capCheck({ ...scout, config: { ...scout.config, budget: { monthly_usd: 50 } } }, capped, "deepseek/deepseek-v4.1-flash-1017", 0.001);
  expect(refused?.scope === "user" && refused.cap === 0.0005, `expected a person refusal at the $0.0005 tier: ${JSON.stringify(refused)}`);
  const owner = await personSpend("slack-T0CFKBN3YPM-U0CGL01BU72");
  expect(owner.cap !== null, "the owner has no tier");
  c.note("refused", refused.message);
  c.note("owner_spent_today_all_keys", owner.spent);
});
await pool.end();
process.exit((await save(S)) ? 0 : 1);
