// `peeblo check`: verifies a setup end to end and says exactly what to fix. Exit code 1 if anything fails.
import { access, constants, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.ts";
import { migrate, pool } from "./db.ts";
import { imagePath } from "./environment/controller.ts";

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];
const check = async (name: string, fn: () => Promise<string>) => {
  try { results.push({ name, ok: true, detail: await fn() }); } catch (e) { results.push({ name, ok: false, detail: (e as Error).message }); }
};

await check("database", async () => {
  const { rows } = await pool.query<{ server_version: string }>("SHOW server_version");
  const applied = await migrate();
  return `Postgres ${rows[0].server_version}; migrations ${applied.length ? `applied now: ${applied.join(", ")}` : "up to date"}`;
});
await check("durable execution", async () => {
  const { rows } = await pool.query("SELECT 1 FROM information_schema.schemata WHERE schema_name = 'dbos'");
  return rows.length ? "DBOS schema present" : "DBOS schema not created yet (it appears on the first daemon start)";
});
await check("data directory", async () => {
  const probe = join(config.dataDir, ".write-test");
  await writeFile(probe, "ok");
  await unlink(probe);
  return config.dataDir;
});
await check("teammate computer image", async () => {
  const p = imagePath();
  await access(join(p, "manifest.json"), constants.R_OK).catch(() => { throw new Error(`no VM image at ${p}; run: ./peeblo image`); });
  return `${config.vmArch} image at ${p}`;
});
await check("hypervisor", async () => {
  if (process.platform === "linux") {
    await access("/dev/kvm", constants.R_OK | constants.W_OK).catch(() => { throw new Error("/dev/kvm is missing or not writable; teammate computers need KVM (bare metal or nested virtualization)"); });
    return "KVM available";
  }
  if (process.platform === "darwin") return "macOS Hypervisor.framework (Gondolin runs natively)";
  throw new Error(`unsupported platform ${process.platform}`);
});
await check("public URL", async () => {
  if (!config.publicUrl) throw new Error("PEEBLO_PUBLIC_URL is not set; Slack needs a public HTTPS URL (a domain, or a tunnel on a Mac)");
  if (!config.publicUrl.startsWith("https://")) throw new Error("PEEBLO_PUBLIC_URL must be https://");
  const r = await fetch(`${config.publicUrl}/slack/events`, { method: "POST", headers: { "content-type": "application/json", "user-agent": "peeblo-check" }, body: JSON.stringify({ type: "url_verification", challenge: "peeblo-check" }), signal: AbortSignal.timeout(10_000) });
  const text = await r.text();
  if (text !== "peeblo-check") throw new Error(`${config.publicUrl} answered ${r.status} but not as this Peeblo's ingress (is the daemon running and the tunnel pointed at port ${config.ingressPort}?)`);
  return `${config.publicUrl} reaches this ingress`;
});
await check("console stays private", async () => {
  if (!config.publicUrl) return "no public URL set";
  const r = await fetch(`${config.publicUrl}/v1/teammates`, { headers: { "user-agent": "peeblo-check" }, signal: AbortSignal.timeout(10_000) });
  if (r.status !== 404) throw new Error(`${config.publicUrl}/v1/teammates answered ${r.status}; the core API must not be public`);
  return "core API is not reachable from the public URL";
});

for (const r of results) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}: ${r.detail}`);
await pool.end();
process.exit(results.every((r) => r.ok) ? 0 : 1);
