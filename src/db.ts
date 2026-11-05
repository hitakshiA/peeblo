import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { config } from "./config.ts";

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5 });

// Applies db/*.sql in name order. Each file is written to be safe to run again.
export async function migrate(): Promise<void> {
  const dir = join(import.meta.dirname, "..", "db");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    await pool.query(await readFile(join(dir, file), "utf8"));
  }
}
