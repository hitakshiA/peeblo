// The rule engine: Otari's /hooks/check checks a command or a file access against Peeblo's policy YAML
// (policies/teammate.yaml, or PEEBLO_POLICY_FILE). A required gate that doesn't pass means no; an advisory
// finding means a person is asked. Evidence is always sent, as [] when there is none, because Otari treats
// missing evidence as "unknown" (a block for required gates) but empty evidence as "nothing to check".
// Answers are cached by policy hash and action, since the same command is often checked again.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { otari } from "./client.ts";

export type Action = { commands?: string[]; paths?: string[]; pathSource?: "pre_tool_use.read_target" | "pre_tool_use.edit_target" };
export type Gate = { gate_id: string; enforcement: "required" | "advisory"; outcome: string; message: string; detail: string | null };
export type RuleDecision = { decision: "allow" | "ask" | "deny"; gates: Gate[]; failing: Gate[]; requestId: string | null; cached: boolean; policyId: string };

const POLICY_FILE = process.env.PEEBLO_POLICY_FILE || join(import.meta.dirname, "..", "..", "policies", "teammate.yaml");
let policy: { yaml: string; hash: string } | null = null;
export function policyYaml(): { yaml: string; hash: string } {
  if (!policy) { const yaml = readFileSync(POLICY_FILE, "utf8"); policy = { yaml, hash: createHash("sha256").update(yaml).digest("hex").slice(0, 16) }; }
  return policy;
}

const cache = new Map<string, Omit<RuleDecision, "cached">>();
const MAX = 2000;

export async function checkAction(a: Action): Promise<RuleDecision> {
  const p = policyYaml();
  const commands = a.commands ?? [];
  const paths = a.paths ?? [];
  const key = createHash("sha256").update(JSON.stringify([p.hash, commands, paths, a.pathSource ?? null])).digest("hex");
  const hit = cache.get(key);
  if (hit) return { ...hit, cached: true };
  // Otari is the check and the audit record. If it can't be reached, the same policy is applied here, so a teammate's
  // computer keeps working through an outage (and nothing the policy forbids gets through).
  const { data, requestId } = await otari<{ blocked: boolean; policy_id: string; results: Gate[] }>("POST", "/hooks/check", {
    policy_yaml: p.yaml, commands, command_scope: "call", paths, path_source: a.pathSource ?? "pre_tool_use.edit_target",
  }).catch((e: { status?: number }) => {
    if (e.status && e.status < 500 && e.status !== 429) throw e;
    return { data: localCheck(p.yaml, commands, paths, a.pathSource ?? "pre_tool_use.edit_target"), requestId: null };
  });
  const failing = data.results.filter((g) => g.outcome !== "pass" && g.outcome !== "not_applicable");
  const decision: RuleDecision["decision"] = data.blocked || failing.some((g) => g.enforcement === "required") ? "deny" : failing.length ? "ask" : "allow";
  const out = { decision, gates: data.results, failing, requestId, policyId: data.policy_id };
  if (cache.size >= MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, out);
  return { ...out, cached: false };
}

// A sentence for the teammate (and the person) about why something was refused or needs a yes.
export const ruleMessage = (d: RuleDecision): string => d.failing.map((g) => g.message || g.gate_id).join(" ");

// The policy file's gates, read without a YAML library (it uses a small, fixed shape: one "- id:" per gate, flat keys,
// lists written as JSON arrays).
type LocalGate = { id: string; type: string; runs: string[]; enforcement: "required" | "advisory"; forbidden: string[]; message: string };
export function parseGates(yaml: string): LocalGate[] {
  const body = yaml.split(/^gates:\s*$/m)[1] ?? "";
  return body.split(/^\s*- id:/m).slice(1).map((chunk) => {
    const lines = `id:${chunk}`.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    const kv = Object.fromEntries(lines.map((l) => { const i = l.indexOf(":"); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
    const list = (v?: string) => { try { return v ? (JSON.parse(v.replace(/\[\s*([^\]"]*?)\s*\]/, (_m, x) => `[${String(x).split(",").filter(Boolean).map((s) => JSON.stringify(s.trim())).join(",")}]`)) as string[]) : []; } catch { return []; } };
    return { id: kv.id, type: kv.type, runs: list(kv.runs), enforcement: kv.enforcement === "required" ? "required" : "advisory", forbidden: list(kv.forbidden), message: kv.message ?? "" } as LocalGate;
  });
}
const globRe = (g: string) => new RegExp(`^${g.split("**").map((p) => p.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*")}$`);
export function localCheck(yaml: string, commands: string[], paths: string[], pathSource: string): { blocked: boolean; policy_id: string; results: Gate[] } {
  const results: Gate[] = parseGates(yaml).map((g) => {
    const hit = g.type === "command" ? commands.some((c) => g.forbidden.some((f) => c.includes(f)))
      : g.type === "path" && g.runs.includes(pathSource) ? paths.some((p) => g.forbidden.some((f) => globRe(f).test(p) || globRe(f).test(`/${p}`))) : null;
    return { gate_id: g.id, enforcement: g.enforcement, outcome: hit === null ? "not_applicable" : hit ? "fail" : "pass", message: g.message, detail: hit ? "checked by Peeblo (Otari unreachable)" : null };
  });
  return { blocked: results.some((r) => r.outcome === "fail" && r.enforcement === "required"), policy_id: "local", results };
}
