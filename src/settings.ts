// Settings a person gives in the console's setup (the Otari key, the public address, the console password, the first
// admin) live in the data directory as settings.json (owner-only file), next to what Peeblo makes. They are read
// before the rest of the configuration, and anything set in the environment (.env) wins over them. Saving some of
// them needs a restart (core exits with RESTART_CODE; `./peeblo up` and Compose start it again).
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RESTART_CODE = 75;
const dir = () => process.env.PEEBLO_DATA_DIR?.trim() || "/data";
const file = () => join(dir(), "settings.json");

export function readSettings(): Record<string, string> {
  try { return existsSync(file()) ? JSON.parse(readFileSync(file(), "utf8")) : {}; } catch { return {}; }
}

// Called by config.ts before it reads the environment.
export function loadSettingsIntoEnv(): void {
  for (const [k, v] of Object.entries(readSettings())) if (!process.env[k]?.trim() && typeof v === "string" && v) process.env[k] = v;
}

export function saveSettings(patch: Record<string, string | null>): void {
  const s = readSettings();
  for (const [k, v] of Object.entries(patch)) { if (v === null || v === "") delete s[k]; else s[k] = v; }
  writeFileSync(file(), JSON.stringify(s, null, 2));
  try { chmodSync(file(), 0o600); } catch { /* best effort */ }
}

// Restart into the new settings after the current response has gone out.
export function restartSoon(): void {
  setTimeout(() => process.exit(RESTART_CODE), 400).unref();
}
