// A run is a DBOS workflow whose id is the run id: starting it twice is a no-op, and a run that was
// in flight when core died resumes after restart. What a run does is the executor's job; until one
// is configured, a run ends with a clear "no executor" failure in its events.
import { DBOS } from "@dbos-inc/dbos-sdk";
import { config } from "../config.ts";
import { appendEvent } from "../store/events.ts";
import { getRun, getSession, setRunStatus, type Run, type Session } from "../store/sessions.ts";

export type RunContext = { run: Run; session: Session; text: string; personId: string | null };
export type RunExecutor = (ctx: RunContext) => Promise<{ summary: string }>;

let executor: RunExecutor | null = null;
export function setRunExecutor(fn: RunExecutor): void {
  executor = fn;
}

async function loadContext(runId: string): Promise<RunContext> {
  const run = await getRun(runId);
  if (!run) throw new Error(`no run ${runId}`);
  const session = (await getSession(run.session_id))!;
  const { pool } = await import("../db.ts");
  const { rows } = await pool.query<{ text: string; person_id: string | null }>("SELECT text, person_id FROM submissions WHERE id = $1", [run.submission_id]);
  return { run, session, text: rows[0].text, personId: rows[0].person_id };
}

async function runWorkflowFn(runId: string): Promise<string> {
  const ctx = await DBOS.runStep(() => loadContext(runId), { name: "load" });
  // A teammate whose Slack app isn't installed doesn't work at all (src/slack/install.ts). Nothing is posted.
  const waiting = await DBOS.runStep(async () => {
    const { installState } = await import("../slack/install.ts");
    if ((await installState(ctx.session.teammate_id)).waiting) return "not_installed";
    // A teammate its owner paused (App Home) doesn't run either.
    const { pool } = await import("../db.ts");
    return (await pool.query("SELECT paused_at FROM teammates WHERE id = $1", [ctx.session.teammate_id])).rows[0]?.paused_at ? "paused" : null;
  }, { name: "installed" });
  if (waiting) {
    await DBOS.runStep(async () => {
      await setRunStatus(runId, "failed", waiting);
      await appendEvent({ sessionId: ctx.session.id, runId, type: "run.refused", data: { reason: waiting, teammate_id: ctx.session.teammate_id } });
    }, { name: "refused" });
    return "refused";
  }
  // At most config.maxRunning jobs work at once (memory): this one waits for a free slot, oldest first.
  for (let i = 0; ; i++) {
    const ahead = await DBOS.runStep(() => claimSlot(runId), { name: "slot" });
    if (ahead === 0) break;
    if (i === 0) await DBOS.runStep(() => appendEvent({ sessionId: ctx.session.id, runId, type: "run.queued", data: { ahead, max_running: config.maxRunning } }), { name: "queued" });
    await DBOS.sleep(2000);
  }
  await DBOS.runStep(async () => {
    await setRunStatus(runId, "running");
    await appendEvent({ sessionId: ctx.session.id, runId, type: "run.started", data: { workflow_id: DBOS.workflowID } });
  }, { name: "start" });
  if (!executor) {
    await DBOS.runStep(async () => {
      await setRunStatus(runId, "failed", "no executor configured");
      await appendEvent({ sessionId: ctx.session.id, runId, type: "run.failed", data: { error: "no executor configured" } });
    }, { name: "finish" });
    return "failed";
  }
  try {
    // The executor runs in workflow context, so it can use DBOS steps and durable waits (approvals) itself.
    const result = await executor(ctx);
    await DBOS.runStep(async () => {
      await setRunStatus(runId, "done");
      await appendEvent({ sessionId: ctx.session.id, runId, type: "run.finished", data: { summary: result.summary } });
    }, { name: "finish" });
    return "done";
  } catch (error) {
    const message = (error as Error).message;
    await DBOS.runStep(async () => {
      await setRunStatus(runId, "failed", message);
      await appendEvent({ sessionId: ctx.session.id, runId, type: "run.failed", data: { error: message } });
    }, { name: "finish-failed" });
    return "failed";
  }
}
const runWorkflow = DBOS.registerWorkflow(runWorkflowFn, { name: "run" });

// Takes a working slot when one is free and no older job is waiting for one: 0, and the run is marked running.
// Otherwise how many jobs are ahead. One lock, so two jobs never take the last slot together.
async function claimSlot(runId: string): Promise<number> {
  const { pool } = await import("../db.ts");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(7340001)");
    const { rows } = await c.query(
      `SELECT (SELECT count(*)::int FROM runs WHERE status = 'running' AND id <> $1) AS working,
              (SELECT count(*)::int FROM runs r JOIN events e ON e.run_id = r.id AND e.type = 'run.queued'
                WHERE r.status = 'queued' AND r.id <> $1 AND r.created_at < (SELECT created_at FROM runs WHERE id = $1)
                  AND r.created_at > now() - interval '1 hour') AS older`, [runId]);
    const { working, older } = rows[0];
    const free = working < config.maxRunning && older === 0;
    if (free) await c.query("UPDATE runs SET status = 'running', started_at = coalesce(started_at, now()) WHERE id = $1", [runId]);
    await c.query("COMMIT");
    return free ? 0 : Math.max(1, working - config.maxRunning + 1 + older);
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}

export async function startRun(runId: string): Promise<void> {
  await DBOS.startWorkflow(runWorkflow, { workflowID: runId })(runId);
}
