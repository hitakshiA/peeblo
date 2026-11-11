// Slack apps known to this Peeblo: Peeblo's own and one per teammate. Credentials are sealed at rest.
import { pool } from "../db.ts";
import { seal, unseal } from "../crypto.ts";

export type AppSecrets = { signing_secret: string; client_id: string; client_secret: string; bot_token?: string };
export type SlackApp = { app_id: string; teammate_id: string | null; team_id: string | null; bot_user_id: string | null; secrets: AppSecrets };

const cache = new Map<string, { at: number; app: SlackApp | null }>();

export async function getApp(appId: string): Promise<SlackApp | null> {
  const hit = cache.get(appId);
  if (hit && Date.now() - hit.at < 30_000) return hit.app;
  const { rows } = await pool.query<{ app_id: string; teammate_id: string | null; team_id: string | null; bot_user_id: string | null; secrets: Buffer }>(
    "SELECT app_id, teammate_id, team_id, bot_user_id, secrets FROM slack_apps WHERE app_id = $1",
    [appId],
  );
  const app = rows[0] ? { ...rows[0], secrets: unseal<AppSecrets>(rows[0].secrets) } : null;
  cache.set(appId, { at: Date.now(), app });
  return app;
}

export async function saveApp(a: { app_id: string; teammate_id?: string | null; team_id?: string | null; bot_user_id?: string | null; secrets: AppSecrets }): Promise<void> {
  await pool.query(
    `INSERT INTO slack_apps (app_id, teammate_id, team_id, bot_user_id, secrets) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (app_id) DO UPDATE SET teammate_id = EXCLUDED.teammate_id, team_id = COALESCE(EXCLUDED.team_id, slack_apps.team_id),
       bot_user_id = COALESCE(EXCLUDED.bot_user_id, slack_apps.bot_user_id), secrets = EXCLUDED.secrets`,
    [a.app_id, a.teammate_id ?? null, a.team_id ?? null, a.bot_user_id ?? null, seal(a.secrets)],
  );
  cache.delete(a.app_id);
}

// A teammate's own Slack app with a bot token, in the given workspace (any workspace when none is given).
export async function ownApp(teammateId: string, team?: string): Promise<string | null> {
  const ids = (await pool.query("SELECT app_id FROM slack_apps WHERE teammate_id = $1", [teammateId])).rows.map((r) => r.app_id);
  for (const id of ids) { const a = await getApp(id); if (a?.secrets.bot_token && (team === undefined || a.team_id === team)) return id; }
  return null;
}

export async function listApps(): Promise<Omit<SlackApp, "secrets">[]> {
  const { rows } = await pool.query("SELECT app_id, teammate_id, team_id, bot_user_id, created_at FROM slack_apps ORDER BY created_at");
  return rows;
}
