// The large computer on Debian (COMPUTER_SPEC §1), when the host has Docker or Podman: a new large teammate boots on
// Debian 13, its browser reads a real page and submits a real form in real turns, bun and Playwright MCP start, and
// the optional ocrmypdf recipe (Ghostscript is AGPL, so it isn't in the base image) builds in its trial VM.
import { check, expect, save } from "./harness.ts";
import { answer, ensureTeammate } from "./api.ts";
import { turn, used } from "./n-common.ts";
const { pool } = await import("../../src/db.ts");
const { exec } = await import("../../src/environment/controller.ts");
const { currentBuild, distroOf } = await import("../../src/environment/image.ts");
const { queueBuild, waitForBuild } = await import("../../src/environment/recipes.ts");
const { normalizeRecipe } = await import("../../src/environment/recipe-schema.ts");
const { getTeammate } = await import("../../src/store/teammates.ts");

const S = "P2D";
const slug = "vm-debian";
await ensureTeammate(slug, { name: "Wick", role: "Researches websites for the acme team", tools: ["computer"], connectors: [], budget: { monthly_usd: 3 }, model: { default: "deepseek/deepseek-v4.1-flash-1017", fallback: "xiaomi/mimo-v2.6-pro" }, mode: "auto", computer: { size: "large", allowed_hosts: [] } });
const id = (await getTeammate(slug))!.id;

await check(S, "a large teammate boots on Debian 13", async (c) => {
  expect(distroOf("large") === "debian", `the current large build is ${distroOf("large")}`);
  const r = await exec(id, ["sh", "-c", ". /etc/os-release; echo \"$PRETTY_NAME\"; cat /etc/peeblo-image; chromium --version; node --version"]);
  c.note("guest", r.stdout.trim().split("\n"));
  c.note("build", currentBuild("large"));
  expect(r.exitCode === 0 && /Debian GNU\/Linux 13/.test(r.stdout) && /peeblo-large-debian/.test(r.stdout), r.stdout + r.stderr);
});

await check(S, "browser_read reads a real page on Debian", async (c) => {
  const r = await turn(slug, "deb-read", "Open https://github.com/earendil-works/gondolin in your browser and tell me in one sentence what the project is, and the label of its license link.");
  const reads = used(r.tools, "browser_read").filter((x) => x.status === "completed");
  c.note("tools", r.tools.map((x: any) => `${x.tool}:${x.status}`));
  expect(reads.length, "no browser_read completed");
  expect(/apache/i.test(answer(r.events)), `answer: ${answer(r.events).slice(0, 200)}`);
  c.note("answer", answer(r.events).slice(0, 160));
});

await check(S, "browser_act fills and submits a real form on Debian", async (c) => {
  const r = await turn(slug, "deb-act", "In your browser, open https://httpbin.org/forms/post, put 'Peeblo Debian' in the customer name field, submit the order, and tell me what customer name the result page shows.", { answer: "approved" });
  const acts = used(r.tools, "browser_act").filter((x) => x.status === "completed");
  c.note("tools", r.tools.map((x: any) => `${x.tool}:${x.status}`));
  expect(acts.length, "no browser_act completed");
  expect(/peeblo debian/i.test(answer(r.events)), `answer: ${answer(r.events).slice(0, 200)}`);
});

await check(S, "bun and Playwright MCP start inside the large computer", async (c) => {
  const init = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "peeblo-check", version: "1" } } });
  const r = await exec(id, ["sh", "-c", `bun --version; bun -e 'console.log("bun ok", 6 * 7)'; (printf '%s\\n' '${init}'; sleep 8) | timeout 30 playwright-mcp --config /etc/playwright-mcp/config.json 2>&1 | head -c 600`], { timeoutMs: 60_000 });
  c.note("out", r.stdout.slice(0, 600));
  expect(/^\d+\.\d+\.\d+/m.test(r.stdout) && /bun ok 42/.test(r.stdout), `bun: ${r.stdout.slice(0, 200)}`);
  expect(/"serverInfo"/.test(r.stdout) && /Playwright/i.test(r.stdout), `Playwright MCP didn't answer initialize: ${r.stdout.slice(0, 300)}`);
});

await check(S, "the ocrmypdf recipe builds in its trial VM", async (c) => {
  // The patch the writing-recipes skill gives a teammate to propose.
  const { recipe, problems } = normalizeRecipe({ packages: { apt: ["ocrmypdf=16.7.0+dfsg1-3"], apk: ["ocrmypdf"] }, verify: ["ocrmypdf --version", "gs --version"] });
  expect(!problems.length, problems.join("; "));
  const q = await queueBuild(id, "large", "trial", recipe);
  const b = await waitForBuild(q.id, 900_000);
  c.note("build", { id: q.id, status: b?.status, error: b?.error, bytes: b?.bytes, verify: b?.verify });
  expect(b?.status === "built", `build ${b?.status}: ${b?.error}`);
  expect(JSON.stringify(b.verify).includes("16.7"), `verify: ${JSON.stringify(b.verify)}`);
});
await pool.end();
process.exit((await save(S)) ? 0 : 1);
