// An approval is its own small durable workflow (workflow id = approval id): it records the request, waits
// for an answer, and resolves. No answer before the deadline counts as no. Answers arrive through
// answerApproval (API or Slack). A run asks from inside its workflow; a tool call in the middle of a turn
// asks from outside one; both wait on the same workflow.
import { createHash } from "node:crypto";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { pool } from "../db.ts";
import { newId } from "../ids.ts";
import { appendEvent } from "../store/events.ts";

export type Decision = { decision: "approved" | "denied"; scope?: "once" | "job" | "always"; personId: string | null; arguments?: Record<string, unknown> };
export type ApprovalResult = { approvalId: string; status: "approved" | "denied" | "expired"; scope: Decision["scope"] | null; arguments?: Record<string, unknown> | null };

export function fingerprint(action: Record<string, unknown>): string {
  const canonical = JSON.stringify(action, Object.keys(action).sort());
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

async function approvalWorkflowFn(approvalId: string, runId: string, sessionId: string, ttlSeconds: number): Promise<ApprovalResult> {
  const answer = await DBOS.recv<Decision>("approval", ttlSeconds);
  return DBOS.runStep(async () => {
    const status = answer ? answer.decision : "expired";
    await pool.query(
      "UPDATE approvals SET status = $2, scope = $3, decided_by = $4, decided_at = now() WHERE id = $1 AND status = 'pending'",
      [approvalId, status, answer?.scope ?? null, answer?.personId ?? null],
    );
    await pool.query("UPDATE runs SET status = 'running' WHERE id = $1 AND status = 'waiting'", [runId]);
    await appendEvent({ sessionId, runId, type: "approval.resolved", data: { approval_id: approvalId, status, scope: answer?.scope ?? null, by: answer?.personId ?? null, edited: Boolean(answer?.arguments) } });
    // Edit on the card: the person approved a changed call, which is what runs.
    return { approvalId, status, scope: answer?.scope ?? null, arguments: answer?.decision === "approved" ? answer?.arguments ?? null : null };
  }, { name: "approval-resolve" });
}
const approvalWorkflow = DBOS.registerWorkflow(approvalWorkflowFn, { name: "approval" });

async function record(runId: string, sessionId: string, raw: Record<string, unknown>, ttlSeconds: number): Promise<string> {
  // Every approval names who may answer it (src/approvers.ts).
  const { withApprovers } = await import("../approvers.ts");
  const action = await withApprovers(runId, raw);
  const id = newId("ap");
  await pool.query(
    "INSERT INTO approvals (id, run_id, fingerprint, action, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))",
    [id, runId, fingerprint(action), action, ttlSeconds],
  );
  await pool.query("UPDATE runs SET status = 'waiting' WHERE id = $1", [runId]);
  await appendEvent({ sessionId, runId, type: "approval.requested", data: { approval_id: id, action, ttl_seconds: ttlSeconds } });
  return id;
}

// From inside a run's workflow: the request is a step, so a resumed run waits on the same approval.
export async function requestApproval(runId: string, sessionId: string, action: Record<string, unknown>, ttlSeconds: number): Promise<ApprovalResult> {
  const id = await DBOS.runStep(() => record(runId, sessionId, action, ttlSeconds), { name: "approval-request" });
  const handle = await DBOS.startWorkflow(approvalWorkflow, { workflowID: id })(id, runId, sessionId, ttlSeconds);
  return handle.getResult();
}

// From outside a workflow (a tool call during a turn).
export async function askApproval(runId: string, sessionId: string, action: Record<string, unknown>, ttlSeconds: number): Promise<ApprovalResult> {
  const id = await record(runId, sessionId, action, ttlSeconds);
  const handle = await DBOS.startWorkflow(approvalWorkflow, { workflowID: id })(id, runId, sessionId, ttlSeconds);
  return handle.getResult();
}

// Delivers an answer to the waiting approval. Refuses answers to approvals that are no longer pending,
// so a late click on an expired card changes nothing and can be shown as "expired".
export async function answerApproval(approvalId: string, d: Decision): Promise<{ ok: boolean; status: string }> {
  const { rows } = await pool.query<{ status: string; expired: boolean; action: any }>(
    "SELECT status, expires_at < now() AS expired, action FROM approvals WHERE id = $1",
    [approvalId],
  );
  if (!rows[0]) return { ok: false, status: "not_found" };
  if (rows[0].status !== "pending") return { ok: false, status: rows[0].status };
  if (rows[0].expired) return { ok: false, status: "expired" };
  // Every approval names who can answer it; anyone else is refused (an empty list means no one, never anyone).
  const only = (rows[0].action?.approvers as string[] | undefined) ?? [];
  if (!d.personId || !only.includes(d.personId)) return { ok: false, status: "not_allowed" };
  await DBOS.send(approvalId, d, "approval", `answer:${approvalId}`);
  return { ok: true, status: "sent" };
}
