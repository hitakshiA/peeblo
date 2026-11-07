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
import { installPiExecutor, stopAllPi } from "./pi/supervisor.ts";

await mkdir(join(config.dataDir, "workspace"), { recursive: true });
const applied = await migrate();
installPiExecutor();
// Slack: messages → sessions, runs → streamed replies with receipts, clicks → approvals and feedback.
{
  const { installSlackInbound, setStopHandler } = await import("./slack/inbound.ts");
  const { installSlackView } = await import("./slack/view.ts");
  const { installSlackInteractions } = await import("./slack/interactions.ts");
  const { stopSession } = await import("./pi/supervisor.ts");
  installSlackInbound(); installSlackView(); installSlackInteractions();
  // Stop in a thread stops every teammate working there (the whole chain).
  const { threadSessions } = await import("./chains.ts");
  setStopHandler(async (sid) => { let any = false; for (const s of await threadSessions(sid)) any = (await stopSession(s)) || any; return any; });
  const { ensureManager, installHireWelcome } = await import("./manager.ts");
  await ensureManager().catch((e) => console.error("peeblo manager:", (e as Error).message)); installHireWelcome();
}
// Receipts need to know whether Otari's org guardrail is on (Otari doesn't report it on streams).
const readGuard = () => import("./guard.ts").then(async (g) => {
  if (g.guardMode() !== "lakera") return null;
  // Keep Otari's Lakera definition on the configured Lakera project (its policy decides what is flagged).
  if (config.lakeraProject) { const p = await g.lakeraProject(); if (p && p.projectId !== config.lakeraProject) await g.setLakeraProject(config.lakeraProject); }
  return g.lakeraMandate();
}).catch(() => null);
await readGuard();
setInterval(readGuard, 10 * 60_000).unref();
const proxy = await startProxy();
await launchDurable();
// Recipes whose build is missing for the current base image (e.g. after `peeblo image`) are queued in the background.
void import("./environment/recipes.ts").then((r) => r.queueMissingBuilds()).catch(() => {});
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
