// Memory tools (K12). The teammate decides what is worth remembering; code decides where it may read and write
// (its conversation's place), versions every write, and marks writes from runs that read outside content as
// unverified. memory_grep first; memory_search (Otari embeddings + rerank over the notes) when grep isn't enough.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { pool } from "../db.ts";
import { deleteNote, notesIn, placeOfSession, readBanks, readNote, sha, writeCompany, writeNote, type Note } from "../memory/store.ts";
import { addToCard, openPromises, recallNotes } from "../memory/work.ts";
import { embed, cosine, fuse, recall } from "../otari/search.ts";
import { getSession } from "../store/sessions.ts";
import { isOtariAdmin } from "../authority.ts";
import { object } from "./schema.ts";
import type { AgentTool, ToolContext } from "./types.ts";

async function where(ctx: ToolContext) {
  const s = await getSession(ctx.sessionId);
  return placeOfSession(s ?? { kind: "api", place: {} });
}
// A run is tainted once it has read untrusted content (web pages, connector results, files, other bots).
async function tainted(runId: string | null): Promise<boolean> {
  if (!runId) return false;
  const { rows } = await pool.query("SELECT 1 FROM events WHERE run_id = $1 AND type = 'tool.call' AND data->>'untrusted' IS NOT NULL AND data->>'tool' NOT LIKE 'memory_%' LIMIT 1", [runId]);
  return Boolean(rows[0]);
}
const show = (n: Note) => `[${n.bank}] ${n.path}: ${n.title}${n.verified ? "" : " (unverified)"}`;

// Keyword (BM25-ish) ranking over notes; enough for a few thousand short notes.
function keywordRank(notes: Note[], q: string): number[] {
  const terms = q.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  const scored = notes.map((n, i) => {
    const text = `${n.title} ${n.body}`.toLowerCase();
    let s = 0;
    for (const t of terms) { const m = text.split(t).length - 1; if (m) s += (1 + Math.log(m)) * Math.log(1 + notes.length / (1 + notes.filter((x) => `${x.title} ${x.body}`.toLowerCase().includes(t)).length)); }
    return { i, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  return scored.map((x) => x.i);
}

// Note embeddings are cached by content hash (not versioned; rebuilt on demand).
async function vectors(slug: string, notes: Note[], endUser?: string): Promise<number[][]> {
  const file = join(config.dataDir, "teammates", slug, "memory-vectors.json");
  const cache: Record<string, number[]> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const keys = notes.map((n) => sha(`${n.title}\n${n.body}`));
  const missing = notes.map((n, i) => ({ n, k: keys[i] })).filter((x) => !cache[x.k]);
  for (let i = 0; i < missing.length; i += 32) {
    const batch = missing.slice(i, i + 32);
    const { vectors: v } = await embed(batch.map((x) => `${x.n.title}\n${x.n.body}`.slice(0, 4000)), "document", endUser);
    batch.forEach((x, j) => { cache[x.k] = v[j]; });
  }
  if (missing.length) { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, JSON.stringify(cache)); }
  return keys.map((k) => cache[k]);
}

export const memoryTools: AgentTool[] = [
  {
    name: "memory_write",
    description: "Remember something for later: a fact, a decision, a person's preference or a correction. Write or replace one note (a path like customers/acme-billing). It is kept for this conversation's place (this DM, this private channel, or the team).",
    input_schema: object({ path: { type: "string" }, title: { type: "string" }, body: { type: "string", description: "The note, in plain words. Say where it came from." } }),
    kind: "local",
    async run(ctx, a) {
      const place = await where(ctx);
      const t = await tainted(ctx.runId);
      const n = await writeNote(ctx.teammate.slug, place, { path: a.path, title: a.title, body: a.body, source: `${ctx.person?.display_name ?? "a conversation"}, ${new Date().toISOString().slice(0, 10)}`, runId: ctx.runId, tainted: t });
      return { text: `Saved ${show(n)}.${n.verified ? "" : " It's marked unverified because this conversation read outside content; it stays out of your index until your owner verifies it."}`, data: { bank: n.bank, path: n.path, verified: n.verified } };
    },
  },
  {
    name: "memory_read",
    description: "Read one memory note by its bank and path (from your index or a search).",
    input_schema: object({ bank: { type: "string" }, path: { type: "string" } }),
    kind: "read",
    async run(ctx, a) {
      const n = readNote(ctx.teammate.slug, await where(ctx), a.bank, a.path);
      return n ? { text: `${show(n)}\n${n.body}` } : { text: `No note ${a.bank}/${a.path} you can read here.`, isError: true };
    },
  },
  {
    name: "memory_grep",
    description: "Find memory notes containing a word or phrase (case-insensitive). Try this first.",
    input_schema: object({ pattern: { type: "string" } }),
    kind: "read",
    async run(ctx, a) {
      const place = await where(ctx);
      const p = String(a.pattern).toLowerCase();
      const hits = notesIn(ctx.teammate.slug, readBanks(place)).filter((n) => `${n.title}\n${n.body}`.toLowerCase().includes(p)).slice(0, 15);
      return { text: hits.length ? hits.map((n) => `${show(n)}\n  ${n.body.split("\n").find((l) => l.toLowerCase().includes(p))?.slice(0, 200) ?? ""}`).join("\n") : "No notes match." };
    },
  },
  {
    name: "memory_search",
    description: "Search memory by meaning when grep finds nothing: returns the best few notes for a question.",
    input_schema: object({ query: { type: "string" } }),
    kind: "read",
    async run(ctx, a) {
      const place = await where(ctx);
      return search(ctx, notesIn(ctx.teammate.slug, readBanks(place)), a.query);
    },
  },
];

// Keyword and meaning ranking over the notes, then Otari's reranker: the best five, with their text.
async function search(ctx: ToolContext, notes: Note[], query: string): Promise<{ text: string }> {
  if (!notes.length) return { text: "Memory is empty here." };
  const kw = keywordRank(notes, query);
  let vec: number[] = [];
  try {
    const vs = await vectors(ctx.teammate.slug, notes, ctx.endUser ?? undefined);
    const q = (await embed([query], "query", ctx.endUser ?? undefined)).vectors[0];
    vec = vs.map((v, i) => ({ i, s: cosine(q, v) })).sort((x, y) => y.s - x.s).slice(0, 20).map((x) => x.i);
  } catch { /* embeddings unavailable: keyword only */ }
  const cands = fuse([kw, vec].filter((l) => l.length));
  if (!cands.length) return { text: "Nothing relevant in memory." };
  const r = await recall(query, notes.map((n) => `${n.title}\n${n.body}`), cands, 5, ctx.endUser ?? undefined);
  return { text: `${r.hits.map((h) => `${show(notes[h.index])}\n  ${notes[h.index].body.slice(0, 500).replace(/\n/g, " ")}`).join("\n")}${r.reranked ? "" : "\n(ranked by keywords and meaning; Otari's reranker was unavailable)"}` };
}

// A person by Slack id (also inside "Hitakshi (U0…)" or <@U0…>), full name or first name.
const findPerson = async (who: string) => {
  const id = /\b(U[A-Z0-9]{6,})\b/.exec(String(who))?.[1];
  const name = String(who).replace(/<@[^>]+>|\(.*?\)/g, "").replace(/^@/, "").trim();
  return (await pool.query("SELECT id, display_name, slack_user FROM people WHERE slack_user = $1 OR lower(display_name) = lower($2) OR lower(split_part(display_name, ' ', 1)) = lower($2) ORDER BY (slack_user = $1) DESC, created_at LIMIT 1", [id ?? "", name])).rows[0];
};

// recall, person cards, promises and forgetting (NIGHT_PLAN_NOV9 §7.2).
export const workMemoryTools: AgentTool[] = [
  {
    name: "recall",
    description: "Look back: your past jobs (what, for whom, where, the result, links) and your notes, by meaning. Use it for \"do what you did last time\", \"what did we decide about X\", \"who handled Y\". Peeblo also sees the crew's jobs from shared places.",
    input_schema: object({ query: { type: "string" } }),
    kind: "read",
    async run(ctx, a) {
      return search(ctx, await recallNotes(ctx.teammate.slug, await where(ctx)), a.query);
    },
  },
  {
    name: "memory_forget",
    description: "Forget a note: when someone says \"forget X\", or a fact you kept is now wrong (write the new one, then forget the old). Give the bank and path from recall or your index, and why.",
    input_schema: object({ bank: { type: "string" }, path: { type: "string" }, why: { type: "string" } }),
    kind: "local",
    async run(ctx, a) {
      const ok = deleteNote(ctx.teammate.slug, await where(ctx), a.bank, a.path, a.why);
      return ok ? { text: `Forgot ${a.bank}/${a.path}.` } : { text: `No note ${a.bank}/${a.path} you can forget here (company memory changes only through an admin).`, isError: true };
    },
  },
  {
    name: "person_note",
    description: "Note how a person likes to work with you, so every teammate answers them well: \"Maya wants numbers first, no tables\", \"Jun reads on his phone; keep it to 2 lines\". Style and preferences only, never private content.",
    input_schema: object({ person: { type: "string", description: "Their name or Slack id." }, note: { type: "string" } }),
    kind: "local",
    async run(ctx, a) {
      const p = await findPerson(a.person);
      if (!p) return { text: `I don't know anyone called ${a.person} here.`, isError: true };
      addToCard(p.id, a.note, ctx.teammate.config.name);
      return { text: `Noted for ${p.display_name}. Every teammate sees it when ${p.display_name} talks to them.` };
    },
  },
  {
    name: "promise",
    description: "Keep track of something you said you'd do later (\"I'll check again Thursday\", \"I'll send it once Maya replies\"): make records it and, with due_at, wakes you then to do it or update them; done closes it; list shows open ones.",
    input_schema: object({
      action: { type: "string", enum: ["make", "done", "list"] },
      what: { type: ["string", "null"], description: "make: what you promised, in a line." },
      for_person: { type: ["string", "null"], description: "make: who you promised (name)." },
      due_at: { type: ["string", "null"], description: "make: an ISO time to follow up, or null." },
      id: { type: ["string", "null"], description: "done: the promise's path (from list)." },
    }),
    kind: "local",
    async run(ctx, a) {
      const place = await where(ctx);
      if (a.action === "list") {
        const open = openPromises(ctx.teammate.slug, place);
        return { text: open.length ? open.map((n) => `- ${n.path}: ${n.title}`).join("\n") : "No open promises." };
      }
      if (a.action === "done") {
        const n = a.id ? readNote(ctx.teammate.slug, place, "ws", a.id) ?? notesIn(ctx.teammate.slug, readBanks(place)).find((x) => x.path === a.id || x.path === `${a.id}.md`) : null;
        if (!n) return { text: `No open promise ${a.id}; list shows them.`, isError: true };
        await writeNote(ctx.teammate.slug, place, { path: n.path, title: n.title, body: n.body.replace("Status: open", `Status: done ${new Date().toISOString().slice(0, 10)}`), source: "promise kept", runId: ctx.runId, tainted: false });
        return { text: `Marked done: ${n.title}.` };
      }
      if (!a.what) return { text: "Say what you promised.", isError: true };
      const due = a.due_at && new Date(a.due_at).getTime() > Date.now() ? new Date(a.due_at).toISOString() : null;
      const id = `promises/${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 7)}`;
      const n = await writeNote(ctx.teammate.slug, place, { path: id, title: String(a.what).slice(0, 100), body: `Promised: ${a.what}\nFor: ${a.for_person ?? ctx.person?.display_name ?? "the team"}\nDue: ${due ?? "no date"}\nStatus: open`, source: `${ctx.teammate.config.name}'s promise`, runId: ctx.runId, tainted: false });
      let follow = "";
      if (due) {
        const { createSchedule } = await import("../triggers.ts");
        const slack = ((await getSession(ctx.sessionId))?.place as any)?.slack ?? null;
        const sc = await createSchedule(ctx.teammate, ctx.person?.id ?? null, { kind: "once", name: `Promise: ${String(a.what).slice(0, 60)}`, prompt: `You promised ${a.for_person ?? "them"}: ${a.what}. Do it now, or tell them plainly where it stands. Then mark the promise done (promise action done, id ${n.path}).`, runAt: due, place: slack ? { slack } : {}, budgetUsd: 0.05, originRequest: null });
        follow = ` I'll be woken at ${due} to follow up (${sc.id}).`;
      }
      return { text: `Recorded the promise (${n.path}).${follow}` };
    },
  },
];

// Peeblo's company memory: the company-setup skill drafts it; one approval from an admin commits the version.
export const companyMemoryTool: AgentTool = {
  name: "company_memory_propose",
  description: "Propose the company memory you've drafted (from the sources you read and the admin's answers) as one new version. An admin approves it once, seeing every note.",
  input_schema: object({ notes: { type: "array", maxItems: 40, items: { type: "object", properties: { path: { type: "string" }, title: { type: "string" }, body: { type: "string" }, source: { type: "string" } }, required: ["path", "title", "body", "source"], additionalProperties: false } } }),
  kind: "write",
  authorize(ctx) { return ctx.person ? null : "Company memory needs an admin in the conversation."; },
  describe(_ctx, a) {
    return { kind: "company_memory", approvers: [], diff: a.notes.map((n: any) => `${n.path}: ${n.title}`).join("\n").slice(0, 2500), notes: a.notes.length };
  },
  async run(ctx, a) {
    if (!isOtariAdmin(ctx.person)) return { text: "Only an admin can confirm company memory; ask one to approve it.", isError: true };
    const v = writeCompany(a.notes, ctx.person?.display_name ?? "an admin");
    return { text: `Company memory version ${v} is saved (${a.notes.length} notes). Every teammate can read it from now on.` };
  },
};
