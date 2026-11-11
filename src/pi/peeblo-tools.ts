// Peeblo's Pi extension: the teammate's tools. It runs inside Pi, so it imports nothing from core and holds
// no secret: it asks core's loopback proxy (with the per-session token Pi already has) which tools exist,
// and sends every call back to it. Core decides, asks for approval, and has Otari run it.
// A session starts with the small start set plus find_tools and use_tool. Every other tool (Peeblo's own and every
// connector's, ~1,200 for Peeblo) is found with find_tools and called through use_tool, so the declared tool list
// stays the same for the whole session (registering them all at start cost ~25 s per session).
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

  const call = async (name: string, params: unknown, toolCallId: string, signal?: AbortSignal) => {
    const r = await fetch(`${base}/tools/call`, {
      method: "POST", headers, signal,
      body: JSON.stringify({ name, arguments: params ?? {}, tool_call_id: toolCallId }),
    });
    const out = (await r.json().catch(() => ({ text: `Peeblo answered ${r.status}`, isError: true }))) as { text: string; isError?: boolean; terminate?: boolean };
    // A posted reply or a hand-off ends the turn: Pi stops after this batch instead of asking the model again.
    return { content: [{ type: "text" as const, text: out.text }], details: {}, isError: Boolean(out.isError), ...(out.terminate ? { terminate: true } : {}) };
  };
  for (const t of listed) {
    if (!t.direct) continue;
    pi.registerTool({
      name: t.name,
      label: t.name.replace("__", " · "),
      description: t.asks ? `${t.description}\n(Runs only after a person approves it.)` : t.description,
      parameters: t.input_schema as any,
      async execute(toolCallId, params, signal) { return call(t.name, params, toolCallId, signal); },
    });
  }

  const deferred = listed.filter((t) => !t.direct);
  if (!deferred.length) return;
  const servers = [...new Set(deferred.filter((t) => t.name.includes("__")).map((t) => t.name.split("__")[0]))];
  const own = deferred.filter((t) => !t.name.includes("__")).map((t) => t.name);
  const byName = new Map(deferred.map((t) => [t.name, t]));
  const index = bm25Index(deferred.map((t) => `${t.name.replace(/__|_/g, " ")} ${t.name.replace(/__|_/g, " ")} ${t.description}`));
  // The tool list the model sees never changes during a session: a change makes the provider re-read the whole
  // conversation without its prompt cache. find_tools returns what matches (name, purpose, arguments) and use_tool
  // calls it; core checks the arguments against the same schema and gates the call exactly as a direct tool.
  pi.registerTool({
    name: "find_tools",
    label: "Find tools",
    description: `Find more tools: ${servers.length ? `connector tools (${servers.join(", ")})` : ""}${servers.length && own.length ? ", and " : ""}${own.length ? `Peeblo's ${own.join(", ")}` : ""} (${deferred.length} in all). Describe the action you need, e.g. "create a Linear issue", "watch for changes", "run this when GitHub sends an event". It returns the matching tools with their arguments; call one with use_tool.`,
    parameters: { type: "object", properties: { query: { type: "string", description: "The action you need." } }, required: ["query"], additionalProperties: false } as any,
    async execute(_id, params: any) {
      const ranked = index.search(String(params?.query ?? ""), 6).map((i) => deferred[i]);
      if (!ranked.length) return { content: [{ type: "text", text: `No tools match "${params?.query}". Try other words, or tell the person you can't do it.` }], details: {} };
      const lines = ranked.map((t) => `- ${t.name}: ${t.description.slice(0, 400)}${t.asks ? " (runs only after a person approves it)" : ""}\n  arguments: ${JSON.stringify(t.input_schema)}`);
      return { content: [{ type: "text", text: `Call one with use_tool, giving its name and arguments:\n${lines.join("\n")}` }], details: {} };
    },
  });
  pi.registerTool({
    name: "use_tool",
    label: "Use tool",
    description: "Call a tool that find_tools returned: its exact name, and arguments that match its schema.",
    parameters: { type: "object", properties: { name: { type: "string", description: "The tool's exact name, as find_tools gave it." }, arguments: { type: "object", description: "The tool's arguments.", additionalProperties: true } }, required: ["name", "arguments"], additionalProperties: false } as any,
    async execute(toolCallId, params: any, signal) {
      const name = String(params?.name ?? "");
      if (!byName.has(name)) return { content: [{ type: "text", text: `There is no tool called ${name}. Use find_tools to look it up.` }], details: {}, isError: true };
      return call(name, params?.arguments ?? {}, toolCallId, signal);
    },
  });
}

// BM25 over each tool's name and description (names count twice): "make a ticket" finds linear__create_issue.
export function bm25Index(docs: string[]): { search: (q: string, k: number) => number[] } {
  const tok = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  const terms = docs.map(tok);
  const df = new Map<string, number>();
  for (const t of terms) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
  const avg = terms.reduce((s, t) => s + t.length, 0) / Math.max(1, terms.length);
  const N = docs.length, k1 = 1.2, b = 0.75;
  return {
    search(q, k) {
      const qs = [...new Set(tok(q))];
      return terms.map((t, i) => {
        let score = 0;
        for (const w of qs) {
          const f = t.filter((x) => x === w || (w.length > 3 && x.startsWith(w.slice(0, -1)))).length;
          if (!f) continue;
          const idf = Math.log(1 + (N - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5));
          score += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * t.length / avg));
        }
        return { i, score };
      }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, k).map((x) => x.i);
    },
  };
}
