// K7b: a session starts with fewer than 20 tools; less-used connector tools are found with find_tools.
import { check, expect, save } from "./harness.ts";
import { calls } from "./api.ts";
import { teammate, turn } from "./n-common.ts";
import { pool } from "../../src/db.ts";
import { mostUsed } from "../../src/proxy/tools.ts";
import { getTeammate } from "../../src/store/teammates.ts";

const S = "N7";
const tm = await teammate("agent-check");

await check(S, "a session starts with fewer than 20 tools", async (c) => {
  const r = await turn(tm, "few-tools", "List the three most recently updated issues in the GRO team in Linear.");
  const first = calls(r.events).find((x) => x.role !== "guard" && x.status === 200);
  expect(first && first.tools_declared > 0 && first.tools_declared < 20, `first call declared ${first?.tools_declared} tools`);
  c.note("tools_declared", first.tools_declared);
  c.note("tools", r.tools.map((x: any) => `${x.tool}:${x.status}`));
});

// Tools this teammate uses often start loaded (that's the design), so the check asks for one still deferred.
const CANDIDATES: [RegExp, string, string][] = [
  [/label/, "linear__list_issue_labels", "Which issue labels exist in the GRO team in Linear?"],
  [/cycle/, "linear__list_cycles", "Which cycles does the GRO team have in Linear?"],
  [/project/, "linear__list_projects", "Which projects exist in our Linear workspace?"],
  [/document/, "linear__list_documents", "Which documents are in our Linear workspace?"],
  [/user/, "linear__list_users", "Who are the members of our Linear workspace?"],
  [/status/, "linear__list_issue_statuses", "Which issue statuses does the GRO team use in Linear?"],
];
await check(S, "a less-used connector tool is found with find_tools, then used", async (c) => {
  const id = (await getTeammate(tm))!.id;
  const direct = await mostUsed(id, CANDIDATES.map((x) => x[1]).concat(["linear__get_issue", "linear__list_issues", "linear__list_comments", "linear__list_teams"]));
  const pick = CANDIDATES.find((x) => !direct.has(x[1]));
  expect(pick, `every candidate is already loaded at start: ${[...direct].join(", ")}`);
  const r = await turn(tm, "find-tool", pick![2]);
  const used = r.tools.map((x: any) => x.tool);
  const later = calls(r.events).filter((x) => x.role !== "guard" && x.status === 200).map((x) => x.tools_declared);
  c.note("target", pick![1]);
  c.note("tools", r.tools.map((x: any) => `${x.tool}:${x.status}`));
  c.note("declared_per_call", later);
  expect(used.some((t: string) => pick![0].test(t)), `no ${pick![1]} used: ${used.join(", ")}`);
  expect(Math.max(...later) > Math.min(...later), "the declared set never grew (find_tools didn't turn anything on)");
});
await pool.end();
process.exit((await save(S)) ? 0 : 1);
