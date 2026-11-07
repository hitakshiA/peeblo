// The daemon. For now: the database and a health line.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";
import { migrate, pool } from "./db.ts";
import { launchDurable, shutdownDurable } from "./durable/dbos.ts";
import "./durable/runs.ts";
import { syncSchedules } from "./durable/schedules.ts";

await mkdir(join(config.dataDir, "workspace"), { recursive: true });
const applied = await migrate();
await launchDurable();
const schedules = await syncSchedules();
console.log(`peeblo: up (migrations applied: ${applied.length ? applied.join(", ") : "none new"}; ${schedules} schedules)`);

const shutdown = async () => {
  await shutdownDurable();
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
