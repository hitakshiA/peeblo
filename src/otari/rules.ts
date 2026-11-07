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
  const { data, requestId } = await otari<{ blocked: boolean; policy_id: string; results: Gate[] }>("POST", "/hooks/check", {
    policy_yaml: p.yaml, commands, command_scope: "call", paths, path_source: a.pathSource ?? "pre_tool_use.edit_target",
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
