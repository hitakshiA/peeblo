// Reads settings from the environment once at startup.
// Secrets are removed from process.env right away, so child processes never inherit them.

const SECRET_VARS = ["DATABASE_URL", "POSTGRES_PASSWORD", "PEEBLO_ADMIN_TOKEN"];

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
};

for (const name of SECRET_VARS) delete process.env[name];
