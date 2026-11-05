// The daemon. For now: the database and a health line.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";
import { migrate, pool } from "./db.ts";

await mkdir(join(config.dataDir, "workspace"), { recursive: true });
await migrate();
console.log("peeblo: up");

const shutdown = async () => {
  await pool.end();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
