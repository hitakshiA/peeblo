// Otari records each connector's health from real traffic. Peeblo reads it every half hour and tells the
// admins once when a connector stops working (twice in a row, so a slow first answer isn't news), and once
// when it works again. A dead token is then found the day it dies, not mid-job.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.ts";
import { session } from "./admin.ts";
import { healthLine, servers, type Server } from "./connectors.ts";

// A message to every admin in Slack, from Peeblo's own app. Returns how many got it.
export async function tellAdmins(text: string): Promise<number> {
  if (!config.admins.length) return 0;
  const { getTeammate } = await import("../store/teammates.ts");
  const { ownApp } = await import("../ingress/apps.ts");
  const { slack } = await import("../slack/api.ts");
  const peeblo = await getTeammate("peeblo");
  const app = peeblo ? await ownApp(peeblo.id) : null;
  if (!app) return 0;
  let n = 0;
  for (const user of config.admins)
    await slack(app, "chat.postMessage", { channel: user, text })
      .then(() => n++)
      .catch((e) => console.error("tell admins:", (e as Error).message));
  return n;
}

// A direct message to one person, from Peeblo's own app.
export async function dmFromPeeblo(personId: string, text: string): Promise<boolean> {
  const { pool } = await import("../db.ts");
  const user = (await pool.query<{ slack_user: string | null }>("SELECT slack_user FROM people WHERE id = $1", [personId])).rows[0]
    ?.slack_user;
  if (!user) return false;
  const { getTeammate } = await import("../store/teammates.ts");
  const { ownApp } = await import("../ingress/apps.ts");
  const { slack } = await import("../slack/api.ts");
  const peeblo = await getTeammate("peeblo");
  const app = peeblo ? await ownApp(peeblo.id) : null;
  if (!app) return false;
  await slack(app, "chat.postMessage", { channel: user, text });
  return true;
}

type Seen = Record<string, { bad: number; told: boolean }>;
const file = () => join(config.dataDir, "connector-health.json");
const load = (): Seen => {
  try {
    return existsSync(file()) ? JSON.parse(readFileSync(file(), "utf8")) : {};
  } catch {
    return {};
  }
};

const broken = (s: Server) => s.health?.status === "failing" || s.health?.status === "unhealthy";

// One look: what changed since the last one, as messages (kept apart from sending, so it can be tested).
export function compare(seen: Seen, now: Server[]): { seen: Seen; news: string[] } {
  const next: Seen = {};
  const news: string[] = [];
  for (const s of now) {
    const was = seen[s.name] ?? { bad: 0, told: false };
    if (broken(s)) {
      const bad = was.bad + 1;
      const tell = bad >= 2 && !was.told;
      if (tell)
        news.push(
          `The *${s.name}* connector stopped working in Otari: ${healthLine(s)}. Teammates can't use it until it's fixed. Ask me to sign it in again (OAuth, so Otari renews it), or fix it in Otari's MCP servers page.`,
        );
      next[s.name] = { bad, told: was.told || tell };
    } else {
      if (was.told && s.health?.status === "healthy") news.push(`The *${s.name}* connector works again: ${healthLine(s)}.`);
      next[s.name] = { bad: 0, told: false };
    }
  }
  return { seen: next, news };
}

export async function watchOnce(): Promise<string[]> {
  if (!(await session())) return [];
  const r = compare(load(), await servers());
  writeFileSync(file(), JSON.stringify(r.seen, null, 2));
  for (const n of r.news) await tellAdmins(n);
  return r.news;
}

export function watchConnectors(): void {
  setInterval(() => void watchOnce().catch((e) => console.error("connector watch:", (e as Error).message)), 30 * 60_000).unref();
}
