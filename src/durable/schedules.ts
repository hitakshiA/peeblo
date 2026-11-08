// Schedules are stored records. Each enabled one becomes a DBOS cron entry; a tick posts a submission
// whose request_id is the schedule id plus the tick time, so a tick can never make two runs.
import { DBOS } from "@dbos-inc/dbos-sdk";
import { pool } from "../db.ts";

type ScheduleRow = { id: string; session_id: string; cron: string; prompt: string; created_by: string | null };

async function tickFn(scheduledAt: Date, scheduleId: string): Promise<void> {
  await DBOS.runStep(async () => {
    const { rows } = await pool.query<ScheduleRow>("SELECT id, session_id, cron, prompt, created_by FROM schedules WHERE id = $1 AND enabled", [scheduleId]);
    if (!rows[0]) return;
    // Through the triggers module: the hourly cap, the "anything to report?" framing, findings logged.
    const { fire } = await import("../triggers.ts");
    const full = (await pool.query("SELECT * FROM schedules WHERE id = $1", [scheduleId])).rows[0];
    await fire(full, "", "schedule", scheduledAt.toISOString());
  }, { name: "post" });
}
const tick = DBOS.registerWorkflow(tickFn, { name: "schedule-tick" });

// Makes the DBOS schedules match the table: adds or updates enabled ones, removes the rest.
export async function syncSchedules(): Promise<number> {
  const { rows } = await pool.query<ScheduleRow & { enabled: boolean }>("SELECT id, session_id, cron, prompt, created_by, enabled FROM schedules WHERE kind = 'cron'");
  const enabled = rows.filter((r) => r.enabled);
  // Test cadence (PEEBLO_TEST_CADENCE_MIN, off by default): every cron runs every N minutes, so a story can see it fire.
  const every = Number(process.env.PEEBLO_TEST_CADENCE_MIN ?? 0);
  await DBOS.applySchedules(enabled.map((r) => ({ scheduleName: `schedule:${r.id}`, workflowFn: tick, schedule: every > 0 ? `*/${every} * * * *` : r.cron, context: r.id, automaticBackfill: false })));
  for (const r of rows.filter((r) => !r.enabled)) await DBOS.deleteSchedule(`schedule:${r.id}`).catch(() => {});
  return enabled.length;
}
