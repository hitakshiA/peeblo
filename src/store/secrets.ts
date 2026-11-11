// A teammate's computer secrets, sealed at rest. Only names and hosts ever leave this module, except to the
// VM's egress hooks, which swap a placeholder for the value on requests to the secret's hosts.
import { createHash } from "node:crypto";
import { seal, unseal } from "../crypto.ts";
import { pool } from "../db.ts";
import { HOST } from "../environment/recipe-schema.ts";


export async function setSecret(teammateId: string, name: string, value: string, hosts: string[]): Promise<void> {
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(name)) throw Object.assign(new Error("a secret name is upper-case letters, digits and _"), { status: 400 });
  if (!value) throw Object.assign(new Error("value is required"), { status: 400 });
  if (!hosts.length || !hosts.every((h) => HOST.test(h))) throw Object.assign(new Error("hosts must be one or more host names, e.g. api.github.com"), { status: 400 });
  await pool.query(
    `INSERT INTO teammate_secrets (teammate_id, name, value, hosts) VALUES ($1, $2, $3, $4)
     ON CONFLICT (teammate_id, name) DO UPDATE SET value = $3, hosts = $4, created_at = now()`,
    [teammateId, name, seal(value), hosts],
  );
}

export async function secretNames(teammateId: string): Promise<{ name: string; hosts: string[] }[]> {
  const { rows } = await pool.query("SELECT name, hosts FROM teammate_secrets WHERE teammate_id = $1 ORDER BY name", [teammateId]);
  return rows;
}

// A secret's placeholder is stable (the same on every boot and in build VMs), so a file a recipe writes with it,
// such as ~/.npmrc, keeps working; the real value only goes out to the secret's hosts.
export const placeholderOf = (teammateId: string, name: string) => `peeblo-secret-${createHash("sha256").update(`${teammateId}:${name}`).digest("hex").slice(0, 32)}`;

// For the VM's egress hooks only.
export async function secretsForVm(teammateId: string, only?: string[]): Promise<Record<string, { hosts: string[]; value: string; placeholder: string }>> {
  const { rows } = await pool.query("SELECT name, value, hosts FROM teammate_secrets WHERE teammate_id = $1", [teammateId]);
  return Object.fromEntries(rows.filter((r) => !only || only.includes(r.name)).map((r) => [r.name, { hosts: r.hosts, value: unseal<string>(r.value), placeholder: placeholderOf(teammateId, r.name) }]));
}
