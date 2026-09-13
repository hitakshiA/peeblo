import { Agent, createTool, ProviderSettingsManager, resolveProviderApiKeyFromSettings } from "@cline/sdk";
import { z } from "zod";

const settings = new ProviderSettingsManager();
const apiKey = await resolveProviderApiKeyFromSettings(settings, "cline");
console.log("key resolved:", Boolean(apiKey));

const add = createTool({
  name: "add_money",
  description: "Add two USD amounts exactly. Use for any arithmetic on money.",
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  async execute({ a, b }) { return { total: Math.round((a + b) * 100) / 100 }; },
});

const agent = new Agent({ providerId: "cline-pass", modelId: process.env.PEEBLO_MODEL ?? "cline-pass/glm-5.3-flash", apiKey, systemPrompt: "You are a terse finance assistant. Use tools for arithmetic.", tools: [add] });
const r = await agent.run("What is 18000 + 15000 + 8550? Use the tool, then answer with just the number.");
console.log(r.status, "|", r.outputText.trim(), "| iterations", r.iterations, "| tokens", r.usage.inputTokens, r.usage.outputTokens, r.error?.message ?? "");
