// Schedules are stored records. Each enabled one becomes a DBOS cron entry; a tick posts a submission
// whose request_id is the schedule id plus the tick time, so a tick can never make two runs.
import { DBOS } from "@dbos-inc/dbos-sdk";
import { pool } from "../db.ts";
import { submit } from "../store/sessions.ts";
import { startRun } from "./runs.ts";

type ScheduleRow = { id: string; session_id: string; cron: string; prompt: string; created_by: string | null };

async function tickFn(scheduledAt: Date, scheduleId: string): Promise<void> {
  await DBOS.runStep(async () => {
    const { rows } = await pool.query<ScheduleRow>("SELECT id, session_id, cron, prompt, created_by FROM schedules WHERE id = $1 AND enabled", [scheduleId]);
    if (!rows[0]) return;
    const s = rows[0];
    const { run, created } = await submit({ sessionId: s.session_id, personId: s.created_by, requestId: `schedule:${s.id}:${scheduledAt.toISOString()}`, text: s.prompt, source: "schedule" });
    if (created) await startRun(run.id);
  }, { name: "post" });
}
const tick = DBOS.registerWorkflow(tickFn, { name: "schedule-tick" });

// Makes the DBOS schedules match the table: adds or updates enabled ones, removes the rest.
export async function syncSchedules(): Promise<number> {
  const { rows } = await pool.query<ScheduleRow & { enabled: boolean }>("SELECT id, session_id, cron, prompt, created_by, enabled FROM schedules");
  const enabled = rows.filter((r) => r.enabled);
  await DBOS.applySchedules(enabled.map((r) => ({ scheduleName: `schedule:${r.id}`, workflowFn: tick, schedule: r.cron, context: r.id, automaticBackfill: false })));
  for (const r of rows.filter((r) => !r.enabled)) await DBOS.deleteSchedule(`schedule:${r.id}`).catch(() => {});
  return enabled.length;
}
