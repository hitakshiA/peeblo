// The receipt modal, opened by the Receipt button under a reply: the facts (model, provider,
// attempts, any fallback, the guard that checked it, cost, the asker's budget), the steps, and one link, "Open full
// trace", into Otari. Built from the event log; the model never writes any of it.
import { pool } from "../db.ts";
import { buildReceipt } from "../receipts.ts";
import { money, readableModel, readableProvider, stepOutput, stepTitle } from "./look.ts";

// "Maya · $3.10 of $40 this month": the asker's spend against their own Otari limit.
async function personBudget(runId: string): Promise<string | null> {
  const p = (await pool.query("SELECT p.display_name, p.end_user_id FROM runs r JOIN submissions sub ON sub.id = r.submission_id JOIN people p ON p.id = sub.person_id WHERE r.id = $1", [runId])).rows[0];
  if (!p?.end_user_id) return null;
  // The same number the budget check uses: across every teammate's key, over the tier's own period.
  const { endUser, tiers } = await import("../otari/people.ts");
  const { personSpend } = await import("../otari/spend.ts");
  const [u, t, s] = await Promise.all([endUser(p.end_user_id), tiers(), personSpend(p.end_user_id)]);
  const tier = t.find((x) => x.budget_id === u?.budget_id) ?? t.find((x) => x.is_default);
  if (!tier?.max_budget) return null;
  const a = tier.reset_alignment ?? "";
  const period = /day/.test(a) ? "today" : /week/.test(a) ? "this week" : "this month";
  return `${String(p.display_name ?? "You").split(" ")[0]} · ${money(s.spent)} of ${money(tier.max_budget)} ${period}`;
}

export async function receiptModal(runId: string): Promise<any> {
  const r = await buildReceipt(runId).catch(() => null);
  const budget = await personBudget(runId).catch(() => null);
  const calls = (await pool.query("SELECT data FROM events WHERE run_id = $1 AND type = 'tool.call' ORDER BY id", [runId])).rows.map((x) => x.data);
  const steps: string[] = [];
  for (const d of calls) {
    const title = stepTitle(d.tool, { command: d.command, kind: d.kind, callee: d.callee });
    if (!title) continue;
    const out = d.status === "completed" ? stepOutput(d.tool, d.summary, Number(d.lines ?? 0)) : d.status === "denied" ? "not now" : ["failed", "refused", "invalid", "expired"].includes(d.status) ? "didn't work" : undefined;
    const line = `${d.status === "completed" ? "✓" : d.status === "denied" ? "–" : "✗"} ${title}${out ? ` · ${out}` : ""}`;
    if (steps.at(-1) !== line) steps.push(line);
  }
  const models = (r?.models ?? []).map((m) => readableModel(m).name);
  const fact = (label: string, value: string) => ({ type: "mrkdwn", text: `*${label}*\n${value}` });
  const facts = r ? [
    fact("Model", models[0] ?? "none"),
    fact("Provider", r.providers.map(readableProvider).join(", ") || "–"),
    fact("Calls", `${r.calls}${r.failed_attempts ? ` (${r.failed_attempts} retried)` : ""}`),
    ...(r.fallbacks && models[1] ? [fact("Fell back to", models[1])] : []),
    fact("Checked by", r.guard.checked_by ? r.guard.checked_by.replace(/ \(.*\)$/, "") : "nothing from outside the company to screen"),
    fact("Cost", money(r.cost_usd)),
    ...(budget ? [fact("Budget used", budget)] : []),
  ] : [];
  return {
    type: "modal", title: { type: "plain_text", text: "Receipt" }, close: { type: "plain_text", text: "Close" },
    blocks: [
      ...(facts.length ? [{ type: "section", fields: facts.slice(0, 10) }] : [{ type: "section", text: { type: "mrkdwn", text: "No receipt for this run yet." } }]),
      ...(steps.length ? [{ type: "divider" }, { type: "section", text: { type: "mrkdwn", text: `*Steps*\n${steps.slice(0, 30).join("\n")}`.slice(0, 2900) } }] : []),
      ...(r?.links?.session ? [{ type: "divider" }, { type: "section", text: { type: "mrkdwn", text: `<${r.links.session}|Open full trace>` } }] : []),
    ],
  };
}
