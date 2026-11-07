// Seam D: routing policies per role, Otari's own fallback, and /routing/recommend.
// Policies need a dashboard session (run j-admin.ts first).
import { check, expect, save } from "./harness.ts";
import { pool } from "../../src/db.ts";
import { otari } from "../../src/otari/client.ts";
import { deleteRoutingPolicy, upsertRoutingPolicy } from "../../src/otari/admin.ts";
import { ensureRolePolicies, pinnedName, recommend, rolePoliciesInOtari, ROLES, waitUntilServing } from "../../src/otari/routing.ts";

const S = "D";
await check(S, "catalog id → pinned provider name", async (c) => {
  const p = await pinnedName("deepseek/deepseek-v4.1-flash-1017");
  expect(/^[^:]+:.+/.test(p), p);
  c.note("deepseek", p);
  c.note("glm_flash", await pinnedName("z-ai/glm-5.3-flash"));
});

await check(S, "a policy per role, each answering through Otari", async (c) => {
  const set = await ensureRolePolicies();
  const names = await rolePoliciesInOtari();
  expect(Object.keys(ROLES).every((n) => names.includes(n)), `missing: ${Object.keys(ROLES).filter((n) => !names.includes(n))}`);
  for (const name of Object.keys(ROLES)) {
    const r = await otari("POST", "/chat/completions", { model: name, max_tokens: 5, messages: [{ role: "user", content: "Say ok." }] });
    c.ids.push(r.requestId!);
    const served = `${r.headers.get("otari-provider")}:${r.headers.get("otari-model")}`;
    expect(served === set[name].select[0].default || set[name].on_failure.includes(served), `${name} served ${served}`);
    c.note(name, served);
  }
});

await check(S, "Otari falls back inside a policy when the first model can't take the prompt", async (c) => {
  // gpt-oss-20b has a 131k window; a ~140k-token prompt overflows it, and the policy's fallback answers.
  await upsertRoutingPolicy("peeblo-check-overflow", { select: [{ default: await pinnedName("openai/gpt-oss-20b") }], on_failure: [await pinnedName("deepseek/deepseek-v4.1-flash-1017")] });
  try {
    const w = await waitUntilServing("peeblo-check-overflow");
    c.note("new_policy_served_after_ms", w.waitedMs);
    if (w.refusedIds.length) c.note("refused_while_new", w.refusedIds);
    const filler = "The quarterly numbers for the acme checkout service were stable, with no incidents. ".repeat(9500);
    const r = await otari("POST", "/chat/completions", { model: "peeblo-check-overflow", max_tokens: 10, messages: [{ role: "user", content: `${filler}\nSay ok.` }] }, { timeoutMs: 120_000 });
    c.ids.push(r.requestId!);
    expect(r.headers.get("otari-fallback") === "true" && Number(r.headers.get("otari-attempt-count")) >= 2, `no fallback: attempts ${r.headers.get("otari-attempt-count")}, fallback ${r.headers.get("otari-fallback")}`);
    c.note("served", r.headers.get("otari-model"));
    c.note("attempts", r.headers.get("otari-attempt-count"));
  } finally {
    await deleteRoutingPolicy("peeblo-check-overflow");
  }
});

await check(S, "recommend picks a model for delegated work", async (c) => {
  const r = await recommend({
    sessionId: "se_check", toolUseId: "tc_check", agentType: "research", description: "Find the latest Gondolin release",
    prompt: "Look up the latest release of earendil-works/gondolin and summarize what changed.", parentModel: "deepseek/deepseek-v4.1-flash-1017",
    candidates: { "deepseek/deepseek-v4.1-flash-1017": "cheap, fast general work", "moonshotai/kimi-k3.1-pro": "hardest reasoning and long tasks", "minimax/minimax-m3.1-flash": "short structured judgments" },
  });
  expect(!r.fallback && r.requestId && r.model in { "deepseek/deepseek-v4.1-flash-1017": 1, "moonshotai/kimi-k3.1-pro": 1, "minimax/minimax-m3.1-flash": 1 }, JSON.stringify(r));
  c.ids.push(r.requestId);
  c.note("model", r.model);
  c.note("probabilities", r.probabilities);
});
await pool.end();
process.exit((await save(S)) ? 0 : 1);
