// Peeblo's Pi extension: the teammate's tools. It runs inside Pi, so it imports nothing from core and holds
// no secret: it asks core's loopback proxy (with the per-session token Pi already has) which tools exist,
// and sends every call back to it. Core decides, asks for approval, and has Otari run it.
// The list is fixed for the session (K7a). Peeblo's own tools and a teammate's most-used connector tools
// are declared up front; the other connector tools are registered but inactive until find_tools turns
// them on (K7b), so a session starts with few tools.
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

  for (const t of listed) {
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
        const out = (await r.json().catch(() => ({ text: `Peeblo answered ${r.status}`, isError: true }))) as { text: string; isError?: boolean };
        return { content: [{ type: "text", text: out.text }], details: {}, isError: Boolean(out.isError) };
      },
    });
  }

  const deferred = listed.filter((t) => !t.direct);
  if (!deferred.length) return;
  const servers = [...new Set(deferred.map((t) => t.name.split("__")[0]))];
  pi.registerTool({
    name: "find_tools",
    label: "Find tools",
    description: `Find and turn on more connector tools (${servers.join(", ")}: ${deferred.length} more). Describe the action you need, e.g. "create a Linear issue" or "add a comment"; the matching tools become usable on your next step.`,
    parameters: { type: "object", properties: { query: { type: "string", description: "The action you need." } }, required: ["query"], additionalProperties: false } as any,
    async execute(_id, params: any) {
      const terms = String(params?.query ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
      const active = new Set(pi.getActiveTools());
      const ranked = deferred.filter((t) => !active.has(t.name))
        .map((t) => ({ t, score: terms.reduce((s, w) => s + (t.name.toLowerCase().includes(w) ? 2 : 0) + (t.description.toLowerCase().includes(w) ? 1 : 0), 0) }))
        .filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 5).map((x) => x.t);
      if (!ranked.length) return { content: [{ type: "text", text: `No more tools match "${params?.query}". Try other words, or tell the person you can't do it.` }], details: {} };
      pi.setActiveTools([...active, ...ranked.map((t) => t.name)]);
      return { content: [{ type: "text", text: `Turned on: ${ranked.map((t) => `${t.name} (${t.description.slice(0, 80)})`).join("; ")}.` }], details: {} };
    },
  });
}
