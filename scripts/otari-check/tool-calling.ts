// Open-weight tool calling through Otari, per default model (K2VV-style): does the model call a tool at the
// right moments (trigger accuracy), do its arguments validate (schema accuracy), can it keep going for 10
// calls, which providers serve it, and which request controls Otari passes through (strict, tool_choice,
// parallel_tool_calls, gpt-oss reasoning, a pinned provider). Results: local/otari-check/tool-calling.json.
import { mkdir, writeFile } from "node:fs/promises";
import { otari, OtariError } from "../../src/otari/client.ts";
import { pinnedName, ROLES } from "../../src/otari/routing.ts";
import { tierFile } from "../../src/otari/catalog.ts";
import { overBuildCap } from "../../src/otari/price-cap.ts";

type Schema = { type: string | string[]; properties?: Record<string, Schema>; required?: string[]; enum?: unknown[]; minimum?: number; maximum?: number; additionalProperties?: boolean; items?: Schema };
const fn = (name: string, description: string, properties: Record<string, Schema>, strict: boolean) =>
  ({ type: "function", function: { name, description, strict, parameters: { type: "object", properties, required: Object.keys(properties), additionalProperties: false } } });
const TEAM: Schema = { type: "string", enum: ["GRO", "ENG", "DES"] };
const toolset = (strict: boolean) => [
  fn("linear_read_issues", "List recent Linear issues for a team.", { team: TEAM, limit: { type: "integer", minimum: 1, maximum: 20 }, state: { type: ["string", "null"], enum: ["backlog", "in_progress", "done", null] } }, strict),
  fn("linear_read_issue", "Read one Linear issue by its identifier, like GRO-6.", { id: { type: "string" } }, strict),
  fn("linear_create_issue", "Create a Linear issue.", { team: TEAM, title: { type: "string" }, description: { type: ["string", "null"] } }, strict),
  fn("price_estimate", "Estimate what a model call would cost.", { model: { type: "string" }, input_tokens: { type: "integer", minimum: 0 }, output_tokens: { type: "integer", minimum: 0 } }, strict),
  fn("budget_status", "How much of this teammate's monthly budget is left.", {}, strict),
  fn("web_fetch", "Read a web page.", { url: { type: "string" } }, strict),
];

function validate(s: Schema, v: unknown, path = "$"): string | null {
  const types = Array.isArray(s.type) ? s.type : [s.type];
  const t = v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v;
  if (!types.includes(t) && !(t === "integer" && types.includes("number"))) return `${path}: ${t} not ${types.join("|")}`;
  if (s.enum && !s.enum.includes(v)) return `${path}: ${JSON.stringify(v)} not in enum`;
  if (typeof v === "number" && ((s.minimum !== undefined && v < s.minimum) || (s.maximum !== undefined && v > s.maximum))) return `${path}: ${v} out of range`;
  if (t === "object" && s.properties) {
    const o = v as Record<string, unknown>;
    for (const r of s.required ?? []) if (!(r in o)) return `${path}.${r}: missing`;
    if (s.additionalProperties === false) for (const k of Object.keys(o)) if (!(k in s.properties)) return `${path}.${k}: not allowed`;
    for (const [k, sub] of Object.entries(s.properties)) if (k in o) { const e = validate(sub, o[k], `${path}.${k}`); if (e) return e; }
  }
  return null;
}
const schemaOf = (name: string) => (toolset(false).find((t) => t.function.name === name)!.function.parameters as Schema);

// [prompt, expected tool or null for "no tool"]
const CASES: [string, string | null][] = [
  ["What are the latest issues in the growth team?", "linear_read_issues"],
  ["Show me what the engineering team has in progress right now, just the top 5.", "linear_read_issues"],
  ["Can you pull up GRO-6 for me?", "linear_read_issue"],
  ["What's the status of ENG-12?", "linear_read_issue"],
  ["File a bug for the design team: the pricing page footer overlaps the buy button on iPhone.", "linear_create_issue"],
  ["Please open an issue in GRO called 'Check Mobile Safari signup drop'.", "linear_create_issue"],
  ["How much would it cost to run deepseek/deepseek-v4.1-flash-1017 on 20,000 tokens in and 1,000 out?", "price_estimate"],
  ["Roughly what does a 5k-token prompt with a 500-token answer cost on moonshotai/kimi-k2.6?", "price_estimate"],
  ["How much budget do you have left this month?", "budget_status"],
  ["Are you close to your spending limit?", "budget_status"],
  ["Read https://github.com/earendil-works/gondolin/releases and tell me the newest version.", "web_fetch"],
  ["What does the page at https://docs.otari.ai say about routing?", "web_fetch"],
  ["List the done issues in design, maybe ten of them.", "linear_read_issues"],
  ["Can you look at DES-3 and tell me who owns it?", "linear_read_issue"],
  ["Log an issue for engineering: webhooks to Moss & Pine arrive 20 to 40 minutes late.", "linear_create_issue"],
  ["Thanks, that's all for today!", null],
  ["What's the difference between a ledger and a journal in accounting? One sentence.", null],
  ["Good morning!", null],
  ["Can you explain what week-over-week growth means?", null],
  ["Never mind, I figured it out myself.", null],
];

type Msg = Record<string, unknown>;
// Every call's cost, tokens and speed through Otari, per model: our own numbers, not AA's.
type Stats = { calls: number; cost: number; prompt: number; completion: number; ms: number };
const stats: Record<string, Stats> = {};
const call = async (model: string, messages: Msg[], extra: Record<string, unknown> = {}) => {
  const t0 = Date.now();
  const r = await otari<any>("POST", "/chat/completions", { model, max_tokens: 2000, messages, ...extra }, { timeoutMs: 90_000 });
  const st = (stats[model] ??= { calls: 0, cost: 0, prompt: 0, completion: 0, ms: 0 });
  st.calls++; st.cost += Number(r.data.usage?.cost_usd ?? 0); st.prompt += r.data.usage?.prompt_tokens ?? 0; st.completion += r.data.usage?.completion_tokens ?? 0; st.ms += Date.now() - t0;
  return r;
};
const summary = (m: string) => { const s = stats[m]; return s ? { calls: s.calls, cost_per_call: +(s.cost / s.calls).toFixed(6), prompt_tokens_per_call: Math.round(s.prompt / s.calls), completion_tokens_per_call: Math.round(s.completion / s.calls), seconds_per_call: +(s.ms / s.calls / 1000).toFixed(2), output_tokens_per_second: s.ms ? +(s.completion / (s.ms / 1000)).toFixed(1) : null, total_cost: +s.cost.toFixed(6) } : null; };
const SYSTEM = { role: "system", content: "You are a teammate with tools. Use a tool when the request needs one; otherwise just answer." };

async function triggerAndSchema(model: string, strict: boolean) {
  let correct = 0, triggered = 0, valid = 0, errors = 0, lengthStops = 0;
  const providers: Record<string, number> = {};
  const misses: string[] = [];
  const ids: string[] = [];
  for (const [prompt, want] of CASES) {
    try {
      const r = await call(model, [SYSTEM, { role: "user", content: prompt }], { tools: toolset(strict) });
      ids.push(r.requestId!);
      const p = r.headers.get("otari-provider") ?? "?"; providers[p] = (providers[p] ?? 0) + 1;
      const tc = r.data.choices?.[0]?.message?.tool_calls ?? [];
      if (r.data.choices?.[0]?.finish_reason === "length") lengthStops++;
      const got = tc[0]?.function?.name ?? null;
      if (got === want) correct++; else misses.push(`${prompt.slice(0, 40)}… → ${got ?? "no tool"} (want ${want ?? "no tool"})`);
      for (const c of tc) {
        triggered++;
        let args: unknown; try { args = JSON.parse(c.function.arguments || "{}"); } catch { continue; }
        if (toolset(false).some((t) => t.function.name === c.function.name) && !validate(schemaOf(c.function.name), args)) valid++;
      }
    } catch (e) { errors++; misses.push(`${prompt.slice(0, 40)}… → error ${(e as OtariError).status} ${(e as Error).message.slice(0, 80)}`); }
  }
  return { trigger_accuracy: correct / CASES.length, schema_accuracy: triggered ? valid / triggered : null, calls: triggered, errors, length_stops: lengthStops, providers, misses: misses.slice(0, 6), ids: ids.slice(0, 3) };
}

// Ten issues to read one by one; the harness answers each call. Counts valid calls until the model stops.
async function session10(model: string) {
  const want = Array.from({ length: 10 }, (_, i) => `GRO-${i + 1}`);
  const messages: Msg[] = [SYSTEM, { role: "user", content: `Read each of these Linear issues one at a time with the tool, then give me a one-line summary of all of them: ${want.join(", ")}.` }];
  let calls = 0, valid = 0;
  const seen = new Set<string>();
  for (let step = 0; step < 14; step++) {
    const r = await call(model, messages, { tools: toolset(true), parallel_tool_calls: false });
    const m = r.data.choices?.[0]?.message;
    const tc = m?.tool_calls ?? [];
    if (!tc.length) break;
    messages.push({ role: "assistant", content: m.content ?? "", tool_calls: tc, ...(m.reasoning ? { reasoning: m.reasoning } : {}), ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}) });
    for (const c of tc) {
      calls++;
      let args: any = {}; try { args = JSON.parse(c.function.arguments || "{}"); } catch { /* invalid */ }
      if (c.function.name === "linear_read_issue" && !validate(schemaOf("linear_read_issue"), args)) { valid++; seen.add(String(args.id)); }
      messages.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify({ id: args.id, title: `Issue ${args.id}`, state: "backlog" }) });
    }
  }
  return { calls, valid, distinct_issues: seen.size, all_ten: want.every((w) => seen.has(w)) };
}

async function controls(model: string) {
  const out: Record<string, unknown> = {};
  const hi = [SYSTEM, { role: "user", content: "Good morning!" }];
  const two = [SYSTEM, { role: "user", content: "Pull up GRO-6 and GRO-7 for me." }];
  const n = (r: any) => (r.data.choices?.[0]?.message?.tool_calls ?? []).length;
  const safe = async (k: string, f: () => Promise<unknown>) => { try { out[k] = await f(); } catch (e) { out[k] = `error ${(e as OtariError).status}: ${(e as Error).message.slice(0, 120)}`; } };
  await safe("tool_choice_required_on_greeting", async () => n(await call(model, hi, { tools: toolset(true), tool_choice: "required" })) > 0);
  await safe("tool_choice_named", async () => (await call(model, hi, { tools: toolset(true), tool_choice: { type: "function", function: { name: "budget_status" } } })).data.choices?.[0]?.message?.tool_calls?.[0]?.function?.name === "budget_status");
  await safe("tool_choice_none", async () => n(await call(model, [SYSTEM, { role: "user", content: "Can you pull up GRO-6?" }], { tools: toolset(true), tool_choice: "none" })) === 0);
  await safe("calls_with_parallel_true", async () => n(await call(model, two, { tools: toolset(true), parallel_tool_calls: true })));
  await safe("calls_with_parallel_false", async () => n(await call(model, two, { tools: toolset(true), parallel_tool_calls: false })));
  await safe("strict_accepted", async () => (await call(model, two, { tools: toolset(true) })).data.choices?.length > 0);
  await safe("reasoning_returned", async () => {
    const m = (await call(model, two, { tools: toolset(true), parallel_tool_calls: false })).data.choices?.[0]?.message ?? {};
    return { reasoning: typeof m.reasoning === "string" ? m.reasoning.length : null, reasoning_content: typeof m.reasoning_content === "string" ? m.reasoning_content.length : null };
  });
  return out;
}

// gpt-oss: does Otari return the reasoning, and does it accept it sent back with the next request?
async function reasoningRoundTrip(model: string) {
  const first = await call(model, [SYSTEM, { role: "user", content: "Can you pull up GRO-6?" }], { tools: toolset(true), parallel_tool_calls: false });
  const m = first.data.choices?.[0]?.message ?? {};
  const tc = m.tool_calls ?? [];
  if (!tc.length) return { first_call_used_tool: false };
  const field = m.reasoning !== undefined ? "reasoning" : m.reasoning_content !== undefined ? "reasoning_content" : null;
  const second = await call(model, [SYSTEM, { role: "user", content: "Can you pull up GRO-6?" }, { role: "assistant", content: m.content ?? "", tool_calls: tc, ...(field ? { [field]: m[field] } : {}) }, { role: "tool", tool_call_id: tc[0].id, content: JSON.stringify({ id: "GRO-6", title: "Signup drop on mobile Safari", state: "in_progress" }) }], { tools: toolset(true) });
  return { field_returned: field, reasoning_chars: field ? String(m[field]).length : 0, sent_back_status: 200, second_answer: String(second.data.choices?.[0]?.message?.content ?? "").slice(0, 80), ids: [first.requestId, second.requestId] };
}

async function pinning(model: string) {
  const pinned = await pinnedName(model);
  const r = await call(pinned, [{ role: "user", content: "Say ok." }]);
  return { pinned, served_provider: r.headers.get("otari-provider"), served_model: r.headers.get("otari-model"), id: r.requestId };
}

const results: Record<string, unknown> = {};
// Every S, A and B model (config/model-tiers.json), which includes every role's default.
const only = process.argv.slice(2);
const roleOf = (m: string) => Object.entries(ROLES).filter(([, r]) => r.default === m).map(([n]) => n);
const picked = Object.entries(tierFile.models).filter(([, t]) => ["S", "A", "B"].includes(t.tier)).map(([m]) => m).filter((m) => !only.length || only.includes(m));
const deferred: Record<string, string> = {};
for (const model of picked) {
  const role = model;
  // Big models are configured but tested at the end (PEEBLO_BUILD_PRICE_CAP).
  const capped = await overBuildCap(model);
  if (capped) { deferred[model] = capped; console.log(`\n# deferred to the end: ${capped}`); continue; }
  console.log(`\n# ${tierFile.models[model].tier} ${model}${roleOf(model).length ? ` (default for ${roleOf(model).join(", ")})` : ""}`);
  const strict = await triggerAndSchema(model, true);
  const loose = await triggerAndSchema(model, false);
  const s10 = await session10(model).catch((e) => ({ error: (e as Error).message.slice(0, 120) }));
  const ctl = await controls(model);
  const pin = await pinning(model).catch((e) => ({ error: (e as Error).message.slice(0, 120) }));
  const rr = /gpt-oss|kimi|glm|minimax|mimo/.test(model) ? await reasoningRoundTrip(model).catch((e) => ({ error: (e as Error).message.slice(0, 160) })) : undefined;
  results[role] = { model, tier: tierFile.models[model].tier, default_for: roleOf(model), cost: summary(model) ?? summary(await pinnedName(model).catch(() => model)), strict, loose, session10: s10, controls: ctl, pinning: pin, ...(rr ? { reasoning_round_trip: rr } : {}) };
  console.log(JSON.stringify(results[role], null, 1).slice(0, 1800));
}
await mkdir("local/otari-check", { recursive: true });
await writeFile("local/otari-check/tool-calling.json", JSON.stringify({ at: new Date().toISOString(), cases: CASES.length, results, deferred }, null, 2));
process.exit(0);
