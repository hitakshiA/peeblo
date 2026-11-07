// A tiny harness for the live Otari checks: each check runs against hosted Otari (small spend), records
// the request ids it saw, and passes or fails. Results go to local/otari-check/<seam>.json.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type Ctx = { ids: string[]; note: (k: string, v: unknown) => void };
type Result = { seam: string; check: string; ok: boolean; ms: number; ids: string[]; notes: Record<string, unknown>; error?: string };
const results: Result[] = [];

export async function check(seam: string, name: string, fn: (c: Ctx) => Promise<void>): Promise<void> {
  const ids: string[] = [];
  const notes: Record<string, unknown> = {};
  const t0 = Date.now();
  try {
    await fn({ ids, note: (k, v) => { notes[k] = v; } });
    results.push({ seam, check: name, ok: true, ms: Date.now() - t0, ids, notes });
    console.log(`✓ ${seam} · ${name}${ids.length ? `  [${ids.join(", ")}]` : ""}`);
  } catch (error) {
    results.push({ seam, check: name, ok: false, ms: Date.now() - t0, ids, notes, error: (error as Error).message });
    console.log(`✗ ${seam} · ${name}: ${(error as Error).message}`);
  }
}

export function expect(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

export async function save(seam: string): Promise<boolean> {
  const dir = join(process.cwd(), "local", "otari-check");
  await mkdir(dir, { recursive: true });
  const mine = results.filter((r) => r.seam === seam);
  await writeFile(join(dir, `${seam}.json`), JSON.stringify({ at: new Date().toISOString(), results: mine }, null, 2));
  return mine.every((r) => r.ok);
}
