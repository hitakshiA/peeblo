// Who may answer an approval (rail): every card names its approvers, and anyone else's click is refused.
// - Otari settings and company memory: the admins.
// - Raising a teammate's capability: its owner or an admin.
// - Unattended work (a schedule or trigger, or a teammate it called): the teammate's owner (silence means no).
// - Everything else: the person who asked, else the owner.
// An approval with no one able to answer it falls back to the admins, never to "anyone".
import { config } from "./config.ts";
import { pool } from "./db.ts";

const UNATTENDED = new Set(["schedule", "webhook"]);

export async function adminIds(): Promise<string[]> {
  if (!config.admins.length) return [];
  const { rows } = await pool.query("SELECT id FROM people WHERE slack_user = ANY($1)", [config.admins]);
  return rows.map((r) => r.id);
}

// The run a chain started from, and how it started (a person, or a schedule or trigger).
export async function runOrigin(runId: string): Promise<{ source: string | null; personId: string | null; teammateId: string | null; ownerId: string | null }> {
  const { rows: c } = await pool.query("SELECT data->>'root' AS root FROM events WHERE type = 'chain.call' AND data->>'child_run' = $1 LIMIT 1", [runId]);
  const root = c[0]?.root ?? runId;
  const q = `SELECT sub.source, sub.person_id, s.teammate_id, t.owner_person FROM runs r JOIN submissions sub ON sub.id = r.submission_id
              JOIN sessions s ON s.id = r.session_id JOIN teammates t ON t.id = s.teammate_id WHERE r.id = $1`;
  const rootRow = (await pool.query(q, [root])).rows[0];
  const own = root === runId ? rootRow : (await pool.query(q, [runId])).rows[0];
  return { source: rootRow?.source ?? null, personId: own?.person_id ?? null, teammateId: own?.teammate_id ?? null, ownerId: own?.owner_person ?? null };
}
export const isUnattended = async (runId: string) => UNATTENDED.has((await runOrigin(runId)).source ?? "");

export async function defaultApprovers(runId: string, action: Record<string, any>): Promise<string[]> {
  const admins = await adminIds();
  const o = await runOrigin(runId);
  const tool = String(action.tool ?? action.setting ?? "");
  if (tool.startsWith("otari_set") || action.kind === "company_memory") return admins;
  if (tool === "teammate_update") {
    const name = String(action.arguments?.teammate ?? "");
    const t = (await pool.query("SELECT owner_person FROM teammates WHERE (slug = $1 OR id = $1) AND archived_at IS NULL", [name])).rows[0];
    return uniq([t?.owner_person, ...admins]);
  }
  if (UNATTENDED.has(o.source ?? "")) return o.ownerId ? [o.ownerId] : admins;
  return o.personId ? [o.personId] : o.ownerId ? [o.ownerId] : admins;
}

const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => Boolean(x)))];

// Fills in approvers where a tool didn't name them (or named no one who can answer).
export async function withApprovers(runId: string, action: Record<string, any>): Promise<Record<string, any>> {
  const named = uniq(Array.isArray(action.approvers) ? action.approvers : []);
  const approvers = named.length ? named : await defaultApprovers(runId, action);
  return { ...action, approvers: approvers.length ? approvers : await adminIds() };
}

export async function approverNames(ids: string[]): Promise<string> {
  if (!ids.length) return "an admin";
  const { rows } = await pool.query("SELECT id, display_name, slack_user FROM people WHERE id = ANY($1)", [ids]);
  const names = ids.map((id) => rows.find((r) => r.id === id)).filter(Boolean).map((r) => (r.slack_user ? `<@${r.slack_user}>` : r.display_name ?? "a person"));
  return names.length <= 2 ? names.join(" or ") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

// What people actually wrote for this job (the reviewer's only source of intent, K11): the person-written messages
// where the chain started. For a schedule or trigger, that is the creator's request when they set it up; the stored
// prompt and any payload were written by an agent or a service, so they come back separately and never count.
const PERSON_SOURCES = ["slack", "api"];
export async function personWords(runId: string): Promise<{ asks: string[]; agentWritten: string | null }> {
  const { rows: c } = await pool.query("SELECT data->>'root' AS root FROM events WHERE type = 'chain.call' AND data->>'child_run' = $1 LIMIT 1", [runId]);
  const root = c[0]?.root ?? runId;
  const r = (await pool.query("SELECT r.session_id, sub.source, sub.request_id FROM runs r JOIN submissions sub ON sub.id = r.submission_id WHERE r.id = $1", [root])).rows[0];
  if (!r) return { asks: [], agentWritten: null };
  if (UNATTENDED.has(r.source)) {
    const id = String(r.request_id).split(":")[1];
    const s = (await pool.query("SELECT prompt, origin_request FROM schedules WHERE id = $1", [id])).rows[0];
    return { asks: s?.origin_request ? [String(s.origin_request).slice(0, 1500)] : [], agentWritten: s?.prompt ? String(s.prompt).slice(0, 1500) : null };
  }
  const { rows } = await pool.query("SELECT text FROM submissions WHERE session_id = $1 AND source = ANY($2) AND person_id IS NOT NULL ORDER BY created_at DESC LIMIT 5", [r.session_id, PERSON_SOURCES]);
  return { asks: rows.map((x) => String(x.text).slice(0, 1500)).reverse(), agentWritten: null };
}

// The approvals map (rail): company memory's product/approvals.md says who must click for which write, before a
// reviewer's allow counts. Lines like "- money: Hitakshi", "- merges, flags, deploys: Jun", "- marketing sends: Maya",
// "- account Northwind Trading: Maya". A person who said "I'll approve" or "ask me first" in this job gets the card.
export async function policyApprovers(runId: string, call: { server?: string; tool?: string; risk?: string; arguments?: unknown }): Promise<{ who: string[]; why: string } | null> {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  let text = "";
  try { text = readFileSync(join(config.dataDir, "company-memory", "product", "approvals.md"), "utf8"); } catch { /* no map */ }
  const rules = [...text.matchAll(/^-\s*([^:\n]+):\s*(.+)$/gm)].map((m) => ({ key: m[1].trim().toLowerCase(), names: m[2].split(/,| or | and /).map((x) => x.trim()).filter(Boolean) }));
  const tool = String(call.tool ?? "").toLowerCase(), server = String(call.server ?? "").toLowerCase();
  const args = JSON.stringify(call.arguments ?? {}).toLowerCase();
  const ids = async (names: string[]) => uniq(await Promise.all(names.map(async (n) => (await pool.query(
    "SELECT id FROM people WHERE lower(display_name) = lower($1) OR lower(split_part(display_name, ' ', 1)) = lower($1) OR slack_user = $1 LIMIT 1", [n])).rows[0]?.id)));
  const pick = async (pred: (k: string) => boolean, why: string) => { const r = rules.find((x) => pred(x.key)); if (!r) return null; const who = await ids(r.names); return who.length ? { who, why } : null; };
  // The requester's own words in this job: "I'll approve", "ask me first", "check with me".
  const o = await runOrigin(runId);
  if (o.personId) {
    const said = (await pool.query(`SELECT sub.text FROM submissions sub JOIN runs r ON r.submission_id = sub.id WHERE r.session_id = (SELECT session_id FROM runs WHERE id = $1) AND sub.person_id = $2 ORDER BY sub.created_at DESC LIMIT 5`, [runId, o.personId])).rows.map((x) => String(x.text)).join("\n");
    if (/\b(i['’]?ll approve|i will approve|ask me (first|before)|check with me|let me approve|i approve it)\b/i.test(said)) return { who: [o.personId], why: "they said they'd approve it" };
  }
  if (call.risk === "money" || (server === "stripe" && /refund|credit|quote|coupon|discount|invoice/.test(tool + args))) { const r = await pick((k) => /money|credit|refund/.test(k), "money goes to its approver"); if (r) return r; }
  if (/merge|deploy/.test(tool) || ((server === "upstash" || server === "cloudflare") && !/^(get|list|read)/.test(tool))) { const r = await pick((k) => /merge|flag|deploy/.test(k), "merges, flags and deploys go to their approver"); if (r) return r; }
  if ((server === "resend" && /send|broadcast/.test(tool)) || (server === "sanity" && /publish/.test(tool))) { const r = await pick((k) => /marketing/.test(k), "marketing sends go to their approver"); if (r) return r; }
  if (server === "hubspot") {
    for (const r of rules.filter((x) => x.key.startsWith("account "))) {
      const acct = r.key.slice(8).trim();
      if (acct && args.includes(acct.split(" ")[0])) { const who = await ids(r.names); if (who.length) return { who, why: `${r.key.slice(8)} is their account` }; }
    }
  }
  return null;
}

