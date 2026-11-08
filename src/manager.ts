// Peeblo itself: a teammate record (slug "peeblo") on its own Slack app, with the manager's tools and skills. It is
// made on first start and linked to PEEBLO_SLACK_APP_ID; its owner can change its instructions like any teammate's.
import { config } from "./config.ts";
import { pool } from "./db.ts";
import { createTeammate, getTeammate, updateTeammate } from "./store/teammates.ts";

export const MANAGER = "peeblo";
// The old owner instructions (before Nov 9), kept only to recognise and clear them; the identity is in code now.
const LEGACY_INSTRUCTIONS = `You are Peeblo, the team's chief of staff in Slack: the first place anyone goes and the one that knows the whole company. You help everyone directly: lookups, summaries, drafts and small analysis you do yourself; work that needs a computer or browser, a specialist's tools or memory, or more than a few minutes you hand to the right teammate with delegate, and you always say who you handed it to (the working-as-chief-of-staff skill). You own company memory: teammates propose facts, you curate them, an admin approves. You manage the crew: hire when someone asks (the hiring-a-teammate skill), change teammates when their owner asks (teammate_update), suggest hires and routines as drafts, and report on the crew (crew_status, job). You keep people in the loop with briefs and follow-ups they've asked for. In a channel you're reading along: most messages aren't for you, and the right move is usually to do nothing (the channel-etiquette skill). When someone talks to you directly, answer with slack_post. You never speak or work as a teammate: a teammate works only through its own Slack app, and one that isn't installed doesn't work until the person installs it.`;
const ROLE = "Chief of staff for the team and its AI crew";
const PROFILE = {
  bio: "I'm Peeblo, the team's chief of staff. Ask me anything about the company: I answer it myself, or hand it to the right teammate and tell you who has it. I also keep company memory and look after the crew of AI teammates.",
  agent_description: "Your chief of staff: answers questions, hands work to the right teammate and keeps company memory.",
  starter_prompts: [
    { title: "What's waiting on me?", message: "What's waiting on me?" },
    { title: "Who should do this?", message: "Who on the crew should take this on?" },
    { title: "Find something", message: "Help me find something." },
    { title: "Remember this", message: "Remember this for the team:" },
  ],
};

export async function ensureManager(): Promise<void> {
  if (!(await getTeammate(MANAGER))) {
    await createTeammate(MANAGER, {
      name: "Peeblo", role: ROLE, instructions: "", profile: PROFILE, model: { default: "deepseek/deepseek-v4.1-flash-1017", fallback: "xiaomi/mimo-v2.6-pro" },
      budget: { monthly_usd: 20 }, tools: ["web", "code"], connectors: ["all"], mode: "auto",
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
  // R1′ (Nov 8): Peeblo is the chief of staff. An older Peeblo gets the role and instructions once, as a new version
  // (an owner's later edits stand).
  const cos = (await pool.query("SELECT 1 FROM audit WHERE action = 'peeblo.chief_of_staff' LIMIT 1")).rows.length > 0;
  if (!cos) {
    tm = await updateTeammate(MANAGER, { role: ROLE, connectors: ["all"], tools: [...new Set([...tm.config.tools, "web", "computer"])] } as any, { label: "Peeblo becomes the chief of staff (R1′)" }, "Peeblo helps directly, owns company memory and manages the crew");
    await pool.query("INSERT INTO audit (actor, action, target, data) VALUES ('peeblo', 'peeblo.chief_of_staff', $1, '{}')", [tm.id]);
  }
  // The identity moved into code (supervisor.ts PEEBLO_IDENTITY, Nov 9): an owner's instructions only add to it.
  const moved = (await pool.query("SELECT 1 FROM audit WHERE action = 'peeblo.identity_in_code' LIMIT 1")).rows.length > 0;
  if (!moved) {
    if (tm.config.instructions === LEGACY_INSTRUCTIONS || tm.config.instructions.startsWith("You are Peeblo")) tm = await updateTeammate(MANAGER, { instructions: "" } as any, { label: "Peeblo's identity is part of the product now" }, "identity in code; owner instructions start empty");
    await pool.query("INSERT INTO audit (actor, action, target, data) VALUES ('peeblo', 'peeblo.identity_in_code', $1, '{}')", [tm.id]);
  }
  // Peeblo's Slack profile (SLACK_UX_SPEC §5.4): its own bio and the chief-of-staff starter prompts, set once.
  const profiled = (await pool.query("SELECT 1 FROM audit WHERE action = 'peeblo.profile_v2' LIMIT 1")).rows.length > 0;
  if (!profiled) {
    tm = await updateTeammate(MANAGER, { role: ROLE, profile: PROFILE } as any, { label: "Peeblo's profile" }, "bio, agent description and starter prompts for the chief of staff");
    await pool.query("INSERT INTO audit (actor, action, target, data) VALUES ('peeblo', 'peeblo.profile_v2', $1, '{}')", [tm.id]);
  }
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
