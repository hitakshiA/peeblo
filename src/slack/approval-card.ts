// The approval card, drawn by code, never by the model, shaped like the landing page:
// the service's icon, "Okay to write to Linear?", one quiet line ("Writes 1 comment · GRO-323 · ≈ $0.0002"), and
// Approve / Not now. "Not now" opens a small form: a reason (optional), or approve with edits, or for the whole job.
import { approverNames } from "../approvers.ts";
import { atlassianName, money, serviceIcon, serviceName } from "./look.ts";

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
    const raw = Number(p.amount);
    const amount = Math.abs(raw);
    const credit = raw < 0 || /balance|credit/i.test(String(a.arguments?.stripe_api_operation_id ?? ""));
    // No currency in the call (a credit note or refund follows its invoice or charge): no symbol is guessed.
    const cur = p.currency ? String(p.currency).toUpperCase() : null;
    const sym = cur ? ({ USD: "$", EUR: "€", GBP: "£" } as Record<string, string>)[cur] ?? `${cur} ` : "";
    // Stripe amounts are in the currency's smallest unit: cents, but whole yen or won (no decimals).
    const digits = minorDigits(cur);
    return Number.isFinite(amount) && amount > 0 ? `${/refund/i.test(String(a.arguments?.stripe_api_operation_id ?? a.tool)) ? "Refund" : credit ? "Credit" : "Move"} ${sym}${(amount / 10 ** digits).toFixed(digits)}${cur ? "" : " (its invoice's currency)"}?` : `Okay to move money in ${serviceName(a.server ?? "stripe")}?`;
  }
  const svc = a.server === "atlassian" ? atlassianName(String(a.tool ?? "")) : serviceName(a.server);
  if (a.server) return a.risk === "read" ? `Okay to look this up in ${svc}?` : `Okay to write to ${svc}?`;
  if (a.tool && a.summary && a.kind === "peeblo_tool") return `${String(a.summary).split("\n")[0].replace(/[.?]$/, "")}?`;
  // A routine names itself: "Set up “Monday numbers for Tom”?"; a computer command says what it does, not "computer bash".
  if (a.tool === "schedule" && a.arguments?.name) return `${a.arguments.action === "delete" ? "Remove" : a.arguments.action === "update" ? "Change" : "Set up"} “${String(a.arguments.name).slice(0, 80)}”?`;
  if (a.tool === "computer_bash" && /git push/.test(String(a.arguments?.command ?? ""))) return `Okay for ${teammate} to push code from its computer?`;
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
  // Peeblo's own tools: the title already says it in words; the reason, if any, is the line.
  if (a.kind === "peeblo_tool") return a.reason ? `Why: ${String(a.reason)}`.slice(0, 120) : null;
  if (a.kind === "recipe_change") {
    const p = a.diff?.packages ?? {};
    const added = ["apk", "npm", "pip"].map((k) => p[k]).filter((x) => x && x !== "none").join(", ");
    return `${added ? `Adds ${added}` : "Changes its setup"}${a.disk_mb ? ` · ${a.disk_mb} MB` : ""}${a.new_build_hosts?.length ? ` · new sites: ${a.new_build_hosts.join(", ")}` : ""}`;
  }
  if (a.kind === "teammate_change") return String(a.summary ?? "").split("\n")[0] || "Changes a teammate's setup";
  if (a.kind === "plan") return `${(a.steps ?? []).length} steps, one approval`;
  if (a.risk === "money") return "Moves money";
  if (a.risk === "outside_thread") return "Posts outside this thread";
  if (a.risk === "shipping") return "Ships a change";
  const tool = String(a.tool ?? "").replace(/^[a-z]+__/, "");
  // "<thing>_write" with a method (GitHub's issue_write {method: "create"}): "Creates 1 issue".
  const w = /^(.+)_write$/.exec(tool);
  if (w && a.arguments?.method) {
    const method = String(a.arguments.method).toLowerCase();
    const verb = /delete|remove/.test(method) ? "Removes" : /update|edit|close|lock|set/.test(method) ? "Changes" : /create|add/.test(method) ? "Creates" : "Writes";
    return `${verb} 1 ${w[1].replace(/_/g, " ")}`;
  }
  // A generic API tool names its operation: Stripe's stripe_api_write {stripe_api_operation_id: "PostCustomers"}.
  const op = String(a.arguments?.stripe_api_operation_id ?? a.arguments?.operation_id ?? "");
  const name = op || tool;
  if (!name) return a.risk ? RISK[a.risk] ?? null : null;
  // In words, from the tool's own name: the verb (wherever it sits in the first words), then what it acts on.
  // "retire_issue_label" → "Retires issue label"; "PostCustomers" → "Creates customers". The service isn't repeated.
  const words = name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().split(/[_\-\s.]+/).filter((x) => x && x !== String(a.server ?? "").toLowerCase() && x !== "api");
  const at = words.findIndex((x, n) => n < 3 && VERB[x]);
  if (at < 0) return `${words.join(" ").replace(/^./, (c) => c.toUpperCase())}`.slice(0, 80) || null;
  const rest = [...words.slice(0, at), ...words.slice(at + 1)].join(" ");
  return `${VERB[words[at]]}${rest ? ` ${rest}` : ""}`.slice(0, 80);
}

const VERB: Record<string, string> = {
  create: "Creates", add: "Adds", new: "Creates", post: "Creates", insert: "Adds", save: "Saves", write: "Writes", upsert: "Saves",
  update: "Changes", edit: "Changes", set: "Sets", patch: "Changes", put: "Changes", modify: "Changes", rename: "Renames", move: "Moves",
  delete: "Removes", remove: "Removes", archive: "Archives", retire: "Retires", restore: "Restores", unarchive: "Restores", cancel: "Cancels",
  close: "Closes", reopen: "Reopens", resolve: "Resolves", acknowledge: "Acknowledges", ack: "Acknowledges", snooze: "Snoozes", mute: "Mutes",
  share: "Shares", unshare: "Stops sharing", invite: "Invites", assign: "Assigns", unassign: "Unassigns", link: "Links", unlink: "Unlinks",
  tag: "Tags", untag: "Untags", label: "Labels", mark: "Marks", pin: "Pins", unpin: "Unpins", star: "Stars", subscribe: "Subscribes to", unsubscribe: "Unsubscribes from",
  send: "Sends", reply: "Replies to", comment: "Comments on", publish: "Publishes", unpublish: "Unpublishes", schedule: "Schedules",
  apply: "Applies", deploy: "Deploys", merge: "Merges", reset: "Resets", rebase: "Rebases", revert: "Reverts", release: "Releases", rollback: "Rolls back",
  run: "Runs", execute: "Runs", invoke: "Runs", trigger: "Triggers", start: "Starts", stop: "Stops", pause: "Pauses", resume: "Resumes",
  enable: "Turns on", disable: "Turns off", approve: "Approves", reject: "Rejects", submit: "Submits", import: "Imports", upload: "Uploads",
  prepare: "Prepares", generate: "Generates", duplicate: "Copies", copy: "Copies", clone: "Copies", refund: "Refunds", charge: "Charges", pay: "Pays",
  convert: "Converts", transfer: "Transfers", manage: "Changes", rotate: "Rotates", verify: "Verifies", sync: "Syncs", give: "Gives",
  connect: "Connects", disconnect: "Disconnects", exec: "Runs", provision: "Provisions", compose: "Writes", change: "Changes", call: "Calls",
  unpause: "Resumes", undeploy: "Undeploys", transition: "Moves", transform: "Transforms", test: "Tests", suspend: "Suspends", format: "Formats", install: "Installs", uninstall: "Uninstalls", grant: "Grants", revoke: "Revokes", get: "Reads", list: "Lists", search: "Searches", fetch: "Reads", read: "Reads", query: "Queries",
};
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
      { type: "input", block_id: "reason", optional: true, label: { type: "plain_text", text: `Tell ${teammate} why` }, element: { type: "plain_text_input", action_id: "v", max_length: 300, placeholder: { type: "plain_text", text: "e.g. wait until the owner has seen it" } } },
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
  // One field per value, in words: a nested object (Stripe's "parameters") opens up one level, and routing ids
  // (which API operation) stay fixed and hidden, since a person never edits those.
  const field = (key: string, label: string, v: unknown) => {
    const text = typeof v === "string" ? v : JSON.stringify(v);
    return { type: "input", block_id: `arg:${key}`, label: { type: "plain_text", text: label.slice(0, 2000) }, optional: true,
      element: { type: "plain_text_input", action_id: "v", initial_value: text.slice(0, 3000), multiline: text.length > 60 } };
  };
  const cents = a.server === "stripe" || /stripe/.test(String(a.tool ?? ""));
  const inputs = Object.entries(a.arguments ?? {}).filter(([k]) => !/operation_id$/.test(k)).flatMap(([k, v]) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.entries(v as Record<string, unknown>).map(([k2, v2]) => field(`${k}.${k2}`, `${human(k2)}${cents && k2 === "amount" ? (minorDigits(String((v as any).currency ?? "").toUpperCase() || null) ? " (in cents: 3700 is 37.00)" : " (in whole units: this currency has no cents)") : ""}`, v2))
      : [field(k, human(k), v)]).slice(0, 20);
  return {
    type: "modal", callback_id: "edit_approval", private_metadata: id,
    title: { type: "plain_text", text: "Edit, then approve" }, submit: { type: "plain_text", text: "Approve edited" }, close: { type: "plain_text", text: "Cancel" },
    blocks: [{ type: "section", text: { type: "mrkdwn", text: `*${question(a, teammate)}*\nChange what you need; ${teammate} runs exactly this.` } }, ...inputs],
  };
}

// Back from the form: the edited arguments, with numbers, booleans and JSON values restored to their types.
export function editedArgs(original: Record<string, unknown>, values: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...original };
  const typed = (before: unknown, raw: string): unknown => {
    if (typeof before === "number") return Number(raw);
    if (typeof before === "boolean") return raw === "true";
    if (before && typeof before === "object") { try { return JSON.parse(raw); } catch { return before; } }
    return raw;
  };
  for (const [blockId, v] of Object.entries(values)) {
    const k = blockId.replace(/^arg:/, "");
    const raw = v?.v?.value;
    if (raw == null) continue;
    const [top, sub] = k.split(".", 2);
    if (sub !== undefined) {
      const parent = { ...((out[top] as Record<string, unknown>) ?? {}) };
      parent[sub] = typed((original[top] as Record<string, unknown> | undefined)?.[sub], raw);
      out[top] = parent;
    } else out[k] = typed(original[k], raw);
  }
  return out;
}

// Decimal places of a currency's smallest unit (2 for USD, 0 for JPY), from the platform's currency data.
export function minorDigits(cur: string | null): number {
  if (!cur) return 2;
  try { return new Intl.NumberFormat("en", { style: "currency", currency: cur }).resolvedOptions().maximumFractionDigits ?? 2; } catch { return 2; }
}
