// Every module loads on its own: catches import cycles that break at start-up and top-level mistakes in files
// the unit tests don't otherwise touch. main.ts and bin.ts are left out because loading them starts core.
import { test } from "node:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const src = join(import.meta.dirname, "..", "src");
const files = readdirSync(src, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".ts") && f !== "main.ts" && f !== "bin.ts")
  .sort();

for (const f of files)
  test(`loads ${f}`, async () => {
    await import(join(src, f));
  });
