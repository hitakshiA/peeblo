// DBOS Transact inside core, on the same Postgres (schema "dbos").
// executorID and applicationVersion stay fixed across restarts, so a restarted core recovers its own runs.
import { DBOS } from "@dbos-inc/dbos-sdk";
import { config } from "../config.ts";

// DBOS sets idle_in_transaction_session_timeout on each new connection with a query it doesn't wait for, so
// the connection's first real query overlaps it (pg warns now, and pg 9 will refuse). Setting the same
// timeout in the connection string makes Postgres apply it at connect, and DBOS then skips its own query.
export function durableDatabaseUrl(url: string): string {
  const u = new URL(url);
  const opts = u.searchParams.get("options") ?? "";
  if (!opts.includes("idle_in_transaction_session_timeout")) u.searchParams.set("options", `${opts} -c idle_in_transaction_session_timeout=60000`.trim());
  return u.toString();
}

export async function launchDurable(): Promise<void> {
  DBOS.setConfig({
    name: "peeblo",
    systemDatabaseUrl: durableDatabaseUrl(config.databaseUrl),
    systemDatabaseSchemaName: "dbos",
    executorID: config.executorId,
    applicationVersion: "peeblo-1",
    logLevel: "warn",
  });
  await DBOS.launch();
}

export async function shutdownDurable(): Promise<void> {
  await DBOS.shutdown();
}
