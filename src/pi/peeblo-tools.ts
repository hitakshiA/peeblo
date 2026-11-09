// Peeblo's Pi extension: the teammate's tools. It runs inside Pi, so it imports nothing from core and holds
// no secret: it asks core's loopback proxy (with the per-session token Pi already has) which tools exist,
// and sends every call back to it. Core decides, asks for approval, and has Otari run it.
// A session starts with the small start set. Every other tool (Peeblo's own and every
// connector's, ~1,200 for Peeblo) is registered only when find_tools picks it (K7b): registering them all at start
// cost ~25 s per session.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Listed = { name: string; description: string; input_schema: Record<string, unknown>; asks: boolean; direct: boolean };

export default async function peebloTools(pi: ExtensionAPI): Promise<void> {
  const base = process.env.PEEBLO_TOOLS_URL;
  const token = process.env.OTARI_API_KEY;
  if (!base || !token) return;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  let listed: Listed[] = [];
  try {
    const r = await fetch(`${base}/tools`, { headers, signal: AbortSignal.timeout(30_000) });
    if (r.ok) listed = ((await r.json()) as { tools: Listed[] }).tools ?? [];
  } catch {
    // Pi starts without them; core's turn notes say so.
  }

  const register = (t: Listed) => {
    pi.registerTool({
      name: t.name,
      label: t.name.replace("__", " · "),
      description: t.asks ? `${t.description}\n(Runs only after a person approves it.)` : t.description,
      parameters: t.input_schema as any,
      defaultActive: t.direct,
      async execute(toolCallId, params, signal) {
        const r = await fetch(`${base}/tools/call`, {
          method: "POST", headers, signal,
          body: JSON.stringify({ name: t.name, arguments: params ?? {}, tool_call_id: toolCallId }),
        });
        const out = (await r.json().catch(() => ({ text: `Peeblo answered ${r.status}`, isError: true }))) as { text: string; isError?: boolean; terminate?: boolean };
        // A posted reply or a hand-off ends the turn: Pi stops after this batch instead of asking the model again.
        return { content: [{ type: "text", text: out.text }], details: {}, isError: Boolean(out.isError), ...(out.terminate ? { terminate: true } : {}) };
      },
    });
  };
  for (const t of listed) if (t.direct) register(t);
  const registered = new Set(listed.filter((t) => t.direct).map((t) => t.name));

  const deferred = listed.filter((t) => !t.direct);
  if (!deferred.length) return;
  const servers = [...new Set(deferred.filter((t) => t.name.includes("__")).map((t) => t.name.split("__")[0]))];
  const own = deferred.filter((t) => !t.name.includes("__")).map((t) => t.name);
  pi.registerTool({
    name: "find_tools",
    label: "Find tools",
    description: `Find and turn on more tools: ${servers.length ? `connector tools (${servers.join(", ")})` : ""}${servers.length && own.length ? ", and " : ""}${own.length ? `Peeblo's ${own.join(", ")}` : ""} (${deferred.length} in all). Describe the action you need, e.g. "create a Linear issue", "watch for changes", "run this when GitHub sends an event"; the matching tools become usable on your next step.`,
    parameters: { type: "object", properties: { query: { type: "string", description: "The action you need." } }, required: ["query"], additionalProperties: false } as any,
    async execute(_id, params: any) {
      const terms = String(params?.query ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
      const active = new Set(pi.getActiveTools());
      const ranked = deferred.filter((t) => !active.has(t.name))
        .map((t) => ({ t, score: terms.reduce((s, w) => s + (t.name.toLowerCase().includes(w) ? 2 : 0) + (t.description.toLowerCase().includes(w) ? 1 : 0), 0) }))
        .filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 5).map((x) => x.t);
      if (!ranked.length) return { content: [{ type: "text", text: `No more tools match "${params?.query}". Try other words, or tell the person you can't do it.` }], details: {} };
      for (const t of ranked) if (!registered.has(t.name)) { register(t); registered.add(t.name); }
      pi.setActiveTools([...new Set([...pi.getActiveTools(), ...ranked.map((t) => t.name)])]);
      return { content: [{ type: "text", text: `Turned on: ${ranked.map((t) => `${t.name} (${t.description.slice(0, 80)})`).join("; ")}.` }], details: {} };
    },
  });
}
