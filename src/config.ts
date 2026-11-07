// Reads settings from the environment once at startup.
// Secrets are removed from process.env right away, so child processes never inherit them.

const SECRET_VARS = ["DATABASE_URL", "POSTGRES_PASSWORD", "PEEBLO_ADMIN_TOKEN", "PEEBLO_SECRET_KEY"];

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}. Copy .env.example to .env and fill it in.`);
  return value;
}

export const config = {
  databaseUrl: required("DATABASE_URL"),
  dataDir: process.env.PEEBLO_DATA_DIR?.trim() || "/data",
  // Fixed per installation so a restarted core recovers its own in-flight runs.
  executorId: process.env.PEEBLO_EXECUTOR_ID?.trim() || "core-1",
  // The core API never faces the internet: loopback by default (compose sets the internal address).
  apiHost: process.env.PEEBLO_API_HOST?.trim() || "127.0.0.1",
  apiPort: Number(process.env.PEEBLO_API_PORT ?? 7340),
  adminToken: required("PEEBLO_ADMIN_TOKEN"),
  secretKey: required("PEEBLO_SECRET_KEY"),
  // The public ingress (Slack events, interactions, OAuth callback). A tunnel or reverse proxy points at it.
  ingressHost: process.env.PEEBLO_INGRESS_HOST?.trim() || "127.0.0.1",
  ingressPort: Number(process.env.PEEBLO_INGRESS_PORT ?? 8787),
  publicUrl: (process.env.PEEBLO_PUBLIC_URL?.trim() || "").replace(/\/+$/, ""),
};

for (const name of SECRET_VARS) delete process.env[name];
