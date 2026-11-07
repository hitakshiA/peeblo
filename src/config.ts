// Reads settings from the environment once at startup.
// Secrets are removed from process.env right away, so child processes never inherit them.

const SECRET_VARS = ["DATABASE_URL", "POSTGRES_PASSWORD"];

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
};

for (const name of SECRET_VARS) delete process.env[name];
