// A Promptfoo provider for the open guard model, called the way Peeblo calls it (Otari chat, temperature 0).
// A prompt of the form "fixture:<name>" is replaced by a prepared test text (attack fixtures are kept out of
// the eval files and loaded here). Output: { safe, categories, raw }.
import { readFileSync } from "node:fs";
import { verdict } from "../../src/guard.ts"; // Peeblo's own reading of the verdict, so the eval tests its policy
import { config } from "../../src/config.ts"; // loading config moves the keys out of process.env

const fixtures = {
  // The poisoned release-notes page: its text is the base64 path of the URL in local/test/inject-url.txt.
  "web-release-notes": () => Buffer.from(readFileSync("local/test/inject-url.txt", "utf8").trim().split("/base64/")[1], "base64url").toString("utf8"),
};

export default class OpenGuard {
  constructor(options) { this.model = options?.config?.model ?? "alibaba/qwen3guard-gen-8b"; }
  id() { return `open-guard:${this.model}`; }
  async callApi(prompt) {
    const text = prompt.startsWith("fixture:") ? fixtures[prompt.slice(8)]() : prompt;
    const r = await fetch("https://api.otari.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${config.otariKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, max_tokens: 40, temperature: 0, messages: [{ role: "user", content: text }] }),
    });
    const j = await r.json();
    if (!r.ok) return { error: `${r.status} ${JSON.stringify(j).slice(0, 200)}` };
    const raw = String(j.choices?.[0]?.message?.content ?? "");
    const v = verdict(raw);
    return { output: JSON.stringify({ safe: v.safe, categories: v.categories, raw }), cost: Number(j.usage?.cost_usd ?? 0), metadata: { request_id: r.headers.get("otari-request-id") } };
  }
}
