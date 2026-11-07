// The append-only event log. Everything that happens to a run is written here first;
// run status, receipts and the job view are read back from it.
import type pg from "pg";
import { pool } from "../db.ts";

export type EventRow = { id: string; session_id: string | null; run_id: string | null; type: string; data: Record<string, unknown>; at: Date };
type Queryable = Pick<pg.Pool, "query"> | pg.PoolClient;

export async function appendEvent(
  e: { sessionId?: string | null; runId?: string | null; type: string; data?: Record<string, unknown> },
  db: Queryable = pool,
): Promise<EventRow> {
  const { rows } = await db.query<EventRow>(
    "INSERT INTO events (session_id, run_id, type, data) VALUES ($1, $2, $3, $4) RETURNING *",
    [e.sessionId ?? null, e.runId ?? null, e.type, e.data ?? {}],
  );
  for (const l of listeners) queueMicrotask(() => { try { void Promise.resolve(l(rows[0])).catch(() => {}); } catch { /* a view never breaks the log */ } });
  return rows[0];
}

// In-process listeners (views such as Slack streams); the log itself stays the source of truth.
const listeners: ((e: EventRow) => unknown)[] = [];
export const onEvent = (l: (e: EventRow) => unknown) => void listeners.push(l);

export async function runEvents(runId: string, afterId = 0): Promise<EventRow[]> {
  const { rows } = await pool.query<EventRow>("SELECT * FROM events WHERE run_id = $1 AND id > $2 ORDER BY id", [runId, afterId]);
  return rows;
}

export async function sessionEvents(sessionId: string, limit = 200): Promise<EventRow[]> {
  const { rows } = await pool.query<EventRow>(
    "SELECT * FROM (SELECT * FROM events WHERE session_id = $1 ORDER BY id DESC LIMIT $2) e ORDER BY id",
    [sessionId, limit],
  );
  return rows;
}
