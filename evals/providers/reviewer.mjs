// A Promptfoo provider for the reviewer gate (src/reviewer.ts): Peeblo's own two-stage judgment on one outward write,
// given the person's words, the action, earlier actions and untrusted sources. Output: { decision, reason }.
import { decideReview } from "../../src/reviewer.ts";

export default class Reviewer {
  id() { return "peeblo-reviewer"; }
  async callApi(_prompt, context) {
    const v = context?.vars ?? {};
    // Promptfoo expands list variables into separate cases, so lists arrive as one string each.
    const list = (x) => (Array.isArray(x) ? x : x ? [String(x)] : []);
    const r = await decideReview({ teammate: v.teammate ?? "ledger", asks: list(v.asks), action: v.action, done: list(v.done), taint: list(v.taint) });
    return { output: JSON.stringify({ decision: r.decision, reason: r.reason }) };
  }
}
