// The build-time spend guard (PEEBLO_BUILD_PRICE_CAP=in,out per 1M tokens): big models stay configured where
// the design puts them, but are not called while building and testing. Role policies count as their default.
import { config } from "../config.ts";
import { models, tierFile } from "./catalog.ts";

// Big models the lead named, held back whatever their price.
const NAMED = /kimi-k3|glm-5\.3(?!-flash)|glm-5p3(?!-flash)|muse-spark-open|mistral-large-4|deepseek-v4-pro|qwen3\.8-2\.4t|nemotron-3-ultra|hermes-4-405b/i;

export async function overBuildCap(model: unknown): Promise<string | null> {
  if (config.buildPriceCap.length !== 2 || typeof model !== "string") return null;
  const id = tierFile.roles[model]?.default ?? model;
  if (NAMED.test(id)) return `${model} is one of the big models tested at the end, not during the build`;
  const all = await models();
  // A pinned name (provider:native-name) is matched to its catalog entry by the model part.
  const native = id.includes(":") ? id.split(":").slice(1).join(":").toLowerCase() : null;
  const m = all.get(id) ?? (native ? [...all.values()].find((x) => native.endsWith((x.id.split("/")[1] ?? "\u0000").toLowerCase())) : undefined);
  const p = m?.pricing;
  if (!p) return null;
  const [maxIn, maxOut] = config.buildPriceCap;
  if ((p.input_price_per_million ?? 0) > maxIn || (p.output_price_per_million ?? 0) > maxOut) {
    return `${model} costs $${p.input_price_per_million}/$${p.output_price_per_million} per 1M tokens, over the build cap of $${maxIn}/$${maxOut}; big models are tested at the end`;
  }
  return null;
}
