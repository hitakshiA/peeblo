// Creates (or resets) the eval teammates through Peeblo's API. Needs core running and PEEBLO_ADMIN_TOKEN.
const API = process.env.PEEBLO_API_URL ?? "http://127.0.0.1:7340";
const H = { authorization: `Bearer ${process.env.PEEBLO_ADMIN_TOKEN}`, "content-type": "application/json" };
const base = {
  role: "Growth analyst for the acme team", budget: { monthly_usd: 5 }, tools: ["web", "code"],
  web: { allowed_domains: ["github.com", "httpbin.org"] }, connectors: ["linear"], mode: "auto",
};
const teammates = {
  "eval-worker": { name: "Wren", model: { default: "deepseek/deepseek-v4.1-flash-1017", fallback: "xiaomi/mimo-v2.6-pro" } },
  "eval-mimo": { name: "Wren", model: { default: "xiaomi/mimo-v2.6-pro", fallback: "deepseek/deepseek-v4.1-flash-1017" } },
  "eval-glmflash": { name: "Wren", model: { default: "z-ai/glm-5.3-flash", fallback: "deepseek/deepseek-v4.1-flash-1017" } },
  "eval-minimax": { name: "Moss", model: { default: "minimax/minimax-m3.1-flash", fallback: "xiaomi/mimo-v2.6-flash" } },
};
for (const [slug, t] of Object.entries(teammates)) {
  let r = await fetch(`${API}/v1/teammates`, { method: "POST", headers: H, body: JSON.stringify({ slug, ...base, ...t }) });
  if (r.status === 409) r = await fetch(`${API}/v1/teammates/${slug}`, { method: "PATCH", headers: H, body: JSON.stringify({ ...base, ...t, note: "eval setup" }) });
  if (!r.ok) throw new Error(`${slug}: ${r.status} ${await r.text()}`);
  console.log("ready:", slug);
}
