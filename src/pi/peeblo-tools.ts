// Peeblo's Pi extension: the teammate's connector tools. It runs inside Pi, so it imports nothing from
// core and holds no secret: it asks core's loopback proxy (with the per-session token Pi already has) which
// tools exist, and sends every call back to it. Core decides, asks for approval, and has Otari run it.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Listed = { name: string; description: string; input_schema: Record<string, unknown>; asks: boolean };

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
    // Core will say in the system prompt that connectors could not be listed; Pi starts without them.
  }

  for (const t of listed) {
    pi.registerTool({
      name: t.name,
      label: t.name.replace("__", " · "),
      description: t.asks ? `${t.description}\n(Runs only after a person approves it.)` : t.description,
      parameters: t.input_schema as any,
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
}
