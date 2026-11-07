// DBOS Transact inside core, on the same Postgres (schema "dbos").
// executorID and applicationVersion stay fixed across restarts, so a restarted core recovers its own runs.
import { DBOS } from "@dbos-inc/dbos-sdk";
import { config } from "../config.ts";

export async function launchDurable(): Promise<void> {
  DBOS.setConfig({
    name: "peeblo",
    systemDatabaseUrl: config.databaseUrl,
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
