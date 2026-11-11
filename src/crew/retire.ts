// Retiring a teammate (the fire path): its Otari key, spend ceiling and budget are removed, its Slack app is
// uninstalled from the workspace (the app itself is kept), its schedules stop, its sessions close, and the record is
// archived (kept for receipts and history, never deleted). Peeblo itself can't be retired.
import { pool } from "../db.ts";
import { appendEvent } from "../store/events.ts";
import { getTeammate } from "../store/teammates.ts";

export async function retireTeammate(slugOrId: string, by: { personId: string | null; label: string }): Promise<{ ok: boolean; steps: string[] }> {
  const tm = await getTeammate(slugOrId);
  if (!tm) return { ok: false, steps: [`no live teammate ${slugOrId}`] };
  if (tm.slug === "peeblo") return { ok: false, steps: ["Peeblo can't be retired"] };
  const steps: string[] = [];
  // Otari: key, ceiling, budget (fails loudly; a teammate isn't archived while its key still spends).
  const { retireTeammateKey } = await import("../otari/spend.ts");
  await retireTeammateKey(tm.id);
  steps.push("Otari key, ceiling and budget removed");
  // Slack: uninstall each of its apps from the workspace.
  const { getApp } = await import("../ingress/apps.ts");
  for (const r of (await pool.query("SELECT app_id FROM slack_apps WHERE teammate_id = $1", [tm.id])).rows) {
    const app = await getApp(r.app_id);
    if (!app?.secrets.bot_token) { steps.push(`${r.app_id}: not installed`); continue; }
    const res: any = await (await fetch("https://slack.com/api/apps.uninstall", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: app.secrets.bot_token, client_id: app.secrets.client_id, client_secret: app.secrets.client_secret }) })).json();
    steps.push(`${r.app_id}: ${res.ok ? "uninstalled" : `uninstall refused (${res.error})`}`);
  }
  await pool.query("UPDATE schedules SET enabled = false WHERE teammate_id = $1 AND enabled", [tm.id]);
  await pool.query("UPDATE sessions SET status = 'closed' WHERE teammate_id = $1 AND status = 'open'", [tm.id]);
  await pool.query("UPDATE teammates SET archived_at = now() WHERE id = $1", [tm.id]);
  steps.push("schedules stopped, sessions closed, record archived");
  await pool.query("INSERT INTO audit (actor, action, target, data) VALUES ($1, 'teammate.retired', $2, $3)", [by.personId ?? "peeblo", tm.id, { by: by.label, steps }]);
  await appendEvent({ type: "teammate.retired", data: { teammate_id: tm.id, slug: tm.slug, by: by.personId, steps } });
  return { ok: true, steps };
}
