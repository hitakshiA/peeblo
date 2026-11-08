// Trace assertion for tool choice: the run finished, and the tools that ran match the case.
//   expect_tool: a pattern one tool that ran must match;  expect_none: no tool besides speaking (slack_post and
//   slack_react are how a teammate replies, K2);
//   forbid: no tool matching it may be called;  forbid_completed: none matching it may complete;
//   expect_model: a model that served the run (e.g. the vision model behind look) must match.
export default function (output, context) {
  const o = JSON.parse(output);
  const v = context.vars;
  if (o.status !== "done") return { pass: false, score: 0, reason: `the run ended ${o.status}: ${o.error}` };
  const used = o.tools.map((t) => t.tool);
  const work = used.filter((t) => !/^slack_(post|react)$/.test(t));
  const ran = used.join(", ") || "no tool";
  if (v.forbid && used.some((t) => new RegExp(v.forbid).test(t))) return { pass: false, score: 0, reason: `called a forbidden tool (${ran})` };
  if (v.forbid_completed && o.tools.some((t) => new RegExp(v.forbid_completed).test(t.tool) && t.status === "completed")) return { pass: false, score: 0, reason: `a forbidden tool completed (${ran})` };
  if (v.expect_model && !(o.models ?? []).some((m) => new RegExp(v.expect_model, "i").test(m))) return { pass: false, score: 0, reason: `expected a ${v.expect_model} call, models: ${(o.models ?? []).join(", ")} (${ran})` };
  // expect_skill: read_skill must have opened this skill (K4: the skill reaches the model).
  if (v.expect_skill) {
    const read = o.tools.filter((t) => t.tool === "read_skill").map((t) => t.skill);
    const ok = read.includes(v.expect_skill);
    return { pass: ok, score: ok ? 1 : 0, reason: ok ? `read ${read.join(", ")}` : `expected the ${v.expect_skill} skill, read ${read.join(", ") || "none"} (${ran})` };
  }
  if (v.expect_none) return work.length ? { pass: false, score: 0, reason: `expected no tool, used ${ran}` } : { pass: true, score: 1, reason: work.length === used.length ? "no tool" : `only spoke (${ran})` };
  if (v.expect_tool) {
    const ok = used.some((t) => new RegExp(v.expect_tool).test(t));
    return { pass: ok, score: ok ? 1 : 0, reason: ok ? `used ${ran}` : `expected ${v.expect_tool}, used ${ran}` };
  }
  return { pass: true, score: 1, reason: `used ${ran}` };
}
