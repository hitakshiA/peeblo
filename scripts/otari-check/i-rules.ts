// Seam I: the rule engine on Otari's /hooks/check with Peeblo's teammate policy.
import { check, expect, save } from "./harness.ts";
import { otari } from "../../src/otari/client.ts";
import { checkAction, policyYaml } from "../../src/otari/rules.ts";

const S = "I";
const cases: [string, Parameters<typeof checkAction>[0], "allow" | "ask" | "deny"][] = [
  ["force push", { commands: ["git push --force origin main"] }, "deny"],
  ["plain push", { commands: ["git push origin feature/footer-fix"] }, "ask"],
  ["publish", { commands: ["npm publish"] }, "ask"],
  // Matching is per command segment, and "|" splits segments, so "piped into a shell" can't be a phrase.
  ["a pipe is checked segment by segment", { commands: ["cat notes.md | git push --force"] }, "deny"],
  ["wipe the disk", { commands: ["rm -rf /"] }, "deny"],
  ["harmless", { commands: ["pnpm test -- pricing"] }, "allow"],
  ["read a secret file", { paths: ["app/.env"], pathSource: "pre_tool_use.read_target" }, "deny"],
  ["edit source", { paths: ["src/pricing/proration.ts"], pathSource: "pre_tool_use.edit_target" }, "allow"],
];
for (const [name, action, want] of cases) {
  await check(S, `${name} → ${want}`, async (c) => {
    const d = await checkAction(action);
    if (d.requestId) c.ids.push(d.requestId);
    expect(d.decision === want, `got ${d.decision} (${d.failing.map((g) => `${g.gate_id}:${g.outcome}`).join(", ")})`);
    if (d.failing.length) c.note("gates", d.failing.map((g) => `${g.gate_id}:${g.outcome}`));
  });
}
await check(S, "the same action is answered from the cache", async () => {
  const d = await checkAction({ commands: ["git push --force origin main"] });
  expect(d.cached && d.decision === "deny", `cached=${d.cached}`);
});
await check(S, "why evidence is always sent: missing evidence is 'unknown', empty is 'not applicable'", async (c) => {
  const missing = await otari<any>("POST", "/hooks/check", { policy_yaml: policyYaml().yaml, path_source: "pre_tool_use.edit_target", paths: ["src/a.ts"] });
  const empty = await otari<any>("POST", "/hooks/check", { policy_yaml: policyYaml().yaml, path_source: "pre_tool_use.edit_target", paths: ["src/a.ts"], commands: [], command_scope: "call" });
  c.ids.push(missing.requestId!, empty.requestId!);
  const outcome = (r: any, id: string) => r.data.results.find((g: any) => g.gate_id === id)?.outcome;
  c.note("missing", { blocked: missing.data.blocked, "no-force-push": outcome(missing, "no-force-push") });
  c.note("empty", { blocked: empty.data.blocked, "no-force-push": outcome(empty, "no-force-push") });
  expect(!empty.data.blocked, "empty evidence blocked");
});
process.exit((await save(S)) ? 0 : 1);
