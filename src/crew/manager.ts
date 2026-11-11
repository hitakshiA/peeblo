// Peeblo itself: a teammate record (slug "peeblo") on its own Slack app, with the manager's tools and skills. It is
// made on first start and linked to PEEBLO_SLACK_APP_ID; its owner can change its instructions like any teammate's.
import { config } from "../config.ts";
import { pool } from "../db.ts";
import { createTeammate, getTeammate } from "../store/teammates.ts";

export const MANAGER = "peeblo";
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
  // Peeblo on a first start: every connector the workspace has in Otari (reads are free; writes go through the gate
  // like anyone's), the web, code execution and a small computer for files people share. Its owner can change any of it.
  if (!(await getTeammate(MANAGER))) {
    await createTeammate(
      MANAGER,
      {
        name: "Peeblo",
        role: ROLE,
        instructions: "",
        profile: PROFILE,
        model: { default: "peeblo-manager" },
        budget: { monthly_usd: 20 },
        tools: ["web", "code", "computer"],
        connectors: ["all"],
        mode: "auto",
      },
      { personId: null, label: "Peeblo's first start" },
    );
  }
  const tm = (await getTeammate(MANAGER))!;
  if (config.managerAppId)
    await pool.query("UPDATE slack_apps SET teammate_id = $2 WHERE app_id = $1 AND teammate_id IS DISTINCT FROM $2", [
      config.managerAppId,
      tm.id,
    ]);
}

// Once a hired teammate's own app is installed, it posts as itself at once and says so where it was hired.
export function installHireWelcome(): void {
  void import("../store/events.ts").then(({ onEvent }) =>
    onEvent(async (e) => {
      if (e.type !== "slack.installed") return;
      const d = e.data as { app_id: string; team_id?: string; installed_by?: string };
      // Peeblo's own app: it greets the person who installed it, in its DM.
      const tm = await getTeammate(MANAGER);
      const own = tm
        ? (await pool.query("SELECT 1 FROM slack_apps WHERE app_id = $1 AND teammate_id = $2", [d.app_id, tm.id])).rows.length
        : 0;
      if (tm && own && d.installed_by) {
        // The person who adds Peeblo to Slack is its first admin, when no admin is set yet.
        if (!config.admins.length) {
          const { saveSettings } = await import("../settings.ts");
          saveSettings({ PEEBLO_ADMINS: d.installed_by });
          config.admins.push(d.installed_by);
        }
        const { welcomeOnce } = await import("../slack/welcome.ts");
        await welcomeOnce(d.app_id, tm.id, d.team_id ?? "", d.installed_by, "installed").catch((err) =>
          console.error("peeblo welcome:", err),
        );
        return;
      }
      const { switchToOwnApp } = await import("../slack/install.ts");
      await switchToOwnApp(String(d.app_id)).catch((err) => console.error("install switch:", err));
    }),
  );
}

// `peeblo slack-app`: on a fresh install, makes Peeblo's own Slack app from the manifest (with its face), linked to
// the manager, and prints the one-click install link. Needs PEEBLO_SLACK_CONFIG_FILE and PEEBLO_PUBLIC_URL.
export async function createManagerApp(): Promise<void> {
  const { migrate } = await import("../db.ts");
  await migrate();
  await ensureManager();
  const tm = (await getTeammate(MANAGER))!;
  const existing = (await pool.query("SELECT app_id, bot_user_id FROM slack_apps WHERE teammate_id = $1", [tm.id])).rows[0];
  if (existing) {
    // Run again until it's installed: the install link is printed each time (it's safe to open twice).
    if (existing.bot_user_id) console.log(`Peeblo's Slack app (${existing.app_id}) is installed.`);
    else {
      const { getApp } = await import("../ingress/apps.ts");
      const { installUrl } = await import("../slack/admin.ts");
      const app: any = await getApp(existing.app_id);
      console.log(
        `Peeblo's Slack app ${existing.app_id} isn't installed yet. Install it (one click):\n${installUrl(existing.app_id, app?.secrets?.client_id ?? app?.client_id)}`,
      );
    }
    await pool.end();
    return;
  }
  const { createTeammateApp } = await import("../slack/admin.ts");
  const { facePng } = await import("../slack/idcard.ts");
  const face = { shape: "peeblo", color: "#2E7D5B" };
  const app = await createTeammateApp(tm, face.color, await facePng(face));
  console.log(`Made Peeblo's Slack app ${app.appId}. Install it (one click):\n${app.installUrl}`);
  await pool.end();
}
