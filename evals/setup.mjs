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
// Computer cases: a large computer with one repo, in Ask mode (page changes and publishing are asked for, and the
// eval declines), and no owner (recipe proposals are refused at once). Nothing is changed for real.
const computer = { role: "Engineer and web researcher for the acme team", budget: { monthly_usd: 5 }, tools: ["computer", "web"], web: { allowed_domains: ["github.com", "httpbin.org", "example.com"] }, connectors: [], mode: "ask",
  computer: { size: "large", allowed_hosts: [], repos: [{ name: "checkout-api", remote: "https://github.com/hitakshiA/acme-checkout-api.git", base: "main", credential: "GH_TOKEN" }] } };
const pcs = {
  "eval-pc-worker": { name: "Kit", model: { default: "deepseek/deepseek-v4.1-flash-1017", fallback: "xiaomi/mimo-v2.6-pro" } },
  "eval-pc-mimo": { name: "Kit", model: { default: "xiaomi/mimo-v2.6-pro", fallback: "deepseek/deepseek-v4.1-flash-1017" } },
  "eval-pc-glmflash": { name: "Kit", model: { default: "z-ai/glm-5.3-flash", fallback: "deepseek/deepseek-v4.1-flash-1017" } },
};
for (const [slug, t] of Object.entries(pcs)) {
  let r = await fetch(`${API}/v1/teammates`, { method: "POST", headers: H, body: JSON.stringify({ slug, ...computer, ...t }) });
  if (r.status === 409) r = await fetch(`${API}/v1/teammates/${slug}`, { method: "PATCH", headers: H, body: JSON.stringify({ ...computer, ...t, note: "eval setup" }) });
  if (!r.ok) throw new Error(`${slug}: ${r.status} ${await r.text()}`);
  if (process.env.EVAL_GH_TOKEN) await fetch(`${API}/v1/teammates/${slug}/secrets/GH_TOKEN`, { method: "PUT", headers: H, body: JSON.stringify({ value: process.env.EVAL_GH_TOKEN, hosts: ["github.com", "api.github.com"] }) });
  console.log("ready:", slug);
}
for (const [slug, t] of Object.entries(teammates)) {
  let r = await fetch(`${API}/v1/teammates`, { method: "POST", headers: H, body: JSON.stringify({ slug, ...base, ...t }) });
  if (r.status === 409) r = await fetch(`${API}/v1/teammates/${slug}`, { method: "PATCH", headers: H, body: JSON.stringify({ ...base, ...t, note: "eval setup" }) });
  if (!r.ok) throw new Error(`${slug}: ${r.status} ${await r.text()}`);
  console.log("ready:", slug);
}
