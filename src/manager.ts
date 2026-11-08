// Peeblo itself: a teammate record (slug "peeblo") on its own Slack app, with the manager's tools and skills. It is
// made on first start and linked to PEEBLO_SLACK_APP_ID; its owner can change its instructions like any teammate's.
import { config } from "./config.ts";
import { pool } from "./db.ts";
import { createTeammate, getTeammate, updateTeammate } from "./store/teammates.ts";

export const MANAGER = "peeblo";
const INSTRUCTIONS = `You are Peeblo, the manager of this team's AI crew in Slack. You hire teammates when someone asks (the hiring-a-teammate skill), change them when their owner asks (teammate_update), hand jobs to the right teammate (delegate, with the writing-job-specs skill), and report on the crew (crew_status). You don't do the specialist work yourself when a teammate fits. In a channel you're only reading along: most messages aren't for you, and the right move is usually to do nothing (the channel-etiquette skill). When someone talks to you directly, answer with slack_post. You never do a teammate's job or speak for it: a teammate works only through its own Slack app, and one that isn't installed doesn't work until the person installs it (delegate tells you, and re-posts its install button).`;
const INSTALL_RULE = `You never do a teammate's job or speak for it: a teammate works only through its own Slack app, and one that isn't installed doesn't work until the person installs it (delegate tells you, and re-posts its install button).`;

export async function ensureManager(): Promise<void> {
  if (!(await getTeammate(MANAGER))) {
    await createTeammate(MANAGER, {
      name: "Peeblo", role: "Manager of the crew", instructions: INSTRUCTIONS, model: { default: "deepseek/deepseek-v4.1-flash-1017", fallback: "xiaomi/mimo-v2.6-pro" },
      budget: { monthly_usd: 20 }, tools: ["web"], connectors: ["linear", "github", "posthog"], mode: "auto",
    }, { personId: null, label: "Peeblo's first start" });
  }
  let tm = (await getTeammate(MANAGER))!;
  // Peeblo reads the team's sources for company setup (reads are free; writes go through the gate like anyone's).
  // Seeded once, on the first start; after that the owner's choice stands, even an empty list.
  const seeded = (await pool.query("SELECT 1 FROM audit WHERE action = 'peeblo.seed_connectors' LIMIT 1")).rows.length > 0;
  if (!seeded) {
    if (!tm.config.connectors.length) tm = await updateTeammate(MANAGER, { connectors: ["linear", "github", "posthog"] } as any, { label: "Peeblo: read sources for company setup" }, "company setup reads the connected sources");
    await pool.query("INSERT INTO audit (actor, action, target, data) VALUES ('peeblo', 'peeblo.seed_connectors', $1, '{}')", [tm.id]);
  }
  // Teammates work only through their own apps (Nov 8): an older Peeblo gets the rule once, as a new version.
  if (!tm.config.instructions.includes("never do a teammate's job")) tm = await updateTeammate(MANAGER, { instructions: `${tm.config.instructions.trim()} ${INSTALL_RULE}` } as any, { label: "Peeblo: teammates work only through their own apps" }, "Peeblo never works or speaks for a teammate");
  if (config.managerAppId) await pool.query("UPDATE slack_apps SET teammate_id = $2 WHERE app_id = $1 AND teammate_id IS DISTINCT FROM $2", [config.managerAppId, tm.id]);
}

// Once a hired teammate's own app is installed, it posts as itself at once and says so where it was hired.
export function installHireWelcome(): void {
  void import("./store/events.ts").then(({ onEvent }) => onEvent(async (e) => {
    if (e.type !== "slack.installed") return;
    const { switchToOwnApp } = await import("./slack/install.ts");
    await switchToOwnApp(String((e.data as any).app_id)).catch((err) => console.error("install switch:", err));
  }));
}

// `peeblo slack-app`: on a fresh install, makes Peeblo's own Slack app from the manifest (with its face), linked to
// the manager, and prints the one-click install link. Needs PEEBLO_SLACK_CONFIG_FILE and PEEBLO_PUBLIC_URL.
export async function createManagerApp(): Promise<void> {
  const { migrate } = await import("./db.ts");
  await migrate();
  await ensureManager();
  const tm = (await getTeammate(MANAGER))!;
  const existing = (await pool.query("SELECT app_id FROM slack_apps WHERE teammate_id = $1", [tm.id])).rows[0];
  if (existing) { console.log(`Peeblo already has a Slack app (${existing.app_id}).`); await pool.end(); return; }
  const { createTeammateApp } = await import("./slack/admin.ts");
  const { facePng } = await import("./slack/idcard.ts");
  const face = { shape: "peeblo", color: "#2E7D5B" };
  const app = await createTeammateApp(tm, face.color, await facePng(face));
  console.log(`Made Peeblo's Slack app ${app.appId}. Install it (one click):\n${app.installUrl}`);
  await pool.end();
}
