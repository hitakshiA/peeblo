// People are joined on Slack team + user id, never on display names.
import { pool } from "../db.ts";
import { newId } from "../ids.ts";

export type Person = { id: string; slack_team: string | null; slack_user: string | null; email: string | null; display_name: string | null; end_user_id: string | null };

export async function personForSlack(team: string, user: string, extra: { email?: string; displayName?: string } = {}): Promise<Person> {
  const { rows } = await pool.query<Person>(
    `INSERT INTO people (id, slack_team, slack_user, email, display_name, end_user_id) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (slack_team, slack_user) DO UPDATE SET email = COALESCE(EXCLUDED.email, people.email), display_name = COALESCE(EXCLUDED.display_name, people.display_name)
     RETURNING *`,
    [newId("pe"), team, user, extra.email ?? null, extra.displayName ?? null, `slack-${team}-${user}`],
  );
  return rows[0];
}

export async function getPerson(id: string): Promise<Person | null> {
  const { rows } = await pool.query<Person>("SELECT * FROM people WHERE id = $1", [id]);
  return rows[0] ?? null;
}
