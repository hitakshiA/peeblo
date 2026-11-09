// An approval is its own small durable workflow (workflow id = approval id): it records the request, waits
// for an answer, and resolves. No answer before the deadline counts as no. Answers arrive through
// answerApproval (API or Slack). A run asks from inside its workflow; a tool call in the middle of a turn
// asks from outside one; both wait on the same workflow.
import { createHash } from "node:crypto";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { pool } from "../db.ts";
import { newId } from "../ids.ts";
import { appendEvent } from "../store/events.ts";

export type Decision = { decision: "approved" | "denied"; scope?: "once" | "job" | "always"; personId: string | null; arguments?: Record<string, unknown>; reason?: string; superseded?: boolean };
export type ApprovalResult = { approvalId: string; status: "approved" | "denied" | "expired"; scope: Decision["scope"] | null; arguments?: Record<string, unknown> | null; reason?: string | null; superseded?: boolean };

// Keys sorted at every level. (A key list passed to JSON.stringify filters nested keys too, which made calls that
// differ only inside a nested object, like Stripe's params.starting_after, look identical.)
const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canon((v as any)[k])])) : v;
export function fingerprint(action: Record<string, unknown>): string {
  const canonical = JSON.stringify(canon(action));
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
    await appendEvent({ sessionId, runId, type: "approval.resolved", data: { approval_id: approvalId, status, scope: answer?.scope ?? null, by: answer?.personId ?? null, edited: Boolean(answer?.arguments), reason: answer?.reason ?? null, superseded: Boolean(answer?.superseded) } });
    // Edit on the card: the person approved a changed call, which is what runs.
    return { approvalId, status, scope: answer?.scope ?? null, arguments: answer?.decision === "approved" ? answer?.arguments ?? null : null, reason: answer?.reason ?? null, superseded: Boolean(answer?.superseded) };
  }, { name: "approval-resolve" });
}
const approvalWorkflow = DBOS.registerWorkflow(approvalWorkflowFn, { name: "approval" });

async function record(runId: string, sessionId: string, raw: Record<string, unknown>, ttlSeconds: number): Promise<string> {
  // Every approval names who may answer it (src/approvers.ts).
  const { withApprovers } = await import("../approvers.ts");
  const action = await withApprovers(runId, raw);
  // An estimate for the card: the next model call of this run, at its current prompt size, at catalog prices.
  if (action.price_usd == null) {
    const last = (await pool.query("SELECT data FROM events WHERE run_id = $1 AND type = 'model.call' AND data->>'status' = '200' ORDER BY id DESC LIMIT 1", [runId])).rows[0]?.data;
    if (last?.requested_model && last?.prompt_tokens) {
      const { estimateCost } = await import("../otari/catalog.ts");
      const { ROLES } = await import("../otari/routing.ts");
      const m = last.requested_model in ROLES ? ROLES[last.requested_model].default : last.requested_model;
      const est = await estimateCost(m, Number(last.prompt_tokens), 1000).catch(() => null);
      if (est != null) action.price_usd = est;
    }
  }
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

// The same call in the same run (what a person sees on the card): its kind, teammate, tool and arguments.
const sameCall = (a: any) => fingerprint({ kind: a.kind ?? null, teammate: a.teammate ?? null, server: a.server ?? null, tool: a.tool ?? null, arguments: JSON.stringify(a.arguments ?? {}) });

// From outside a workflow (a tool call during a turn). After a restart the call that was waiting is gone; when the
// agent makes the same call again it joins the card already shown (still waiting, or answered but never run), so a
// person never answers twice and an approved call runs once.
export async function askApproval(runId: string, sessionId: string, action: Record<string, unknown>, ttlSeconds: number): Promise<ApprovalResult> {
  const key = sameCall(action);
  const earlier = (await pool.query(
    `SELECT a.id FROM approvals a WHERE a.run_id = $1 AND a.status IN ('pending', 'approved', 'denied')
       AND NOT EXISTS (SELECT 1 FROM events e WHERE e.run_id = $1 AND e.type = 'tool.call' AND e.data->>'approval_id' = a.id)
     ORDER BY a.created_at DESC`, [runId])).rows as { id: string }[];
  for (const r of earlier) {
    const row = (await pool.query("SELECT action FROM approvals WHERE id = $1", [r.id])).rows[0];
    if (row && sameCall(row.action) === key) {
      await appendEvent({ sessionId, runId, type: "approval.rejoined", data: { approval_id: r.id } });
      return DBOS.retrieveWorkflow<ApprovalResult>(r.id).getResult();
    }
  }
  const id = await record(runId, sessionId, action, ttlSeconds);
  const handle = await DBOS.startWorkflow(approvalWorkflow, { workflowID: id })(id, runId, sessionId, ttlSeconds);
  return handle.getResult();
}

// Ends a waiting approval as expired (nothing runs; the card says so), e.g. after a rule change made it moot.
export async function expireApproval(approvalId: string): Promise<{ ok: boolean; status: string }> {
  const row = (await pool.query("SELECT status FROM approvals WHERE id = $1", [approvalId])).rows[0];
  if (!row) return { ok: false, status: "not_found" };
  if (row.status !== "pending") return { ok: false, status: row.status };
  await DBOS.send(approvalId, null as any, "approval", `expire:${approvalId}`);
  return { ok: true, status: "expiring" };
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
