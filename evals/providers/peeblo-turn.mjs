// A Promptfoo provider that runs one real teammate turn: Peeblo's API → a durable run → Pi → Peeblo's proxy →
// hosted Otari. Each test is a fresh session. Approvals the run asks for are declined, so evals never write.
// The output is JSON: { answer, tools: [{tool, status}], models: [...] } for trace assertions.
// Needs core running (./peeblo up) and PEEBLO_ADMIN_TOKEN in the environment.
const API = process.env.PEEBLO_API_URL ?? "http://127.0.0.1:7340";
const H = () => ({ authorization: `Bearer ${process.env.PEEBLO_ADMIN_TOKEN}`, "content-type": "application/json" });
const PEOPLE = {
  owner: { slack_team: "T0CFKBN3YPM", slack_user: "U0CGL01BU72", display_name: "Hitakshi" },
  maya: { slack_team: "T0CFKBN3YPM", slack_user: "U0CFKNZLLSF", display_name: "Maya Okafor" },
};

async function api(method, path, body) {
  const r = await fetch(API + path, { method, headers: H(), body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${JSON.stringify(j)}`);
  return j;
}

export default class PeebloTurn {
  constructor(options) { this.config = options?.config ?? {}; this.providerId = options?.id ?? `peeblo-turn:${this.config.teammate}`; }
  id() { return this.providerId; }

  async callApi(prompt, context) {
    const vars = context?.vars ?? {};
    const teammate = vars.teammate ?? this.config.teammate;
    const person = PEOPLE[vars.person ?? "owner"];
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    // A session per test; config.kind and config.place make it e.g. a channel session in Slack (speaking cases).
    // A test may set its own kind and place (vars.kind, vars.place) over the provider's.
    const placeCfg = vars.place ?? this.config.place;
    const place = placeCfg ? JSON.parse(JSON.stringify(placeCfg).replaceAll("{stamp}", stamp)) : {};
    const session = await api("POST", `/v1/teammates/${teammate}/sessions`, { kind: vars.kind ?? this.config.kind ?? "thread", place_key: `C0EVAL:${stamp}`, place });
    const sub = await api("POST", `/v1/sessions/${session.id}/submissions`, { text: prompt, request_id: `eval-${stamp}`, person });
    const until = Date.now() + 300_000;
    const answered = new Set();
    for (;;) {
      const j = await api("GET", `/v1/runs/${sub.run_id}`);
      for (const e of j.events.filter((x) => x.type === "approval.requested")) {
        if (answered.has(e.data.approval_id)) continue;
        answered.add(e.data.approval_id);
        // Declined by the person the card names (every card has approvers; anyone else is refused).
        await api("POST", `/v1/approvals/${e.data.approval_id}`, { decision: "denied", scope: "once", person_id: e.data.action?.approvers?.[0] ?? null }).catch(() => {});
      }
      if (["done", "failed", "cancelled"].includes(j.run.status)) {
        const tools = j.events.filter((x) => x.type === "tool.call").map((x) => ({ tool: x.data.tool, status: x.data.status, ...(x.data.skill ? { skill: x.data.skill } : {}) }));
        const calls = j.events.filter((x) => x.type === "model.call" && x.data.role !== "guard");
        const answer = j.events.filter((x) => x.type === "turn.finished").map((x) => x.data.text).pop() ?? "";
        const cost = calls.reduce((a, c) => a + (Number(c.data.cost_usd) || 0), 0);
        return {
          output: JSON.stringify({ answer, tools, status: j.run.status, error: j.run.error ?? null, models: [...new Set(calls.map((c) => c.data.served_model).filter(Boolean))] }),
          cost,
          metadata: { run_id: sub.run_id, session_id: session.id },
        };
      }
      if (Date.now() > until) return { error: `run ${sub.run_id} did not finish in 5 minutes` };
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
