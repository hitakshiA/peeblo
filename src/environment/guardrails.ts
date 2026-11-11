// A repo's own guardrails, read the way Otari's agent hook reads them: `.otari/guardrails.yml` and every .yml/.yaml
// under `.otari/guardrails/`, each file checked by Otari's /hooks/check. They come from the branch's base commit,
// never from the teammate's own branch, so the work can't loosen its own rules.
// While a teammate works, the repo's command and path gates apply to each call, next to Peeblo's own policy. Before a
// branch is published, the finished-work gates run: changed paths (stop.working_tree), required commands
// (command_if_changed, against every command the session ran), verifier scripts (run on the teammate's computer: exit
// 0 passes, 1 fails, anything else is an error) and judge rubrics (Peeblo's judge reads the diff and what the
// teammate said). A required gate that doesn't pass stops the push; advisory findings are reported with it.
import { createHash } from "node:crypto";
import { normalize } from "node:path";
import { parse } from "yaml";
import { pool } from "../db.ts";
import { otari } from "../otari/client.ts";
import { type Action, checkAction, globRe, type RuleDecision } from "../otari/rules.ts";
import { appendEvent } from "../store/events.ts";
import type { Teammate } from "../store/teammates.ts";
import { exec as vmExec } from "./controller.ts";
import type { Worktree } from "./repos.ts";
import { sh } from "./shell.ts";

type RawGate = {
  id: string;
  type: string;
  enforcement?: string;
  rubric?: string;
  verifier?: string;
  when_changed?: string[];
  priority?: number;
};
export type GuardFile = { path: string; yaml: string; hash: string; gates: RawGate[]; error: string | null };
type Verdict = { gate_id: string; outcome: "pass" | "fail" | "error"; reasoning?: string; detail?: string };
type GateResult = { gate_id: string; enforcement: "required" | "advisory"; outcome: string; message: string; detail: string | null };

const MAX_FILES = 64; // Otari's own limits
const MAX_VERIFIERS = 20;
const MAX_JUDGES = 5;
const VERIFIER_TIMEOUT_S = 30;
const MAX_DIFF = 60_000;
const MAX_TRANSCRIPT = 40_000;

const SEP = "\u001e";
const files = new Map<string, GuardFile[]>(); // by teammate, repo and base commit

const revOf = (w: Worktree) => w.base_commit ?? `refs/remotes/origin/${w.base}`;

export function parseGuardFile(path: string, yaml: string): GuardFile {
  const hash = createHash("sha256").update(yaml).digest("hex").slice(0, 16);
  try {
    const doc = parse(yaml);
    const gates = Array.isArray(doc?.gates)
      ? doc.gates.filter((g: unknown) => g && typeof g === "object" && typeof (g as RawGate).id === "string")
      : [];
    return { path, yaml, hash, gates, error: null };
  } catch (e) {
    return { path, yaml, hash, gates: [], error: (e as Error).message.split("\n")[0].slice(0, 200) };
  }
}

// The repo's guardrail files at the branch's base, read on the teammate's computer (cached per base commit).
async function guardFilesOf(tm: Teammate, sessionId: string, w: Worktree): Promise<GuardFile[]> {
  const rev = revOf(w);
  const key = `${tm.id}:${w.repo}:${rev}`;
  const hit = files.get(key);
  if (hit) return hit;
  const r = await vmExec(
    tm.id,
    [
      "sh",
      "-c",
      `cd "$1" && git ls-tree -r --name-only "$2" -- .otari/guardrails.yml .otari/guardrails | grep -E '\\.ya?ml$' | sort | head -n ${MAX_FILES} | while IFS= read -r f; do printf '${SEP}%s\\n' "$f"; git show "$2:$f"; done`,
      "sh",
      w.path,
      rev,
    ],
    { sessionId, timeoutMs: 30_000 },
  );
  if (r.exitCode !== 0) throw new Error(`couldn't read the repo's guardrails: ${r.stderr.slice(-200)}`);
  const out = String(r.stdout ?? "")
    .split(SEP)
    .filter(Boolean)
    .map((chunk) => {
      const nl = chunk.indexOf("\n");
      return parseGuardFile(chunk.slice(0, nl), chunk.slice(nl + 1));
    });
  if (files.size > 200) files.clear();
  files.set(key, out);
  return out;
}

// One call's command or file access against the repo's own guardrails (the checkout it happens in). Paths are made
// repo-relative. Null when the repo has none that apply; a file Otari can't parse is skipped here (Peeblo's own
// policy still applies) and reported when the branch is published.
export async function checkRepoAction(tm: Teammate, sessionId: string, worktrees: Worktree[], a: Action): Promise<RuleDecision | null> {
  const w = a.paths?.length ? worktrees.find((x) => a.paths!.every((p) => p === x.path || p.startsWith(`${x.path}/`))) : worktrees.at(-1);
  if (!w) return null;
  const want = a.commands?.length ? "command" : "path";
  const relevant = (await guardFilesOf(tm, sessionId, w)).filter((f) => !f.error && f.gates.some((g) => g.type === want));
  if (!relevant.length) return null;
  const action: Action = a.paths?.length ? { ...a, paths: a.paths.map((p) => p.slice(w.path.length + 1)) } : a;
  const decisions: RuleDecision[] = [];
  for (const f of relevant) {
    try {
      const d = await checkAction(action, { yaml: f.yaml, hash: f.hash });
      decisions.push({ ...d, failing: d.failing.map((g) => ({ ...g, message: `${w.repo}'s ${f.path}: ${g.message || g.gate_id}` })) });
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 422) continue; // a file Otari can't parse
      decisions.push({
        decision: "ask",
        gates: [],
        failing: [
          {
            gate_id: "repo-guardrails",
            enforcement: "advisory",
            outcome: "error",
            message: `Otari couldn't check ${w.repo}'s ${f.path} just now.`,
            detail: null,
          },
        ],
        requestId: null,
        cached: false,
        policyId: f.path,
      });
    }
  }
  if (!decisions.length) return null;
  const worst = decisions.find((d) => d.decision === "deny") ?? decisions.find((d) => d.decision === "ask") ?? decisions[0];
  return { ...worst, failing: decisions.flatMap((d) => (d.decision === worst.decision ? d.failing : [])) };
}

const applies = (g: RawGate, changed: string[]) =>
  !g.when_changed?.length || changed.some((p) => g.when_changed!.some((x) => globRe(x).test(p)));

async function sh1(tm: Teammate, sessionId: string, cwd: string, script: string, timeoutMs = 60_000) {
  return vmExec(tm.id, ["sh", "-c", script], { cwd, sessionId, timeoutMs });
}

async function runVerifier(tm: Teammate, sessionId: string, w: Worktree, g: RawGate): Promise<Verdict> {
  const v = normalize(String(g.verifier ?? ""));
  if (!v || v.startsWith("..") || v.startsWith("/"))
    return { gate_id: g.id, outcome: "error", detail: `verifier ${g.verifier} is outside the repo` };
  // The base's own copy of the script, so the branch can't change what checks it.
  const r = await sh1(
    tm,
    sessionId,
    w.path,
    `T=$(mktemp) && git show ${sh(`${revOf(w)}:${v}`)} > "$T" 2>/dev/null || { echo "verifier ${v.replace(/[^\w./-]/g, "")} isn't in the repo's base"; exit 3; }; chmod +x "$T"; timeout ${VERIFIER_TIMEOUT_S} "$T"; c=$?; rm -f "$T"; exit $c`,
    (VERIFIER_TIMEOUT_S + 15) * 1000,
  );
  const detail = String(r.stdout ?? "").slice(0, 4096);
  if (r.exitCode === 0) return { gate_id: g.id, outcome: "pass", detail };
  if (r.exitCode === 1) return { gate_id: g.id, outcome: "fail", detail };
  return {
    gate_id: g.id,
    outcome: "error",
    detail: detail || (r.exitCode === 124 ? `didn't finish in ${VERIFIER_TIMEOUT_S} s` : `exited ${r.exitCode}`),
  };
}

async function runJudge(g: RawGate, diff: string, transcript: string, endUser: string | null): Promise<Verdict> {
  const { decide } = await import("../otari/decisions.ts");
  const d = await decide(
    `Diff of the changes on this branch:\n${diff}\n\nWhat the teammate said while making them:\n${transcript || "(nothing)"}`,
    {
      rule_met: {
        type: "noul",
        instructions: `Does this change satisfy the rule below? Judge only this rule.\n\nRule:\n${String(g.rubric ?? "").slice(0, 16_000)}`,
      },
    },
    { safeDefault: { rule_met: null }, ...(endUser ? { endUser } : {}) },
  );
  const a = d.answers.rule_met;
  return { gate_id: g.id, outcome: a.value === true ? "pass" : a.value === false ? "fail" : "error", reasoning: a.reason ?? "" };
}

// Every shell command the session ran on its computer, oldest first (for command_if_changed gates).
async function sessionCommands(sessionId: string): Promise<string[]> {
  const { rows } = await pool.query<{ c: string }>(
    "SELECT data->'result'->>'command' AS c FROM events WHERE session_id = $1 AND type = 'tool.call' AND data->>'tool' = 'computer_bash' AND data->'result' ? 'command' ORDER BY id",
    [sessionId],
  );
  return rows.map((r) => r.c.slice(0, 4096)).slice(-2000);
}

async function sessionTranscript(sessionId: string): Promise<string> {
  const { rows } = await pool.query<{ t: string }>(
    "SELECT data->>'text' AS t FROM events WHERE session_id = $1 AND type IN ('slack.post', 'turn.finished') AND coalesce(data->>'text', '') <> '' ORDER BY id",
    [sessionId],
  );
  return rows
    .map((r) => r.t)
    .join("\n\n")
    .slice(-MAX_TRANSCRIPT);
}

export type FinishedCheck = { blocked: boolean; report: string; results: (GateResult & { file: string })[] };

// The repo's finished-work gates for the branch as it stands. Null when the repo has no guardrail files.
export async function checkFinishedWork(
  tm: Teammate,
  sessionId: string,
  w: Worktree,
  endUser: string | null,
): Promise<FinishedCheck | null> {
  const all = await guardFilesOf(tm, sessionId, w);
  if (!all.length) return null;
  const range = `refs/remotes/origin/${w.base}...HEAD`;
  const changed = String((await sh1(tm, sessionId, w.path, `git diff --name-only ${sh(range)}`)).stdout ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const gates = all.flatMap((f) => f.gates);
  const verifiers = gates.filter((g) => g.type === "verifier" && applies(g, changed)).slice(0, MAX_VERIFIERS);
  const judges = gates
    .filter((g) => g.type === "judge" && applies(g, changed))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .slice(0, MAX_JUDGES);
  const checks: Verdict[] = [];
  for (const g of verifiers) checks.push(await runVerifier(tm, sessionId, w, g));
  let judged: Verdict[] = [];
  if (judges.length) {
    const diff = String((await sh1(tm, sessionId, w.path, `git diff ${sh(range)}`)).stdout ?? "").slice(0, MAX_DIFF);
    const transcript = await sessionTranscript(sessionId);
    judged = await Promise.all(judges.map((g) => runJudge(g, diff, transcript, endUser)));
  }
  const commands = await sessionCommands(sessionId);
  const results: FinishedCheck["results"] = [];
  const requestIds: string[] = [];
  for (const f of all) {
    if (f.error) {
      results.push({
        file: f.path,
        gate_id: "(file)",
        enforcement: "required",
        outcome: "error",
        message: `The guardrail file doesn't parse: ${f.error}`,
        detail: null,
      });
      continue;
    }
    const ids = new Set(f.gates.map((g) => g.id));
    try {
      const { data, requestId } = await otari<{ results: GateResult[] }>("POST", "/hooks/check", {
        policy_yaml: f.yaml,
        paths: changed,
        path_source: "stop.working_tree",
        commands,
        command_scope: "session",
        judge_results: judged
          .filter((v) => ids.has(v.gate_id))
          .map((v) => ({ gate_id: v.gate_id, outcome: v.outcome, reasoning: (v.reasoning ?? "").slice(0, 2000) })),
        check_results: checks
          .filter((v) => ids.has(v.gate_id))
          .map((v) => ({ gate_id: v.gate_id, outcome: v.outcome, detail: v.detail ?? "" })),
      });
      if (requestId) requestIds.push(requestId);
      for (const g of data.results) results.push({ ...g, file: f.path });
    } catch (e) {
      results.push({
        file: f.path,
        gate_id: "(file)",
        enforcement: "required",
        outcome: "error",
        message: `Otari couldn't check it: ${(e as Error).message.slice(0, 200)}`,
        detail: null,
      });
    }
  }
  const failing = results.filter((g) => g.outcome !== "pass" && g.outcome !== "not_applicable");
  const blocked = failing.some((g) => g.enforcement === "required");
  const line = (g: GateResult & { file: string }) =>
    `${g.enforcement === "required" ? "✗" : "!"} ${g.gate_id} (${g.file}, ${g.enforcement}, ${g.outcome}): ${g.message}${g.detail ? ` — ${g.detail.replace(/\s+/g, " ").slice(0, 300)}` : ""}`;
  const passed = results.filter((g) => g.outcome === "pass").length;
  const report = failing.length
    ? `${w.repo}'s guardrails: ${passed} passed, ${failing.length} didn't.\n${failing.map(line).join("\n")}`
    : `${w.repo}'s guardrails: all ${passed} that apply passed.`;
  await appendEvent({
    sessionId,
    runId: null,
    type: "repo.guardrails",
    data: {
      repo: w.repo,
      blocked,
      passed,
      failing: failing.map((g) => ({ gate: g.gate_id, file: g.file, enforcement: g.enforcement, outcome: g.outcome })),
      request_ids: requestIds,
    },
  });
  return { blocked, report, results };
}
