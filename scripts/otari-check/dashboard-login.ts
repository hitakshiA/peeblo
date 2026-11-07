// The Otari dashboard login for the admin checks. If OTARI_DASHBOARD_EMAIL / OTARI_DASHBOARD_PASSWORD are unset,
// they are read from a gitignored JSON file ({email, password}): PEEBLO_DASHBOARD_LOGIN_FILE, or
// local/secrets/otari-dashboard-login.json in the repo. Values go into this process's environment only (child
// check processes inherit them); they are never printed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function loadDashboardLogin(): boolean {
  if (process.env.OTARI_DASHBOARD_EMAIL && process.env.OTARI_DASHBOARD_PASSWORD) return true;
  const file = process.env.PEEBLO_DASHBOARD_LOGIN_FILE || join(import.meta.dirname, "../../local/secrets/otari-dashboard-login.json");
  if (!existsSync(file)) return false;
  const j = JSON.parse(readFileSync(file, "utf8")) as { email?: string; password?: string };
  if (!j.email || !j.password) return false;
  process.env.OTARI_DASHBOARD_EMAIL = j.email;
  process.env.OTARI_DASHBOARD_PASSWORD = j.password;
  return true;
}
