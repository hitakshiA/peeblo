// Seam A: client and catalog.
import { check, expect, save } from "./harness.ts";
import { keyBudget, otari, OtariError, requestUsage, usageSummary } from "../../src/otari/client.ts";
import { estimateCost, isOpenWeight, models, openWeightModels } from "../../src/otari/catalog.ts";

const S = "A";
await check(S, "catalog lists models with prices and context windows", async (c) => {
  const m = await models();
  expect(m.size > 50, `only ${m.size} models`);
  const ds = m.get("deepseek/deepseek-v4.1-flash-1017");
  expect(ds?.context_window && ds.pricing?.input_price_per_million !== undefined, "deepseek v4.1 flash has no window or price");
  c.note("models", m.size);
});
await check(S, "open-weight allowlist splits the catalog", async (c) => {
  const open = await openWeightModels();
  expect(open.length > 40, `only ${open.length} open-weight`);
  const want = ["moonshotai/kimi-k3.1-pro", "openai/gpt-oss-120b", "mistralai/mistral-large-4", "mistralai/mistral-large-3", "reflection/beam-1.0-501b-a23b", "alibaba/qwen3.8-27b"];
  const closed = ["anthropic/claude-fable-5", "xai/grok-4.7", "thinkingmachines/inkling", "thinkingmachines/inkling-small", "alibaba/qwen3.8-flash", "alibaba/qwen3.8-max", "mistralai/mistral-large-latest"];
  const wrong = [...want.filter((m) => !isOpenWeight(m)), ...closed.filter((m) => isOpenWeight(m))];
  expect(!wrong.length, `allowlist misclassifies ${wrong.join(", ")}`);
  c.note("open_weight", open.length);
});
await check(S, "price estimate before a run", async (c) => {
  const est = await estimateCost("deepseek/deepseek-v4.1-flash-1017", 10_000, 500);
  expect(est !== null && est > 0 && est < 0.01, `estimate ${est}`);
  c.note("estimate_usd_10k_in_500_out", est);
});
await check(S, "key budget", async (c) => {
  const b = await keyBudget();
  expect(typeof b.budgets_enforced === "boolean", "no budgets_enforced");
  c.note("remaining_usd", b.remaining_usd);
});
await check(S, "a call's settled usage by request id", async (c) => {
  const r = await otari("POST", "/chat/completions", { model: "deepseek/deepseek-v4.1-flash-1017", max_tokens: 5, messages: [{ role: "user", content: "Say ok." }] });
  expect(r.requestId, "no Otari-Request-ID");
  c.ids.push(r.requestId);
  let u = null;
  for (let i = 0; i < 10 && !u; i++) { u = await requestUsage(r.requestId); if (!u) await new Promise((x) => setTimeout(x, 1000)); }
  expect(u && Number(u.cost_usd) >= 0, "usage never settled");
  c.note("settled_cost_usd", u.cost_usd);
});
await check(S, "spend by teammate tag", async (c) => {
  const s = await usageSummary({ start: new Date(Date.now() - 24 * 3600_000), groupByTag: "teammate" });
  expect(Array.isArray(s.by_tag) && s.by_tag.some((t) => t.key === "scout"), "no teammate=scout row");
  c.note("scout_cost_24h", s.by_tag!.find((t) => t.key === "scout")!.cost);
});
await check(S, "errors carry status, code and request id", async (c) => {
  try { await otari("POST", "/chat/completions", { model: "acme/retired-model-v1", max_tokens: 5, messages: [{ role: "user", content: "x" }] }); throw new Error("expected a refusal"); }
  catch (e) { const o = e as OtariError; expect(o instanceof OtariError && o.status >= 400 && o.requestId, `bad error ${o.message}`); c.ids.push(o.requestId!); c.note("status", o.status); c.note("code", o.code); }
});
process.exit((await save(S)) ? 0 : 1);
