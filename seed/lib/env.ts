import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Credentials live outside the repo, in zama/.env, unless PEEBLO_ENV_FILE says otherwise.
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ENV_FILE = process.env.PEEBLO_ENV_FILE ?? resolve(REPO_ROOT, "..", ".env");

function parse(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2]; // later duplicates win, matching shell semantics
  }
  return out;
}

export function loadEnv(): Record<string, string> {
  if (!existsSync(ENV_FILE)) throw new Error(`env file not found: ${ENV_FILE}`);
  return { ...parse(readFileSync(ENV_FILE, "utf8")), ...pick(process.env) };
}

function pick(e: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(e)) if (/^(STRIPE|QUICKBOOKS|SALESFORCE|HUBSPOT|SLACK|NOTION|JIRA|DROPBOX|LEMMA|ARGA)_/.test(k) && v) out[k] = v;
  return out;
}

export function requireEnv(env: Record<string, string>, ...keys: string[]): void {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) throw new Error(`missing env vars: ${missing.join(", ")}`);
}

// Rewrites (or appends) a single key. Used for rotating tokens such as the QuickBooks refresh token.
export function updateEnv(key: string, value: string): void {
  const text = readFileSync(ENV_FILE, "utf8");
  const lines = text.split("\n").filter((l) => !l.startsWith(`${key}=`));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  lines.push(`${key}=${value}`, "");
  writeFileSync(ENV_FILE, lines.join("\n"));
}
