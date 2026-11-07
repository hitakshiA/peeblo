-- A large teammate's browser cookies, kept in core (sealed), never on /workspace; injected into new browser
-- sessions and saved back before the computer sleeps.
CREATE TABLE IF NOT EXISTS teammate_browser_state (
  teammate_id  text PRIMARY KEY REFERENCES teammates(id),
  cookies      bytea NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
