// Sessions, submissions and runs. A submission is idempotent on its request_id, so a redelivered
// Slack event or a retried API call never makes a second run.
import { pool } from "../db.ts";
import { newId } from "../ids.ts";
import type { SlackPlace } from "../slack/inbound.ts";
import { appendEvent } from "./events.ts";

export type SessionKind = "desk" | "channel" | "thread" | "dm" | "api";
export type Session = { id: string; teammate_id: string; kind: SessionKind; place_key: string; place: Record<string, unknown>; status: string };
export type Run = { id: string; submission_id: string; session_id: string; status: string; error: string | null; created_at: Date; started_at: Date | null; finished_at: Date | null };

export async function openSession(teammateId: string, kind: SessionKind, placeKey: string, place: Record<string, unknown> = {}): Promise<Session> {
  const { rows } = await pool.query<Session>(
    `INSERT INTO sessions (id, teammate_id, kind, place_key, place) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (teammate_id, kind, place_key) DO UPDATE SET last_active_at = now()
     RETURNING id, teammate_id, kind, place_key, place, status`,
    [newId("se"), teammateId, kind, placeKey, place],
  );
  return rows[0];
}

export async function getSession(id: string): Promise<Session | null> {
  const { rows } = await pool.query<Session>("SELECT id, teammate_id, kind, place_key, place, status FROM sessions WHERE id = $1", [id]);
  return rows[0] ?? null;
}

// Where a session lives in Slack (its channel, thread or DM), or null for a session outside Slack.
export async function slackPlaceOf(sessionId: string | null): Promise<SlackPlace | null> {
  if (!sessionId) return null;
  return ((await getSession(sessionId))?.place.slack as SlackPlace | undefined) ?? null;
}

// Records the submission and its run in one transaction. A repeated request_id returns the first run.
export async function submit(s: { sessionId: string; personId: string | null; requestId: string; text: string; source: string; chainId?: string | null }): Promise<{ submissionId: string; run: Run; created: boolean }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ins = await client.query<{ id: string }>(
      `INSERT INTO submissions (id, session_id, person_id, chain_id, request_id, text, source) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (request_id) DO NOTHING RETURNING id`,
      [newId("su"), s.sessionId, s.personId, s.chainId ?? null, s.requestId, s.text, s.source],
    );
    if (!ins.rows[0]) {
      await client.query("ROLLBACK");
      const { rows } = await pool.query<Run>(
        "SELECT r.* FROM runs r JOIN submissions su ON su.id = r.submission_id WHERE su.request_id = $1 ORDER BY r.created_at LIMIT 1",
        [s.requestId],
      );
      return { submissionId: rows[0].submission_id, run: rows[0], created: false };
    }
    const submissionId = ins.rows[0].id;
    const run = (await client.query<Run>("INSERT INTO runs (id, submission_id, session_id) VALUES ($1, $2, $3) RETURNING *", [newId("ru"), submissionId, s.sessionId])).rows[0];
    await appendEvent({ sessionId: s.sessionId, runId: run.id, type: "submission.received", data: { submission_id: submissionId, person_id: s.personId, source: s.source, text: s.text } }, client);
    await client.query("UPDATE sessions SET last_active_at = now() WHERE id = $1", [s.sessionId]);
    await client.query("COMMIT");
    return { submissionId, run, created: true };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getRun(id: string): Promise<Run | null> {
  const { rows } = await pool.query<Run>("SELECT * FROM runs WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function setRunStatus(id: string, status: Run["status"], error: string | null = null): Promise<void> {
  await pool.query(
    `UPDATE runs SET status = $2, error = $3,
       started_at = CASE WHEN $2 = 'running' AND started_at IS NULL THEN now() ELSE started_at END,
       finished_at = CASE WHEN $2 IN ('done', 'failed', 'cancelled') THEN now() ELSE finished_at END
     WHERE id = $1`,
    [id, status, error],
  );
}
