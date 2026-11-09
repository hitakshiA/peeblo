// The approval card (SLACK_UX_SPEC §5.2, K15), drawn by code, never by the model, shaped like the landing page:
// the service's icon, "Okay to write to Linear?", one quiet line ("Writes 1 comment · GRO-323 · ≈ $0.0002"), and
// Approve / Not now. "Not now" opens a small form: a reason (optional), or approve with edits, or for the whole job.
import { approverNames } from "../approvers.ts";
import { money, serviceIcon, serviceName } from "./look.ts";

const DOMAINS: Record<string, string> = { linear: "linear.app", github: "github.com", posthog: "posthog.com", stripe: "stripe.com", hubspot: "hubspot.com", notion: "notion.so", sheets: "google.com", intercom: "intercom.com", freshdesk: "freshdesk.com", supabase: "supabase.com", airtable: "airtable.com" };
const human = (k: string) => k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
const verb = (tool: string) => tool.replace(/^[a-z]+__/, "").replace(/_/g, " ");

// "Okay to save comment in Linear?"
export function question(a: any, teammate: string): string {
  if (a.kind === "hire") return `Okay to hire ${String(a.summary ?? "").replace(/^Hire /, "").split(":")[0] || "this teammate"}?`;
  if (a.kind === "recipe_change") return `Okay to change ${teammate}'s computer setup?`;
  if (a.kind === "company_memory") return "Okay to save this company note?";
  if (a.kind === "teammate_change") return `Okay to change ${a.target_name ?? "this teammate"}'s setup?`;
  if (a.kind === "plan") return `${String(a.title ?? "This plan").replace(/[.?]$/, "")}?`;
  if (a.risk === "money") {
    const p = a.arguments?.parameters ?? a.arguments ?? {};
    const amount = Number(p.amount);
    const cur = String(p.currency ?? "usd").toUpperCase();
    return Number.isFinite(amount) && amount > 0 ? `${/refund/i.test(String(a.arguments?.stripe_api_operation_id ?? a.tool)) ? "Refund" : "Move"} ${cur === "USD" ? "$" : `${cur} `}${(amount / 100).toFixed(2)}?` : `Okay to move money in ${serviceName(a.server ?? "stripe")}?`;
  }
  if (a.server) return a.risk === "read" ? `Okay to look this up in ${serviceName(a.server)}?` : `Okay to write to ${serviceName(a.server)}?`;
  if (a.tool && a.summary && a.kind === "peeblo_tool") return `${String(a.summary).split("\n")[0].replace(/[.?]$/, "")}?`;
  if (a.tool) return `Okay for ${teammate} to ${verb(a.tool)}?`;
  return `Okay for ${teammate} to go ahead?`;
}

// What it touches, by name: "GRO-323", "acme/web", "Renewal save plans".
function target(a: any): string | null {
  const x = a.arguments ?? {};
  const p = x.parameters ?? {};
  const v = x.identifier ?? x.issueId ?? x.issue_id ?? x.id ?? p.charge ?? p.customer ?? (x.owner && x.repo ? `${x.owner}/${x.repo}` : null) ?? x.title ?? x.name ?? x.spreadsheet_title ?? null;
  return typeof v === "string" || typeof v === "number" ? String(v).slice(0, 60) : null;
}

// The action in plain words: each argument on its own line, long text quoted, nested values flattened.
export function preview(a: any): string {
  if (a.summary && (!a.arguments || a.kind === "teammate_change")) return String(a.summary);
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

// "Writes 1 comment", "Moves money", "Removes 1 issue": the action in a few words, from the tool's name.
function what(a: any): string | null {
  if (a.kind === "teammate_change") return String(a.summary ?? "").split("\n")[0] || "Changes a teammate's setup";
  if (a.kind === "plan") return `${(a.steps ?? []).length} steps, one approval`;
  if (a.risk === "money") return "Moves money";
  if (a.risk === "outside_thread") return "Posts outside this thread";
  if (a.risk === "shipping") return "Ships a change";
  const tool = String(a.tool ?? "").replace(/^[a-z]+__/, "");
  const m = /^(save|create|add|update|edit|post|send|write|set|delete|remove|archive|close)_(.+)$/.exec(tool);
  // No write verb in the name: say what the tool is, never a bare "writes".
  if (!m) {
    if (!tool) return a.risk ? RISK[a.risk] ?? null : null;
    // In words: "Reads Sentry projects", "Runs the planner in monday.com"; the service's own name isn't repeated.
    const words = tool.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().split(/[_\-\s.]+/).filter((w) => w && w !== String(a.server ?? "").toLowerCase());
    const svc = a.server ? serviceName(a.server) : "";
    const VERBS: Record<string, string> = { get: "Reads", list: "Lists", search: "Searches", run: "Runs", invoke: "Runs", submit: "Submits", generate: "Generates", execute: "Runs", send: "Sends", trigger: "Triggers", manage: "Changes" };
    const v = VERBS[words[0]];
    const rest = (v ? words.slice(1) : words).join(" ");
    return v ? `${v} ${rest}${svc ? ` in ${svc}` : ""}` : `Uses ${svc ? `${svc} ` : ""}${rest}`;
  }
  const noun = m[2].replace(/_/g, " ").replace(/s$/, "");
  const verb = /delete|remove|archive/.test(m[1]) ? "Removes" : /update|edit|set|close/.test(m[1]) ? "Changes" : "Writes";
  return `${verb} 1 ${noun}`;
}

const RISK: Record<string, string> = { money: "moves money", destructive: "removes something", shipping: "ships a change", outside_thread: "posts outside this thread", write: "writes" };

const cutWord = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).replace(/\s+\S*$/, "")}…`);

export async function cardBlocks(a: any, id: string, teammate: string, askedBy?: string | null): Promise<any[]> {
  const domain = a.server ? DOMAINS[a.server] ?? `${a.server}.com` : null;
  const approvers: string[] = a.approvers ?? [];
  // "Only Priya can answer" only when the person asking isn't the one who decides.
  const onlyOthers = approvers.length && (!askedBy || !approvers.includes(askedBy)) ? `only ${await approverNames(approvers, true)} can answer` : null;
  const line = [what(a), target(a), a.price_usd ? `≈ ${money(Number(a.price_usd))}` : null, onlyOthers].filter(Boolean).join(" · ");
  return [
    ...(a.id_card_url ? [{ type: "image", image_url: a.id_card_url, alt_text: `${String(a.summary ?? "teammate").replace(/^Hire /, "").split(":")[0]}'s ID card`.slice(0, 2000) }] : []),
    { type: "card", block_id: `approval:${id}`,
      ...(domain ? { icon: { type: "image", image_url: serviceIcon(a.server) ?? `https://www.google.com/s2/favicons?domain=${domain}&sz=64`, alt_text: serviceName(a.server) } } : {}),
      title: { type: "plain_text", text: question(a, teammate).slice(0, 150) },
      // A hire reads like its ID card: the role, then what it can use, its budget and how it asks.
      ...(a.kind === "hire" && a.hire ? { subtitle: { type: "plain_text", text: cutWord(String(a.hire.role), 150) }, body: { type: "mrkdwn", text: cutWord(`Can use ${a.hire.uses} · ${a.hire.budget} · ${a.hire.asks}`, 200) } }
        : line ? { subtitle: { type: "plain_text", text: line.slice(0, 150) } } : {}),
      ...(a.kind === "plan" ? { body: { type: "mrkdwn", text: String(a.summary ?? "").slice(0, 600) } }
        : a.kind === "company_memory" ? { body: { type: "mrkdwn", text: preview(a).slice(0, 200) } }
        : a.kind !== "hire" && typeof a.rule === "string" && a.rule ? { body: { type: "mrkdwn", text: cutWord(a.rule.replace(/^The reviewer wants a person to decide: /, "Why I'm asking: "), 200) } } : {}),
      // A card takes only buttons (an overflow menu is refused), so Edit is a plain third button.
      actions: [
        { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" }, action_id: "approve_once", value: id },
        { type: "button", text: { type: "plain_text", text: "Not now" }, action_id: "not_now", value: id },
        ...(a.arguments && typeof a.arguments === "object" && Object.keys(a.arguments).length && a.kind !== "hire" ? [{ type: "button", text: { type: "plain_text", text: "Edit" }, action_id: "edit_approval", value: id }] : []),
      ] },
  ];
}

// "Not now" is a no: it only asks why (optional, one line). Send passes the reason to the agent; Skip says no
// without one (the modal tells Peeblo when it's closed).
export function notNowModal(a: any, id: string, teammate: string): any {
  return {
    type: "modal", callback_id: "not_now", private_metadata: id, notify_on_close: true,
    title: { type: "plain_text", text: "Not now" }, submit: { type: "plain_text", text: "Send" }, close: { type: "plain_text", text: "Skip" },
    blocks: [
      { type: "context", elements: [{ type: "mrkdwn", text: question(a, teammate).slice(0, 300) }] },
      { type: "input", block_id: "reason", optional: true, label: { type: "plain_text", text: `Tell ${teammate} why` }, element: { type: "plain_text_input", action_id: "v", max_length: 300, placeholder: { type: "plain_text", text: "e.g. wait until Maya has seen it" } } },
    ],
  };
}

// "Always allow comments in Linear?": offered once, after an owner approves a call a grant can cover.
export function alwaysPhrase(a: any): string | null {
  if (a.per_action || !a.grant_fp || !a.server) return null;
  const tool = String(a.tool ?? "").replace(/^[a-z]+__/, "");
  const m = /^(?:save|create|add|update|edit|post|send|write|set)_(.+)$/.exec(tool);
  const noun = m ? m[1].replace(/_/g, " ").replace(/y$/, "ie").replace(/s?$/, "s") : "this";
  return `Always allow ${noun === "this" ? "this" : noun} in ${serviceName(a.server)}?`;
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
