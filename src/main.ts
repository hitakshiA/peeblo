// The daemon: migrations, durable execution, schedules and the core API.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";
import { migrate, pool } from "./db.ts";
import { launchDurable, shutdownDurable } from "./durable/dbos.ts";
import "./durable/runs.ts";
import { syncSchedules } from "./durable/schedules.ts";
import { startApi } from "./api/server.ts";
import { startIngress } from "./ingress/slack.ts";
import { sleepAll } from "./environment/controller.ts";
import { startProxy } from "./proxy/relay.ts";
import { installPiExecutor } from "./pi/supervisor.ts";
import { stopAllPi } from "./pi/sessions.ts";

await mkdir(join(config.dataDir, "workspace"), { recursive: true });
const applied = await migrate();
// Setup mode: no Otari key yet. Only the console runs; its setup saves the key and restarts core into full mode.
if (!config.otariKey) {
  await startApi();
  console.log(`peeblo: setup mode. Finish setting up in the console: http://127.0.0.1:${config.apiPort}/console/`);
  await new Promise(() => {});
}
installPiExecutor();
// Slack: messages → sessions, runs → streamed replies with receipts, clicks → approvals and feedback.
{
  const { installSlackInbound, setStopHandler } = await import("./slack/inbound.ts");
  const { installSlackView } = await import("./slack/view.ts");
  const { installSlackInteractions } = await import("./slack/interactions.ts");
  const { stopSession } = await import("./pi/sessions.ts");
  installSlackInbound(); installSlackView(); installSlackInteractions();
  (await import("./memory/work.ts")).installWorkMemory();
  // Stop in a thread stops every teammate working there (the whole chain).
  const { threadSessions } = await import("./chains.ts");
  setStopHandler(async (sid) => { let any = false; for (const s of await threadSessions(sid)) any = (await stopSession(s)) || any; return any; });
  const { ensureManager, installHireWelcome } = await import("./manager.ts");
  await ensureManager().catch((e) => console.error("peeblo manager:", (e as Error).message)); installHireWelcome();
  (await import("./slack/profile.ts")).installProfileSync();
  (await import("./connectors/mcp.ts")).warmCatalog();
  // Warm what the first model call would otherwise wait for: catalog prices.
  void import("./otari/catalog.ts").then((c) => import("./otari/routing.ts").then((r) => c.estimateCost(r.ROLES["peeblo-worker"].default, 1000, 100))).catch(() => null);
  void import("./proxy/results.ts").then((t) => t.warmGithubVisible()).catch(() => null);
}
// Receipts need to know whether Otari's org guardrail is on (Otari doesn't report it on streams).
const readGuard = () => import("./guard.ts").then(async (g) => {
  if (g.guardMode() !== "lakera") return null;
  // Keep Otari's Lakera definition on the configured Lakera project (its policy decides what is flagged).
  if (config.lakeraProject) { const p = await g.lakeraProject(); if (p && p.projectId !== config.lakeraProject) await g.setLakeraProject(config.lakeraProject); }
  return g.lakeraMandate();
}).catch(() => null);
await readGuard();
// Peeblo's role routing policies in Otari, made or updated from config/model-tiers.json when an admin session exists.
void import("./otari/routing.ts").then((r) => r.syncRolePolicies()).catch(() => null);
setInterval(readGuard, 10 * 60_000).unref();
const proxy = await startProxy();
await launchDurable();
// Recipes whose build is missing for the current base image (e.g. after `peeblo image`) are queued in the background.
void import("./environment/recipes.ts").then((r) => r.queueMissingBuilds()).catch(() => {});
{ const { installTriggers } = await import("./triggers.ts"); installTriggers(); }
// Connector access per teammate in Otari: follows teammate changes, and is checked once at start.
{ const m = await import("./otari/mcp-access.ts"); m.followTeammateChanges(); void m.syncAllAccess().catch(() => null); }
// Worktrees of closed or long-idle sessions are cleaned up while their teammate is awake and idle.
setInterval(() => void import("./environment/controller.ts").then(async (c) => { const { sweep } = await import("./environment/repos.ts"); for (const a of c.awake()) if (a.inflight === 0) await sweep(a.teammateId).catch(() => 0); }), 30 * 60_000).unref();
const schedules = await syncSchedules();
const api = await startApi();
const ingress = await startIngress();
console.log(`peeblo: up (migrations applied: ${applied.length ? applied.join(", ") : "none new"}; ${schedules} schedules; api on ${config.apiHost}:${config.apiPort}; ingress on ${config.ingressHost}:${config.ingressPort})`);

const shutdown = async () => {
  api.close();
  ingress.close();
  await sleepAll();
  await stopAllPi();
  proxy.close();
  await shutdownDurable();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
