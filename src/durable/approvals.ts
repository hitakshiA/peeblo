// An approval is a paused run: the workflow records the request, then waits durably for an answer.
// No answer before the deadline counts as no. Answers arrive through answerApproval (API or Slack).
import { createHash } from "node:crypto";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { pool } from "../db.ts";
import { newId } from "../ids.ts";
import { appendEvent } from "../store/events.ts";

export type Decision = { decision: "approved" | "denied"; scope?: "once" | "job" | "always"; personId: string };

export function fingerprint(action: Record<string, unknown>): string {
  const canonical = JSON.stringify(action, Object.keys(action).sort());
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

// Call from inside a run's workflow. Returns the final status.
export async function requestApproval(runId: string, sessionId: string, action: Record<string, unknown>, ttlSeconds: number): Promise<"approved" | "denied" | "expired"> {
  const approvalId = await DBOS.runStep(async () => {
    const id = newId("ap");
    await pool.query(
      "INSERT INTO approvals (id, run_id, fingerprint, action, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))",
      [id, runId, fingerprint(action), action, ttlSeconds],
    );
    await pool.query("UPDATE runs SET status = 'waiting' WHERE id = $1", [runId]);
    await appendEvent({ sessionId, runId, type: "approval.requested", data: { approval_id: id, action, ttl_seconds: ttlSeconds } });
    return id;
  }, { name: "approval-request" });

  const answer = await DBOS.recv<Decision>(`approval:${approvalId}`, { timeoutSeconds: ttlSeconds });
  return DBOS.runStep(async () => {
    const status = answer ? answer.decision : "expired";
    await pool.query(
      "UPDATE approvals SET status = $2, scope = $3, decided_by = $4, decided_at = now() WHERE id = $1 AND status = 'pending'",
      [approvalId, status, answer?.scope ?? null, answer?.personId ?? null],
    );
    await pool.query("UPDATE runs SET status = 'running' WHERE id = $1", [runId]);
    await appendEvent({ sessionId, runId, type: "approval.resolved", data: { approval_id: approvalId, status, scope: answer?.scope ?? null, by: answer?.personId ?? null } });
    return status;
  }, { name: "approval-resolve" });
}

// Delivers an answer to the waiting run. Refuses answers to approvals that are no longer pending,
// so a late click on an expired card changes nothing and can be shown as "expired".
export async function answerApproval(approvalId: string, d: Decision): Promise<{ ok: boolean; status: string }> {
  const { rows } = await pool.query<{ run_id: string; status: string; expired: boolean }>(
    "SELECT run_id, status, expires_at < now() AS expired FROM approvals WHERE id = $1",
    [approvalId],
  );
  if (!rows[0]) return { ok: false, status: "not_found" };
  if (rows[0].status !== "pending") return { ok: false, status: rows[0].status };
  if (rows[0].expired) return { ok: false, status: "expired" };
  await DBOS.send(rows[0].run_id, d, `approval:${approvalId}`, `answer:${approvalId}`);
  return { ok: true, status: "sent" };
}
