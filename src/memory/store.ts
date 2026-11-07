// Memory is versioned files per place (J3, K12). Each teammate has a git repo in core (data/teammates/<slug>/memory)
// with one folder per bank; core is the only writer (one commit per write). Code decides scope:
// - what a conversation can read: its own place's bank, the teammate's workspace bank ("ws") and the company bank;
//   a DM's bank is readable only in that DM, a private channel's only there;
// - where it writes: its own place's bank, never a wider one;
// - writes from a run that read untrusted content are marked unverified and stay out of the index until an owner
//   verifies them;
// - size caps, safe paths, and a short index (≤200 lines) taken once per session.
// The company bank is Peeblo's company memory, shared by every teammate; it changes only through an approved version.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { config } from "../config.ts";
import { pool } from "../db.ts";

export type Place = { kind: "public" | "private" | "dm" | "api"; channel?: string; user?: string };
const MAX_NOTE = 8_000, MAX_NOTES = 2_000, INDEX_LINES = 200;
const repoOf = (slug: string) => join(config.dataDir, "teammates", slug, "memory");
const COMPANY = () => join(config.dataDir, "company-memory");

export function placeOfSession(session: { kind: string; place: any }): Place {
  const s = session.place?.slack;
  if (!s) return { kind: session.kind === "dm" ? "dm" : "api" };
  if (s.channel_type === "im") return { kind: "dm", user: s.user };
  if (s.channel_type === "group" || s.channel_type === "mpim" || String(s.channel).startsWith("G")) return { kind: "private", channel: s.channel };
  return { kind: "public", channel: s.channel };
}
export const writeBank = (p: Place) => (p.kind === "dm" && p.user ? `dm-${p.user}` : p.kind === "private" && p.channel ? `ch-${p.channel}` : "ws");
export const readBanks = (p: Place) => [...new Set([writeBank(p), "ws"])];

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, "-c", "user.name=peeblo-core", "-c", "user.email=core@peeblo.invalid", "-c", "core.hooksPath=/dev/null", ...args], { encoding: "utf8" }).trim();
}
function ensureRepo(dir: string): void {
  if (existsSync(join(dir, ".git"))) return;
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), "Memory notes, one folder per place. Written only by Peeblo core.\n");
  git(dir, ["add", "README.md"]); git(dir, ["commit", "-q", "-m", "start"]);
}

export type Note = { bank: string; path: string; title: string; body: string; verified: boolean; updated: string; source: string };
const FRONT = /^---\n([\s\S]*?)\n---\n?/;
function parse(bank: string, path: string, text: string): Note {
  const m = FRONT.exec(text);
  const meta: Record<string, string> = {};
  if (m) for (const l of m[1].split("\n")) { const i = l.indexOf(":"); if (i > 0) meta[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
  return { bank, path, title: meta.title || path.replace(/\.md$/, ""), body: m ? text.slice(m[0].length) : text, verified: meta.verified !== "false", updated: meta.updated ?? "", source: meta.source ?? "" };
}
const front = (n: { title: string; verified: boolean; source: string }) => `---\ntitle: ${n.title.replace(/\n/g, " ")}\nverified: ${n.verified}\nsource: ${n.source.replace(/\n/g, " ")}\nupdated: ${new Date().toISOString()}\n---\n`;

// A safe note path inside a bank: lowercase words, folders allowed, .md.
export function notePath(p: string): string | null {
  const n = normalize(String(p).trim().replace(/^\/+/, "")).toLowerCase().replace(/\s+/g, "-");
  if (!n || n.startsWith("..") || n.includes("/../") || !/^[a-z0-9][a-z0-9/_.-]{0,120}$/.test(n)) return null;
  return n.endsWith(".md") ? n : `${n}.md`;
}

function bankDir(slug: string, bank: string): string { return bank === "company" ? COMPANY() : join(repoOf(slug), bank); }
function walk(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p, base) : f.endsWith(".md") ? [p.slice(base.length + 1)] : []; });
}

export function notesIn(slug: string, banks: string[]): Note[] {
  const out: Note[] = [];
  for (const bank of [...banks, "company"]) {
    const dir = bankDir(slug, bank);
    for (const p of walk(dir).slice(0, MAX_NOTES)) out.push(parse(bank, p, readFileSync(join(dir, p), "utf8")));
  }
  return out;
}

export function readNote(slug: string, place: Place, bank: string, path: string): Note | null {
  if (bank !== "company" && !readBanks(place).includes(bank)) return null;
  const p = notePath(path);
  if (!p) return null;
  const f = join(bankDir(slug, bank), p);
  return existsSync(f) ? parse(bank, p, readFileSync(f, "utf8")) : null;
}

// One write = one commit in the teammate's memory repo. Returns the note and whether it was marked unverified.
export async function writeNote(slug: string, place: Place, w: { path: string; title: string; body: string; source: string; runId: string | null; tainted: boolean }): Promise<Note> {
  const p = notePath(w.path);
  if (!p) throw new Error("a note path is a few lowercase words, e.g. customers/acme-billing");
  if (w.body.length > MAX_NOTE) throw new Error(`a note is at most ${MAX_NOTE} characters; split it`);
  const learn = await learnSetting(slug);
  if (w.tainted && learn === "off") throw new Error("this teammate doesn't keep memory from conversations that read outside content");
  const repo = repoOf(slug);
  ensureRepo(repo);
  const bank = writeBank(place);
  const file = join(repo, bank, p);
  mkdirSync(dirname(file), { recursive: true });
  const verified = !w.tainted;
  writeFileSync(file, front({ title: w.title, verified, source: w.source }) + w.body.trim() + "\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "--allow-empty", "-m", `${bank}/${p}: ${w.title}${verified ? "" : " (unverified)"}${w.runId ? ` [${w.runId}]` : ""}`]);
  return parse(bank, p, readFileSync(file, "utf8"));
}

async function learnSetting(slug: string): Promise<"off" | "unverified"> {
  const { rows } = await pool.query("SELECT v.config->'memory'->>'learn_from_tainted' AS l FROM teammates t JOIN teammate_versions v ON v.teammate_id = t.id AND v.version = t.version WHERE t.slug = $1", [slug]);
  return rows[0]?.l === "off" ? "off" : "unverified";
}

export function verifyNote(slug: string, bank: string, path: string): boolean {
  const repo = repoOf(slug);
  const f = join(repo, bank, notePath(path) ?? "");
  if (!existsSync(f)) return false;
  writeFileSync(f, readFileSync(f, "utf8").replace(/^verified: false$/m, "verified: true"));
  git(repo, ["commit", "-q", "-am", `${bank}/${path}: verified by its owner`]);
  return true;
}

// The short index a session starts with (frozen for that session): verified notes the place can read, one line each.
export function indexFor(slug: string, place: Place): string {
  const notes = notesIn(slug, readBanks(place)).filter((n) => n.verified);
  if (!notes.length) return "";
  const lines = notes.sort((a, b) => (b.updated > a.updated ? 1 : -1)).slice(0, INDEX_LINES).map((n) => `- [${n.bank}] ${n.path}: ${n.title}`);
  return `Memory you can read (${notes.length} notes; read one with memory_read, search with memory_grep or memory_search):\n${lines.join("\n")}`;
}

// Company memory: a proposed new version is written in full and committed only once an admin approves it.
export function writeCompany(notes: { path: string; title: string; body: string; source: string }[], by: string): string {
  const dir = COMPANY();
  ensureRepo(dir);
  for (const n of notes) {
    const p = notePath(n.path);
    if (!p || n.body.length > MAX_NOTE) continue;
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), front({ title: n.title, verified: true, source: n.source }) + n.body.trim() + "\n");
  }
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "--allow-empty", "-m", `company memory: ${notes.length} notes, approved by ${by}`]);
  return git(dir, ["rev-parse", "--short", "HEAD"]);
}

export const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
