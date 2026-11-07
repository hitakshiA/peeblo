// Changing a teammate's model (K3). The model is chosen at a boundary: at hire, when a session or job starts,
// or because a person asked. Code checks the open-weight allowlist, the requester's authority and the budget,
// writes a new config version (new sessions pick it up), and, if the person wants it now, moves one running
// session onto it; that session's next turn starts with a note, and its system prompt is never edited.
import { mayManageTeammate } from "./authority.ts";
import { estimateCost, isOpenWeight, models } from "./otari/catalog.ts";
import { ROLES } from "./otari/routing.ts";
import { teammateSpend, usd } from "./otari/spend.ts";
import { appendEvent } from "./store/events.ts";
import { getPerson } from "./store/people.ts";
import { getTeammate, updateTeammate, type Teammate } from "./store/teammates.ts";

export class ModelChangeRefused extends Error {
  status = 403;
}

export async function checkModel(id: string): Promise<string | null> {
  if (id in ROLES) return null;
  const m = (await models()).get(id);
  if (!m) return `${id} is not in Otari's catalog`;
  if (!isOpenWeight(id)) return `${id} is not open-weight; Peeblo teammates run on open-weight models`;
  if (m.type && m.type !== "chat") return `${id} is not a chat model`;
  return null;
}

export async function changeModel(slug: string, change: { model: string; fallback?: string | null; personId: string; now?: { sessionId: string } | null; why?: string }): Promise<{ teammate: Teammate; appliesTo: "new sessions" | "now" }> {
  const tm = await getTeammate(slug);
  if (!tm) throw Object.assign(new Error("no such teammate"), { status: 404 });
  const person = await getPerson(change.personId);
  if (!mayManageTeammate(tm, person)) throw new ModelChangeRefused(`only ${tm.config.name}'s owner or an Otari admin can change its model`);
  for (const m of [change.model, ...(change.fallback ? [change.fallback] : [])]) {
    const bad = await checkModel(m);
    if (bad) throw new ModelChangeRefused(bad);
  }
  // A typical turn (8k tokens in, 800 out) on the new model must fit what is left this month.
  const est = await estimateCost(change.model in ROLES ? ROLES[change.model].default : change.model, 8000, 800);
  const s = await teammateSpend(tm);
  if (est !== null && s.spent + est > s.cap) throw new ModelChangeRefused(`${tm.config.name} has ${usd(Math.max(0, s.cap - s.spent))} left this month, less than one turn on ${change.model} (about ${usd(est)})`);

  const next = await updateTeammate(slug, { model: { default: change.model, ...(change.fallback ? { fallback: change.fallback } : {}) } as Teammate["config"]["model"] }, { label: `person:${person!.id}` }, change.why ?? "model change");
  if (change.now) {
    await appendEvent({ sessionId: change.now.sessionId, runId: null, type: "session.config", data: { version: next.version, model: change.model, reason: "takeover", by: person!.display_name ?? person!.id, why: change.why ?? null } });
  }
  return { teammate: next, appliesTo: change.now ? "now" : "new sessions" };
}
