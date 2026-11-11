// Who may do what. Checked in code on every call that changes something; the model never decides it.
// Otari admins are listed in PEEBLO_ADMINS (Slack user ids) until workspace roles come from Slack.
import { config } from "../config.ts";
import type { Person } from "../store/people.ts";
import type { Teammate } from "../store/teammates.ts";

export const isOtariAdmin = (p: Person | null): boolean => Boolean(p?.slack_user && config.admins.includes(p.slack_user));
const isOwner = (tm: Teammate, p: Person | null): boolean => Boolean(p && tm.owner_person && tm.owner_person === p.id);
export const mayManageTeammate = (tm: Teammate, p: Person | null): boolean => isOwner(tm, p) || isOtariAdmin(p);
