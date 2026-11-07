// Shared by the agent-tool checks: a test teammate on a cheap model, and one real turn from a person.
import { ensureTeammate, OWNER, settle, submit, tools } from "./api.ts";

export const stamp = Date.now().toString(36);
export const BASE = {
  name: "Wren", role: "Growth analyst for the acme team",
  model: { default: "deepseek/deepseek-v4.1-flash-1017", fallback: "minimax/minimax-m3.1-flash" },
  budget: { monthly_usd: 3 }, tools: ["web", "code"], web: { allowed_domains: ["github.com", "httpbin.org"] },
  connectors: ["linear"], mode: "auto",
};

export async function teammate(slug: string, extra: Record<string, unknown> = {}): Promise<string> {
  await ensureTeammate(slug, { ...BASE, ...extra });
  return slug;
}

// One turn from a person; approvals the run asks for are answered with `answer` (or left to expire).
export async function turn(slug: string, key: string, text: string, opts: { person?: typeof OWNER; answer?: "approved" | "denied"; place?: string } = {}) {
  const r = await submit(slug, opts.place ?? `C0CHECK:${key}-${stamp}`, text, `${key}-${stamp}-${Math.random().toString(36).slice(2, 6)}`, opts.person ?? OWNER);
  const s = await settle(r.runId, { answer: opts.answer, timeoutMs: 400_000 });
  return { ...r, ...s, tools: tools(s.events) };
}

export const used = (t: any[], name: string): any[] => t.filter((x) => x.tool === name);
