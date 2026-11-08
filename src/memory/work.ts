// Work memory (NIGHT_PLAN_NOV9 §7.2): what an agent did, for whom and what it promised, kept so a later
// conversation (even after its computer was evicted and the session closed) can find it with recall.
// - Every finished job writes a one-paragraph entry from the run's events (code, not the model): what was asked,
//   for whom, where, the steps, what changed, the result, links, and the agent's own one-line summary.
// - Person cards: how each person likes answers, shared by every agent (style only, never private content).
// - Promises: what an agent said it would do, kept as notes and followed up by a one-time schedule.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { pool } from "../db.ts";
import { onEvent } from "../store/events.ts";
import { getSession } from "../store/sessions.ts";
import { getTeammate } from "../store/teammates.ts";
import { notesIn, placeOfSession, readBanks, writeNote, type Note, type Place } from "./store.ts";

const day = (d = new Date()) => d.toISOString().slice(0, 10);
const firstSentence = (t: string) => (t.replace(/\s+/g, " ").trim().match(/^.{10,220}?[.!?](\s|$)/)?.[0] ?? t.replace(/\s+/g, " ").slice(0, 200)).trim();

// The job entry for one finished run.
async function jobEntry(runId: string): Promise<{ slug: string; place: Place; path: string; title: string; body: string } | null> {
  const run = (await pool.query("SELECT r.id, r.session_id, r.status, sub.text, sub.source, p.display_name FROM runs r JOIN submissions sub ON sub.id = r.submission_id LEFT JOIN people p ON p.id = sub.person_id WHERE r.id = $1", [runId])).rows[0];
  if (!run) return null;
  const s = await getSession(run.session_id);
  const tm = s ? await getTeammate(s.teammate_id) : null;
  if (!s || !tm) return null;
  const ev = (await pool.query("SELECT type, data FROM events WHERE run_id = $1 AND type IN ('tool.call', 'slack.post', 'slack.canvas', 'chain.call') ORDER BY id", [runId])).rows;
  const calls = ev.filter((e) => e.type === "tool.call").map((e) => e.data as any);
  const posts = ev.filter((e) => e.type === "slack.post").map((e) => String((e.data as any).text ?? ""));
  if (!calls.length && !posts.length) return null; // nothing happened worth remembering
  const { stepTitle } = await import("../slack/look.ts");
  const steps = [...new Set(calls.filter((c) => c.status === "completed").map((c) => stepTitle(c.tool, { kind: c.kind, callee: c.callee })).filter(Boolean))];
  const changed = calls.filter((c) => c.status === "completed" && (c.kind === "write" || c.kind === "destructive")).map((c) => `${c.tool}${c.request_id ? ` (request ${c.request_id})` : ""}`);
  const links = [...new Set(calls.flatMap((c) => c.sources ?? []).concat(ev.filter((e) => e.type === "slack.canvas").map((e) => (e.data as any).url)))].filter(Boolean).slice(0, 6);
  const handed = ev.filter((e) => e.type === "chain.call").map((e) => (e.data as any).callee).filter(Boolean);
  const slack = (s.place as any)?.slack;
  const where = slack ? (slack.channel_type === "im" ? `a DM (${slack.channel}, thread ${slack.thread_ts})` : `<#${slack.channel}> (thread ${slack.thread_ts})`) : run.source === "teammate" ? "a job from another teammate" : `the ${run.source}`;
  const result = posts.at(-1) ?? "";
  const asked = String(run.text ?? "").replace(/\s+/g, " ").slice(0, 300);
  const body = [
    `For ${run.display_name ?? (run.source === "schedule" ? "a schedule" : "someone")}, in ${where}, on ${day()}.`,
    `Asked: ${asked}`,
    steps.length ? `Did: ${steps.join("; ")}.` : "",
    changed.length ? `Changed: ${changed.join("; ")}.` : "Changed nothing.",
    handed.length ? `Handed to: ${[...new Set(handed)].join(", ")}.` : "",
    result ? `Result: ${result.replace(/\s+/g, " ").slice(0, 500)}` : `Result: the run ${run.status}.`,
    links.length ? `Links: ${links.join(" ")}` : "",
    result ? `In one line: ${firstSentence(result)}` : "",
    `Run: ${runId}`,
  ].filter(Boolean).join("\n");
  return { slug: tm.slug, place: placeOfSession(s), path: `jobs/${day()}-${runId.replace(/^ru_/, "")}`, title: `${day()} · ${asked.slice(0, 80)}`, body };
}

export function installWorkMemory(): void {
  onEvent(async (e) => {
    if ((e.type !== "run.finished" && e.type !== "run.failed") || !e.run_id) return;
    const j = await jobEntry(e.run_id).catch((err) => { console.error("job log:", (err as Error).message); return null; });
    if (j) await writeNote(j.slug, j.place, { path: j.path, title: j.title, body: j.body, source: "Peeblo's job log", runId: e.run_id, tainted: false }).catch((err) => console.error("job log write:", (err as Error).message));
  });
}

// What a conversation may search: its notes and past jobs; Peeblo also sees the crew's jobs from public places.
export async function recallNotes(slug: string, place: Place): Promise<Note[]> {
  const own = notesIn(slug, readBanks(place));
  if (slug !== "peeblo") return own;
  const crew = (await pool.query("SELECT slug FROM teammates WHERE archived_at IS NULL AND slug <> 'peeblo'")).rows.map((r) => String(r.slug));
  const theirs = crew.flatMap((c) => notesIn(c, ["ws"]).filter((n) => n.bank === "ws" && n.path.startsWith("jobs/")).map((n) => ({ ...n, bank: `crew:${c}` })));
  return [...own, ...theirs];
}

// Person cards: one short file per person, shared by every agent.
const CARDS = () => join(config.dataDir, "people-cards");
export function personCard(personId: string): string {
  const f = join(CARDS(), `${personId}.md`);
  return existsSync(f) ? readFileSync(f, "utf8").trim() : "";
}
export function addToCard(personId: string, line: string, by: string): string {
  mkdirSync(CARDS(), { recursive: true });
  const f = join(CARDS(), `${personId}.md`);
  const lines = (existsSync(f) ? readFileSync(f, "utf8") : "").split("\n").filter(Boolean);
  const clean = line.replace(/\s+/g, " ").trim().slice(0, 200);
  // A newer note on the same topic replaces the older one (the first few words match).
  const key = clean.toLowerCase().split(" ").slice(0, 3).join(" ");
  const kept = lines.filter((l) => !l.toLowerCase().replace(/^- /, "").startsWith(key)).slice(-19);
  writeFileSync(f, [...kept, `- ${clean} (${by}, ${day()})`].join("\n") + "\n");
  return f;
}

// Open promises an agent made to a person (notes under promises/ with "Status: open").
export function openPromises(slug: string, place: Place, personName?: string | null): Note[] {
  return notesIn(slug, readBanks(place)).filter((n) => n.path.startsWith("promises/") && /Status: open/.test(n.body) && (!personName || n.body.includes(`For: ${personName}`)));
}
