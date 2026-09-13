import { Agent, ProviderSettingsManager, resolveProviderApiKeyFromSettings } from "@cline/sdk";
import { Lemma } from "@uselemma/tracing";
import { buildTools } from "./tools.ts";
import { cases, evidence, runs, wakeups, lessons, now, db } from "./store.ts";
import { operations } from "./executor.ts";
import { env } from "./connectors.ts";
import { emit, appsFor } from "./bus.ts";

export const activeRuns = new Map<string, { abort: (reason: string) => void; runId: string }>();

const MODEL = process.env.PEEBLO_MODEL ?? env.PEEBLO_MODEL ?? "cline-pass/glm-5.3-flash";
const RELEASE = process.env.PEEBLO_RELEASE ?? "peeblo-agent@0.1.0";
const lemma = env.LEMMA_API_KEY ? new Lemma({ apiKey: env.LEMMA_API_KEY, projectId: env.LEMMA_PROJECT_ID, release: RELEASE }) : undefined;

// ClinePass access: a CLINE_API_KEY (servers) or the local Cline CLI login (refreshed by the CLI).
async function modelKey(): Promise<{ providerId: string; apiKey: string }> {
  if (env.CLINE_API_KEY) return { providerId: "cline", apiKey: env.CLINE_API_KEY };
  const apiKey = await resolveProviderApiKeyFromSettings(new ProviderSettingsManager(), "cline");
  if (!apiKey) throw new Error("No ClinePass credentials: set CLINE_API_KEY or run `cline auth`.");
  return { providerId: "cline", apiKey };
}

export const STANDING_RESPONSIBILITY = `You are Peeblo, the accounts receivable and billing operations teammate for Miny Labs, Inc. (US entity, USD).
Standing responsibility: own receivables for the US subscription business. Detect missing or inaccurate invoices, investigate overdue balances, manage payment promises, and reconcile received payments. Perform authorized corrections, escalate decisions outside your authority, and maintain evidence and a next action for every unresolved case.`;

const WORKING_METHOD = `How you work:
1. Identify the unresolved business question for this case.
2. Retrieve current evidence from the systems of record before concluding anything. Notifications and colleague messages are hints, not facts. Read the relevant Notion policy before any money movement, customer communication, or correction.
3. Test explanations. Names and domains only find candidates; confirm identity with legal entity, EIN, contract, remittance or record IDs. Similar names (e.g. parents, affiliates, unrelated lookalikes) are common.
4. Choose one: act via propose_action, request approval (the executor does this automatically), record a dependency, or schedule a follow-up. Do the smallest correct change; never create duplicates; never touch unrelated records.
5. After each action, read the verified state the executor returns. If an outcome is uncertain, call retry_operation (it reconciles first). If awaiting approval, schedule a follow-up and finish as waiting.
6. "Billing exception resolved" and "receivable settled" are different outcomes. A corrected invoice is still collectible.
7. Money arithmetic: state amounts exactly as records show; the executor validates totals.
8. Record key facts with record_evidence as you go, then call finish_run with an honest status, summary and next action.
Be efficient: batch reads, avoid re-reading the same record, and stop once the next step is waiting on someone else.`;

function caseContext(caseId: string, trigger: string) {
  const c = cases.get(caseId)!;
  const ev = evidence.list(caseId);
  const ops = operations.list(caseId);
  const history = runs.list(caseId);
  const lessonList = lessons.reviewed();
  return [
    `Today is ${now().slice(0, 10)} (current time ${now()}).`,
    `CASE ${c.id} — status: ${c.status}`,
    `Objective: ${c.objective}`,
    c.summary ? `Last summary: ${c.summary}` : "",
    c.next_action ? `Planned next action: ${c.next_action}` : "",
    `Wake-up trigger for this run: ${trigger}`,
    ev.length ? `Evidence so far:\n${ev.map((e: any) => `- [${e.source}${e.ref ? ` ${e.ref}` : ""}] ${e.fact}`).join("\n")}` : "No evidence recorded yet.",
    ops.length ? `Operations so far:\n${ops.map((o: any) => `- ${o.id} ${o.kind} ${o.status}${o.amount != null ? ` $${o.amount}` : ""}${o.verification ? ` — ${o.verification}` : ""}${o.error ? ` — error: ${o.error}` : ""}`).join("\n")}` : "",
    history.length ? `Previous runs: ${history.length}` : "",
    lessonList.length ? `Reviewed lessons:\n${lessonList.map((l) => `- ${l.lesson}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

export async function runCase(caseId: string, trigger: string, opts: { maxIterations?: number; onEvent?: (line: string) => void } = {}) {
  const runId = runs.start(caseId, trigger);
  const log = opts.onEvent ?? (() => {});
  const { providerId, apiKey } = await modelKey();
  let interrupted: string | undefined;
  if (activeRuns.has(caseId)) throw new Error(`case ${caseId} already has an active run`);
  const agent = new Agent({ providerId, modelId: MODEL, apiKey, systemPrompt: `${STANDING_RESPONSIBILITY}\n\n${WORKING_METHOD}`, tools: buildTools(caseId, { interrupt: (reason) => { interrupted = reason; setTimeout(() => agent.abort(reason), 0); } }), maxIterations: opts.maxIterations ?? 40 } as any);

  activeRuns.set(caseId, { runId, abort: (reason) => { interrupted = reason; agent.abort(reason); } });
  emit(caseId, runId, "run.started", { trigger, model: MODEL });
  let reasoningBuf = "", lastFlush = 0;
  const flushReasoning = (force = false) => { if (reasoningBuf && (force || Date.now() - lastFlush > 350)) { emit(caseId, runId, "thinking", { text: reasoningBuf }); reasoningBuf = ""; lastFlush = Date.now(); } };
  const trace = lemma?.trace({ name: "peeblo-case-run", input: { case_id: caseId, trigger }, metadata: { "case.id": caseId, "run.id": runId, "tenant.id": "miny-labs", "agent.model": MODEL } });
  const toolSpans = new Map<string, ReturnType<NonNullable<typeof trace>["startTool"]>>();
  let lastUsage: any;
  let generation: ReturnType<NonNullable<typeof trace>["startGeneration"]> | undefined;
  agent.subscribe((e: any) => {
    try {
      if (e.type === "assistant-reasoning-delta" || e.type === "assistant-text-delta") { reasoningBuf += e.text; flushReasoning(); }
      if (e.type === "turn-started") generation = trace?.startGeneration({ name: `turn-${e.iteration}`, model: MODEL, llmModelName: MODEL, llmProvider: "cline-pass", startedAt: new Date(), metadata: { iteration: e.iteration, "case.id": caseId } } as any);
      if (e.type === "usage-updated") lastUsage = e.usage;
      if (e.type === "assistant-message") {
        const text = e.message.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("");
        generation?.end({ endedAt: new Date(), usage: lastUsage ? { inputTokens: lastUsage.inputTokens, outputTokens: lastUsage.outputTokens } : undefined, output: text || `(${e.message.content.filter((p: any) => p.type === "tool-call").map((p: any) => p.toolName).join(", ")})` } as any);
        flushReasoning(true);
        if (text.trim()) { log(`💬 ${text.trim().slice(0, 300)}`); emit(caseId, runId, "message", { text: text.trim() }); }
      }
      if (e.type === "tool-started") {
        toolSpans.set(e.toolCall.toolCallId, trace?.startTool({ name: e.toolCall.toolName, toolName: e.toolCall.toolName, input: e.toolCall.input, startedAt: new Date(), metadata: { "case.id": caseId, apps: appsFor(e.toolCall.toolName, e.toolCall.input).join(",") } } as any)!);
        log(`🔧 ${e.toolCall.toolName} ${JSON.stringify(e.toolCall.input).slice(0, 200)}`);
        flushReasoning(true);
        emit(caseId, runId, "tool.started", { id: e.toolCall.toolCallId, tool: e.toolCall.toolName, apps: appsFor(e.toolCall.toolName, e.toolCall.input), input: e.toolCall.input });
      }
      if (e.type === "tool-finished") {
        const result = e.message.content.find((p: any) => p.type === "tool-result");
        const output = result?.output ?? result;
        const isError = Boolean(result?.isError || (output && typeof output === "object" && "error" in output));
        toolSpans.get(e.toolCall.toolCallId)?.end({ output, endedAt: new Date(), status: isError ? "ERROR" : "OK", ...(isError ? { error: String((output as any)?.error ?? "tool error") } : {}) } as any);
        emit(caseId, runId, "tool.finished", { id: e.toolCall.toolCallId, tool: e.toolCall.toolName, apps: appsFor(e.toolCall.toolName, e.toolCall.input), input: e.toolCall.input, output: JSON.parse(JSON.stringify(output ?? null, (_k, v) => (typeof v === "string" && v.length > 4000 ? v.slice(0, 4000) + "…" : v))), error: isError });
        const s = JSON.stringify(output ?? "");
        log(`   ↳ ${s.slice(0, 240)}${s.length > 240 ? "…" : ""}`);
      }
    } catch { /* tracing must never break the agent */ }
  });

  let result: any;
  try {
    result = await agent.run(caseContext(caseId, trigger));
    // A run must end with an explicit, honest outcome; nudge once if the model stopped without reporting.
    const finished = () => (db.prepare("SELECT 1 FROM run_events WHERE run_id = ? AND type = 'tool.finished' AND data LIKE '%\"tool\":\"finish_run\"%'").get(runId));
    if (!interrupted && result.status === "completed" && !finished()) result = await agent.continue("You stopped without calling finish_run. Complete any remaining step that is within authority, then call finish_run with an honest status, summary and next action.");
  } catch (err) {
    activeRuns.delete(caseId);
    emit(caseId, runId, "run.finished", { status: "failed", error: (err as Error).message });
    trace?.fail?.(err as Error);
    runs.end(runId, { status: "failed", output: (err as Error).message, iterations: 0, inputTokens: 0, outputTokens: 0, traceId: (trace as any)?.id });
    await (trace as any)?.end?.({ output: { error: (err as Error).message } });
    throw err;
  }
  activeRuns.delete(caseId);
  const c = cases.get(caseId)!;
  const ops = operations.list(caseId) as any[];
  if (interrupted) { cases.update(caseId, { status: "open", next_action: `Resume after interruption (${interrupted})` }); }
  emit(caseId, runId, "run.finished", { status: interrupted ? "interrupted" : result.status, reason: interrupted, case: cases.get(caseId), usage: result.usage, iterations: result.iterations });
  trace?.recordSpan?.({ name: "verify-outcome", metadata: { "case.status": c.status, "operations.succeeded": ops.filter((o) => o.status === "succeeded").length, "operations.uncertain": ops.filter((o) => o.status === "uncertain").length, "operations.awaiting_approval": ops.filter((o) => o.status === "awaiting_approval").length } } as any);
  runs.end(runId, { status: result.status, output: result.outputText, iterations: result.iterations, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, traceId: (trace as any)?.id });
  if (result.status !== "completed") trace?.fail?.(result.error ?? new Error(result.status));
  await (trace as any)?.end?.({ output: { status: c.status, summary: c.summary, next_action: c.next_action, pending_wakeup: wakeups.pending(caseId) } });
  return { run_id: runId, status: interrupted ? "interrupted" : result.status, iterations: result.iterations, usage: result.usage, case: cases.get(caseId)!, error: result.error?.message };
}
