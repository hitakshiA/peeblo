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
  const { rows } = await pool.query<{ text: string; person_id: string | null }>("SELECT text, person_id FROM submissions WHERE id = $1", [
    run.submission_id,
  ]);
  return { run, session, text: rows[0].text, personId: rows[0].person_id };
}

async function runWorkflowFn(runId: string): Promise<string> {
  const ctx = await DBOS.runStep(() => loadContext(runId), { name: "load" });
  // A teammate whose Slack app isn't installed doesn't work at all (src/slack/install.ts). Nothing is posted.
  const waiting = await DBOS.runStep(
    async () => {
      const { installState } = await import("../slack/install.ts");
      if ((await installState(ctx.session.teammate_id)).waiting) return "not_installed";
      // A teammate its owner paused (App Home) doesn't run either.
      const { pool } = await import("../db.ts");
      return (await pool.query("SELECT paused_at FROM teammates WHERE id = $1", [ctx.session.teammate_id])).rows[0]?.paused_at
        ? "paused"
        : null;
    },
    { name: "installed" },
  );
  if (waiting) {
    await DBOS.runStep(
      async () => {
        await setRunStatus(runId, "failed", waiting);
        await appendEvent({
          sessionId: ctx.session.id,
          runId,
          type: "run.refused",
          data: { reason: waiting, teammate_id: ctx.session.teammate_id },
        });
      },
      { name: "refused" },
    );
    return "refused";
  }
  await DBOS.runStep(
    async () => {
      await setRunStatus(runId, "running");
      await appendEvent({ sessionId: ctx.session.id, runId, type: "run.started", data: { workflow_id: DBOS.workflowID } });
    },
    { name: "start" },
  );
  if (!executor) {
    await DBOS.runStep(
      async () => {
        await setRunStatus(runId, "failed", "no executor configured");
        await appendEvent({ sessionId: ctx.session.id, runId, type: "run.failed", data: { error: "no executor configured" } });
      },
      { name: "finish" },
    );
    return "failed";
  }
  try {
    // The executor runs in workflow context, so it can use DBOS steps and durable waits (approvals) itself.
    const result = await executor(ctx);
    await DBOS.runStep(
      async () => {
        await setRunStatus(runId, "done");
        await appendEvent({ sessionId: ctx.session.id, runId, type: "run.finished", data: { summary: result.summary } });
      },
      { name: "finish" },
    );
    return "done";
  } catch (error) {
    const message = (error as Error).message;
    await DBOS.runStep(
      async () => {
        await setRunStatus(runId, "failed", message);
        await appendEvent({ sessionId: ctx.session.id, runId, type: "run.failed", data: { error: message } });
      },
      { name: "finish-failed" },
    );
    return "failed";
  }
}
const runWorkflow = DBOS.registerWorkflow(runWorkflowFn, { name: "run" });

// At most config.maxRunning jobs work at once (each needs memory for its agent and computer): people's jobs wait
// in a DBOS queue, oldest first. Work a running job is waiting on (a subagent, a call to another teammate) starts at
// once instead: queued behind its own parent, the two would wait on each other.
const JOBS_QUEUE = "jobs";
export async function registerJobsQueue(): Promise<void> {
  await DBOS.registerQueue(JOBS_QUEUE, { workerConcurrency: config.maxRunning, onConflict: "always_update" });
}

export async function startRun(runId: string, opts: { child?: boolean } = {}): Promise<void> {
  if (opts.child) return void (await DBOS.startWorkflow(runWorkflow, { workflowID: runId })(runId));
  const { pool } = await import("../db.ts");
  const { rows } = await pool.query(
    "SELECT (SELECT count(*)::int FROM runs WHERE status = 'running') AS working, (SELECT count(*)::int FROM runs WHERE status = 'queued' AND id <> $1 AND created_at > now() - interval '1 hour') AS waiting, (SELECT session_id FROM runs WHERE id = $1) AS session_id",
    [runId],
  );
  const { working, waiting, session_id } = rows[0] ?? {};
  // The person hears at once that their job is waiting, and how many are ahead.
  if (working >= config.maxRunning && session_id)
    await appendEvent({
      sessionId: session_id,
      runId,
      type: "run.queued",
      data: { ahead: Math.max(1, working - config.maxRunning + 1 + waiting), max_running: config.maxRunning },
    });
  await DBOS.startWorkflow(runWorkflow, { workflowID: runId, queueName: JOBS_QUEUE })(runId);
}
