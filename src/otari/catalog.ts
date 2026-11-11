// The model catalog from Otari's /models: context windows, prices, and which models have open weights.
// /models has no open-weight flag, and /catalog/models' open_weights is wrong for several models (Nov 2026: open
// embedding models marked closed, Kimi K3.1 Pro closed, a model with unreleased weights open), so Peeblo keeps its
// own allowlist of open-weight families, reviewed against Artificial Analysis's open-weights list; anything
// unmatched counts as closed. Quality tiers live in config/model-tiers.json.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { otari } from "./client.ts";

export type OtariModel = {
  id: string;
  name?: string;
  type?: string;
  context_window?: number;
  max_output_tokens?: number;
  owned_by?: string;
  supported_parameters?: string[];
  pricing?: { input_price_per_million?: number; output_price_per_million?: number; cache_read_price_per_million?: number };
};

const OPEN_WEIGHT: RegExp[] = [
  /^deepseek\//,
  /^moonshotai\/kimi/,
  /^z-ai\/glm/,
  /^minimax\//,
  /^xiaomi\/mimo/,
  /^alibaba\/qwen/,
  /^meta\/(llama|muse-spark-open)/,
  /^google\/gemma/,
  /^openai\/gpt-oss/,
  /^nvidia\/(llama-)?nemotron/,
  /^microsoft\/phi/,
  /^nousresearch\//,
  /^openbmb\//,
  /^mistralai\/(mistral-small|ministral|devstral|magistral-small|mistral-7b|mixtral|pixtral-12b|mistral-large-[34](-0)?$)/,
  /^reflection\/beam/,
  /^(all-minilm|bge-|e5-|granite-)/,
];
// Hosted-only members of open families (no released weights). Inkling's weights are still pending, and it
// matches no family above.
const CLOSED: RegExp[] = [/^alibaba\/qwen(-max|-plus|-turbo|-flash|3\.\d+-(flash|max|plus))/];
// Open-weight but never offered: too old for agent work (it drops tools and loses track of multi-step jobs).
const NOT_OFFERED: RegExp[] = [/^openai\/gpt-oss/];
export const isOpenWeight = (id: string): boolean =>
  OPEN_WEIGHT.some((r) => r.test(id)) && !CLOSED.some((r) => r.test(id)) && !NOT_OFFERED.some((r) => r.test(id));

export type Tier = {
  tier: "S" | "A" | "B" | "C" | "D" | "E";
  aa_v5: number;
  aa_cost_per_task?: number;
  minutes_per_task?: number;
  est_otari_cost_per_task?: number;
  tokens_per_second?: number;
  note?: string;
};
export type Measured = {
  cost_per_call: number;
  prompt_tokens_per_call: number;
  completion_tokens_per_call: number;
  output_tokens_per_second: number | null;
  calls: number;
  provider?: string;
  at: string;
};
type TierFile = {
  source: string;
  models: Record<string, Tier>;
  roles: Record<string, { default: string; fallback: string[]; purpose: string }>;
  heavy: { model: string; fallback: string[]; purpose: string };
  measured: Record<string, Measured>;
};
export const tierFile: TierFile = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "config", "model-tiers.json"), "utf8"));
// A model's quality tier (S best), or null when it has no score yet.
export const tierOf = (id: string): Tier | null => tierFile.models[id] ?? null;

// One line the agent can weigh: quality tier, cost per task (ours when measured, else AA's estimate on
// Otari's prices) and speed.
export function modelFacts(id: string): string {
  const t = tierOf(id);
  const m = tierFile.measured[id];
  const parts = [t ? `tier ${t.tier} (AA ${t.aa_v5})` : "no AA score yet"];
  if (t?.est_otari_cost_per_task !== undefined) parts.push(`~$${t.est_otari_cost_per_task}/task on Otari (est.)`);
  else if (t?.aa_cost_per_task !== undefined) parts.push(`$${t.aa_cost_per_task}/task at AA's provider`);
  if (m) parts.push(`measured $${m.cost_per_call}/call, ${m.prompt_tokens_per_call}+${m.completion_tokens_per_call} tokens/call`);
  const speed = m?.output_tokens_per_second ?? t?.tokens_per_second;
  if (speed) parts.push(`~${Math.round(speed)} tok/s`);
  if (t?.minutes_per_task !== undefined) parts.push(`${t.minutes_per_task} min/task`);
  return parts.join(", ");
}

let cache: { at: number; models: Map<string, OtariModel> } | null = null;
export async function models(): Promise<Map<string, OtariModel>> {
  if (cache && Date.now() - cache.at < 10 * 60_000) return cache.models;
  const { data } = await otari<{ data: OtariModel[] }>("GET", "/models");
  cache = { at: Date.now(), models: new Map(data.data.map((m) => [m.id, m])) };
  return cache.models;
}

export async function openWeightModels(): Promise<OtariModel[]> {
  return [...(await models()).values()].filter((m) => isOpenWeight(m.id));
}

// What a call would cost from catalog prices, before it runs (Otari's own estimate comes back only on a refusal).
export async function estimateCost(model: string, inputTokens: number, outputTokens: number): Promise<number | null> {
  const m = (await models()).get(model);
  const p = m?.pricing;
  if (!p || p.input_price_per_million === undefined || p.output_price_per_million === undefined) return null;
  return (inputTokens * p.input_price_per_million + outputTokens * p.output_price_per_million) / 1e6;
}

// A rough token count for estimates (about 4 characters per token for English and code).
export const roughTokens = (text: string): number => Math.ceil(text.length / 4);
// The exact count from Otari (/messages/count_tokens) for a price card a person reads; the rough count if it fails.
// Not used on every model call: it would add a round trip to each.
export async function countTokens(model: string, text: string): Promise<number> {
  const r = await otari<{ input_tokens?: number }>(
    "POST",
    "/messages/count_tokens",
    { model, messages: [{ role: "user", content: text.slice(0, 400_000) }] },
    { retries: 0, timeoutMs: 5000 },
  ).catch(() => null);
  return r?.data?.input_tokens ?? roughTokens(text);
}
