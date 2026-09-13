import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";

// Durable business memory. Model sessions are disposable; everything needed to resume a case lives here.
const DB_PATH = process.env.PEEBLO_DB ?? resolve(process.env.HOME ?? ".", ".peeblo", "peeblo.db");
mkdirSync(dirname(DB_PATH), { recursive: true });
export const db = new DatabaseSync(DB_PATH);
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, objective TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',          -- open | waiting | resolved | escalated
  accounts TEXT NOT NULL DEFAULT '[]',          -- provider identifiers the case concerns
  next_action TEXT, summary TEXT, dedupe_key TEXT UNIQUE,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, source TEXT NOT NULL, dedupe_key TEXT UNIQUE, payload TEXT NOT NULL,
  case_id TEXT, received_at TEXT NOT NULL, processed_at TEXT);
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL, source TEXT NOT NULL, ref TEXT, fact TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL, kind TEXT NOT NULL, params TEXT NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL, amount REAL, authority TEXT NOT NULL,
  status TEXT NOT NULL,                          -- proposed | awaiting_approval | approved | rejected | submitted | succeeded | failed | uncertain
  approval_id TEXT, result TEXT, verification TEXT, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL, operation_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,                          -- pending | approved | rejected | expired
  approver TEXT, slack_ts TEXT, expires_at TEXT NOT NULL, decided_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS wakeups (
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL, due_at TEXT NOT NULL, reason TEXT NOT NULL, fired_at TEXT);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, case_id TEXT NOT NULL, trigger TEXT NOT NULL, status TEXT, output TEXT,
  iterations INTEGER, input_tokens INTEGER, output_tokens INTEGER, trace_id TEXT, started_at TEXT NOT NULL, ended_at TEXT);
CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY, lesson TEXT NOT NULL, source_case TEXT, reviewed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);`);

export const now = () => new Date().toISOString();
export const id = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;
export const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 32);
const j = (v: unknown) => JSON.stringify(v);

export interface CaseRow { id: string; title: string; objective: string; status: string; accounts: string; next_action: string | null; summary: string | null; created_at: string; updated_at: string }

export const cases = {
  create(title: string, objective: string, dedupeKey?: string): CaseRow {
    if (dedupeKey) {
      const existing = db.prepare("SELECT * FROM cases WHERE dedupe_key = ?").get(dedupeKey) as CaseRow | undefined;
      if (existing) return existing; // duplicate events resume the same case
    }
    const row = { id: id("case"), title, objective, t: now() };
    db.prepare("INSERT INTO cases (id,title,objective,dedupe_key,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(row.id, title, objective, dedupeKey ?? null, row.t, row.t);
    return this.get(row.id)!;
  },
  get: (caseId: string) => db.prepare("SELECT * FROM cases WHERE id = ?").get(caseId) as CaseRow | undefined,
  list: (status?: string) => (status ? db.prepare("SELECT * FROM cases WHERE status = ? ORDER BY updated_at DESC").all(status) : db.prepare("SELECT * FROM cases ORDER BY updated_at DESC").all()) as unknown as CaseRow[],
  update(caseId: string, patch: Partial<Pick<CaseRow, "status" | "next_action" | "summary" | "title">> & { accounts?: string[] }) {
    const c = this.get(caseId)!;
    db.prepare("UPDATE cases SET status=?, next_action=?, summary=?, title=?, accounts=?, updated_at=? WHERE id=?").run(
      patch.status ?? c.status, patch.next_action ?? c.next_action, patch.summary ?? c.summary, patch.title ?? c.title,
      patch.accounts ? j([...new Set([...JSON.parse(c.accounts), ...patch.accounts])]) : c.accounts, now(), caseId);
  },
};

export const evidence = {
  add: (caseId: string, source: string, fact: string, ref?: string) =>
    db.prepare("INSERT INTO evidence VALUES (?,?,?,?,?,?)").run(id("ev"), caseId, source, ref ?? null, fact, now()),
  list: (caseId: string) => db.prepare("SELECT source, ref, fact, created_at FROM evidence WHERE case_id = ? ORDER BY created_at").all(caseId),
};

export const wakeups = {
  schedule: (caseId: string, dueAt: string, reason: string) => {
    db.prepare("UPDATE wakeups SET fired_at = ? WHERE case_id = ? AND fired_at IS NULL").run("superseded", caseId);
    db.prepare("INSERT INTO wakeups VALUES (?,?,?,?,NULL)").run(id("wk"), caseId, dueAt, reason);
  },
  due: () => db.prepare("SELECT * FROM wakeups WHERE fired_at IS NULL AND due_at <= ? ORDER BY due_at").all(now()) as { id: string; case_id: string; reason: string; due_at: string }[],
  fire: (wakeupId: string) => db.prepare("UPDATE wakeups SET fired_at = ? WHERE id = ?").run(now(), wakeupId),
  pending: (caseId: string) => db.prepare("SELECT due_at, reason FROM wakeups WHERE case_id = ? AND fired_at IS NULL").get(caseId) as { due_at: string; reason: string } | undefined,
};

export const events = {
  // Returns null when the event was already received (webhook/Slack retries).
  receive(source: string, dedupeKey: string, payload: unknown): string | null {
    const res = db.prepare("INSERT OR IGNORE INTO events VALUES (?,?,?,?,NULL,?,NULL)").run(id("evt"), source, dedupeKey, j(payload), now());
    return res.changes ? (db.prepare("SELECT id FROM events WHERE dedupe_key = ?").get(dedupeKey) as { id: string }).id : null;
  },
  attach: (eventId: string, caseId: string) => db.prepare("UPDATE events SET case_id = ?, processed_at = ? WHERE id = ?").run(caseId, now(), eventId),
};

export const runs = {
  start: (caseId: string, trigger: string) => { const r = id("run"); db.prepare("INSERT INTO runs (id,case_id,trigger,started_at) VALUES (?,?,?,?)").run(r, caseId, trigger, now()); return r; },
  end: (runId: string, v: { status: string; output: string; iterations: number; inputTokens: number; outputTokens: number; traceId?: string }) =>
    db.prepare("UPDATE runs SET status=?, output=?, iterations=?, input_tokens=?, output_tokens=?, trace_id=?, ended_at=? WHERE id=?").run(v.status, v.output, v.iterations, v.inputTokens, v.outputTokens, v.traceId ?? null, now(), runId),
  list: (caseId: string) => db.prepare("SELECT trigger, status, output, started_at FROM runs WHERE case_id = ? ORDER BY started_at").all(caseId),
};

export const lessons = {
  reviewed: () => db.prepare("SELECT lesson FROM lessons WHERE reviewed = 1 ORDER BY created_at DESC LIMIT 20").all() as { lesson: string }[],
  propose: (lesson: string, caseId: string) => db.prepare("INSERT INTO lessons VALUES (?,?,?,0,?)").run(id("lsn"), lesson, caseId, now()),
};
