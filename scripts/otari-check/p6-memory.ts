// Phase 6 "done when", through real turns: a teammate remembers a correction in a later conversation; DM memory never
// surfaces in a public thread; company setup produces company memory an admin confirmed, which other teammates read.
import { check, expect, save } from "./harness.ts";
import { answer, api, OWNER } from "./api.ts";
import { teammate, turn, used } from "./n-common.ts";
const { pool } = await import("../../src/db.ts");
const { notesIn } = await import("../../src/memory/store.ts");

const S = "P6";
const tm = await teammate("memory-check", { tools: [], connectors: [] });
const stamp = Date.now().toString(36);
const slackPlace = (channel: string, channel_type: string, user = OWNER.slack_user) => ({ slack: { app_id: "A0CFRJXTVA6", team: "T0CFKBN3YPM", channel, channel_type, thread_ts: stamp, trigger_ts: stamp, user, direct: true } });
async function turnAt(slug: string, place: any, kind: string, text: string, opts: { answer?: "approved"; answerAs?: string } = {}) {
  const s = await api("POST", `/v1/teammates/${slug}/sessions`, { kind, place_key: `check:${kind}:${Math.random().toString(36).slice(2)}`, place });
  const sub = await api("POST", `/v1/sessions/${s.id}/submissions`, { text, request_id: `p6-${Math.random().toString(36).slice(2)}`, person: OWNER });
  const { settle, tools } = await import("./api.ts");
  const r = await settle(sub.run_id, { timeoutMs: 400_000, ...opts });
  return { ...r, tools: tools(r.events), sessionId: s.id };
}

await check(S, "a correction is remembered in a later conversation", async (c) => {
  const first = await turn(tm, "p6-correct", `Quick correction for the record: our fiscal year starts on February 1st, not January 1st (ref ${stamp}). Please remember that.`);
  expect(used(first.tools, "memory_write").some((x) => x.status === "completed"), `tools: ${first.tools.map((x: any) => `${x.tool}:${x.status}`).join(", ")}`);
  const later = await turn(tm, "p6-recall", "When does our fiscal year start? One line.");
  c.note("answer", answer(later.events).slice(0, 160));
  expect(/feb/i.test(answer(later.events)), `answer: ${answer(later.events).slice(0, 200)}`);
});

await check(S, "a DM's memory never surfaces in a public thread", async (c) => {
  const code = `zebra-${stamp}`;
  const dm = await turnAt("memory-check", slackPlace("D0CHECKDM", "im"), "dm", `Keep this between us for now: I'm planning the team offsite for Lisbon in March, project name ${code}. Please remember it for later.`);
  expect(used(dm.tools, "memory_write").some((x) => x.status === "completed"), "the DM didn't save a note");
  const pub = await turnAt("memory-check", slackPlace("C0CHECKPUB", "channel"), "thread", "Where is Hitakshi planning the team offsite, and what's the project name? Check your memory (grep for offsite and zebra).");
  const a = answer(pub.events);
  const grep = pub.events.filter((e: any) => e.type === "tool.call" && /^memory_/.test(e.data.tool));
  c.note("public_tools", grep.map((e: any) => e.data.tool)); c.note("answer", a.slice(0, 120));
  expect(!a.includes(code), "the codeword appeared in the public thread");
  const tmRow = (await pool.query("SELECT slug FROM teammates WHERE slug = 'memory-check'")).rows[0];
  const publicView = notesIn(tmRow.slug, ["ws"]).some((n) => n.body.includes(code));
  expect(!publicView, "the DM note is in the team bank");
});

await check(S, "company setup produces company memory an admin confirmed, and other teammates read it", async (c) => {
  const r = await turnAt("peeblo", slackPlace("D0CHECKADMIN", "im"), "dm", "Set up our company memory. Read only the Linear GRO team (a few recent issues) and keep it to 2 or 3 short notes; don't ask me questions. Then propose it.", { answer: "approved" });
  const p = used(r.tools, "company_memory_propose");
  c.note("tools", r.tools.map((x: any) => `${x.tool}:${x.status}`));
  expect(p.some((x) => x.status === "completed"), `company_memory_propose: ${JSON.stringify(p.map((x) => [x.status, x.error]))}`);
  const company = notesIn("memory-check", []).filter((n) => n.bank === "company");
  expect(company.length >= 2, `company notes: ${company.length}`);
  const other = await turn(tm, "p6-company", "From company memory, what is the Linear GRO team working on? Use memory_grep or memory_search. One line.");
  c.note("other_answer", answer(other.events).slice(0, 160));
  expect(other.tools.some((x: any) => /^memory_(grep|search|read)$/.test(x.tool) && x.status === "completed"), "the other teammate didn't read memory");
});
await pool.end();
process.exit((await save(S)) ? 0 : 1);
