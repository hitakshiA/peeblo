// The daemon: migrations, durable execution, schedules and the core API.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";
import { migrate, pool } from "./db.ts";
import { launchDurable, shutdownDurable } from "./durable/dbos.ts";
import "./durable/runs.ts";
import { syncSchedules } from "./durable/schedules.ts";
import { startApi } from "./api/server.ts";

await mkdir(join(config.dataDir, "workspace"), { recursive: true });
const applied = await migrate();
await launchDurable();
const schedules = await syncSchedules();
const api = await startApi();
console.log(`peeblo: up (migrations applied: ${applied.length ? applied.join(", ") : "none new"}; ${schedules} schedules; api on ${config.apiHost}:${config.apiPort})`);

const shutdown = async () => {
  api.close();
  await shutdownDurable();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
