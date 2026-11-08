// The approval card (SLACK_UX_SPEC §3.4, K15): drawn by code, never by the model. The service's icon and
// "Okay to …?", a plain preview of the action (never raw JSON), one line with what it does, the price and who may
// answer, and Approve · Edit · Not now (with For this job / Always in a menu where a grant is allowed). Edit opens
// a form with the arguments; submitting it approves the edited call.
import { approverNames } from "../approvers.ts";

const DOMAINS: Record<string, string> = { linear: "linear.app", github: "github.com", posthog: "posthog.com", stripe: "stripe.com", hubspot: "hubspot.com", notion: "notion.so", sheets: "google.com", intercom: "intercom.com", freshdesk: "freshdesk.com", supabase: "supabase.com", airtable: "airtable.com" };
const human = (k: string) => k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
const verb = (tool: string) => tool.replace(/^[a-z]+__/, "").replace(/_/g, " ");

// "Okay to save comment in Linear?"
export function question(a: any, teammate: string): string {
  if (a.kind === "hire") return `Okay to hire ${a.summary?.split(" · ")[0] ?? "this teammate"}?`;
  if (a.kind === "recipe_change") return `Okay to change ${teammate}'s computer setup?`;
  if (a.kind === "company_memory") return "Okay to save this company memory?";
  if (a.server) return `Okay for ${teammate} to ${verb(a.tool)} in ${human(a.server)}?`;
  if (a.tool) return `Okay for ${teammate} to ${verb(a.tool)}?`;
  return `Okay for ${teammate} to go ahead?`;
}

// The action in plain words: each argument on its own line, long text quoted, nested values flattened.
export function preview(a: any): string {
  if (a.summary && !a.arguments) return String(a.summary);
  if (a.diff) return String(a.diff).slice(0, 2500);
  const args = a.arguments ?? {};
  const lines: string[] = [];
  const walk = (obj: any, prefix = "") => {
    for (const [k, v] of Object.entries(obj ?? {})) {
      if (v == null || v === "") continue;
      const label = prefix ? `${prefix} › ${human(k)}` : human(k);
      if (typeof v === "object" && !Array.isArray(v)) walk(v, label);
      else if (Array.isArray(v)) lines.push(`*${label}:* ${v.map((x) => (typeof x === "object" ? Object.values(x ?? {}).join(" ") : String(x))).join(", ").slice(0, 300)}`);
      else if (typeof v === "string" && v.length > 80) lines.push(`*${label}:*\n>${v.slice(0, 1200).replace(/\n/g, "\n>")}`);
      else lines.push(`*${label}:* ${String(v).slice(0, 200)}`);
    }
  };
  walk(args);
  return lines.slice(0, 12).join("\n") || (a.summary ? String(a.summary) : "No details.");
}

const RISK: Record<string, string> = { money: "moves money", destructive: "removes something", shipping: "ships a change", outside_thread: "posts outside this thread", write: "writes" };

export async function cardBlocks(a: any, id: string, teammate: string): Promise<any[]> {
  const domain = a.server ? DOMAINS[a.server] : null;
  const price = a.price_usd ? `≈$${Number(a.price_usd).toFixed(4)}` : null;
  const who = `only ${await approverNames(a.approvers ?? [])} can answer`;
  const facts = [a.risk ? RISK[a.risk] ?? a.risk : null, price, who, a.rule ? `why: ${String(a.rule).slice(0, 160)}` : null].filter(Boolean).join(" · ");
  const grantable = !(a.per_action || a.kind === "hire" || a.kind === "recipe_change" || a.kind === "company_memory" || String(a.tool ?? "").startsWith("otari_set"));
  const editable = a.arguments && typeof a.arguments === "object" && Object.keys(a.arguments).length > 0 && a.kind !== "hire";
  return [
    ...(a.id_card_url ? [{ type: "image", image_url: a.id_card_url, alt_text: `${a.summary ?? "teammate"} ID card`.slice(0, 2000) }] : []),
    { type: "section", text: { type: "mrkdwn", text: `*${question(a, teammate)}*` }, ...(domain ? { accessory: { type: "image", image_url: `https://www.google.com/s2/favicons?domain=${domain}&sz=64`, alt_text: a.server } } : {}) },
    ...(a.kind === "hire" ? [] : [{ type: "section", text: { type: "mrkdwn", text: preview(a).slice(0, 2900) } }]),
    { type: "context", elements: [{ type: "mrkdwn", text: facts.slice(0, 2900) }] },
    { type: "actions", block_id: `approval:${id}`, elements: [
      { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" }, action_id: "approve_once", value: id },
      ...(editable ? [{ type: "button", text: { type: "plain_text", text: "Edit" }, action_id: "edit_approval", value: id }] : []),
      { type: "button", text: { type: "plain_text", text: "Not now" }, action_id: "deny", value: id },
      ...(grantable ? [{ type: "overflow", action_id: "approve_more", options: [
        { text: { type: "plain_text", text: "Approve for this job" }, value: `job:${id}` },
        { text: { type: "plain_text", text: "Always approve this" }, value: `always:${id}` },
      ] }] : []),
    ] },
  ];
}

// The Edit form: one input per argument (top level; nested ones as JSON), prefilled.
export function editModal(a: any, id: string, teammate: string): any {
  const inputs = Object.entries(a.arguments ?? {}).slice(0, 20).map(([k, v]) => {
    const text = typeof v === "string" ? v : JSON.stringify(v);
    return { type: "input", block_id: `arg:${k}`, label: { type: "plain_text", text: human(k).slice(0, 2000) }, optional: true,
      element: { type: "plain_text_input", action_id: "v", initial_value: text.slice(0, 3000), multiline: text.length > 60 } };
  });
  return {
    type: "modal", callback_id: "edit_approval", private_metadata: id,
    title: { type: "plain_text", text: "Edit, then approve" }, submit: { type: "plain_text", text: "Approve edited" }, close: { type: "plain_text", text: "Cancel" },
    blocks: [{ type: "section", text: { type: "mrkdwn", text: `*${question(a, teammate)}*\nChange what you need; ${teammate} runs exactly this.` } }, ...inputs],
  };
}

// Back from the form: the edited arguments, with numbers, booleans and JSON values restored to their types.
export function editedArgs(original: Record<string, unknown>, values: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...original };
  for (const [blockId, v] of Object.entries(values)) {
    const k = blockId.replace(/^arg:/, "");
    const raw = v?.v?.value;
    if (raw == null) continue;
    const before = original[k];
    if (typeof before === "number") out[k] = Number(raw);
    else if (typeof before === "boolean") out[k] = raw === "true";
    else if (before && typeof before === "object") { try { out[k] = JSON.parse(raw); } catch { out[k] = before; } }
    else out[k] = raw;
  }
  return out;
}
