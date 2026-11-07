-- Otari admin access and per-teammate keys.

-- The admin's Otari dashboard session (opt-in). Only the cookie is kept, sealed; never the password.
CREATE TABLE IF NOT EXISTS otari_session (
  id           smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  cookie       bytea NOT NULL,                         -- sealed
  signed_in_as text NOT NULL,
  org_id       text NOT NULL,
  workspace_id text NOT NULL,
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);

-- A service key per teammate, with its own spend ceiling in Otari.
CREATE TABLE IF NOT EXISTS teammate_keys (
  teammate_id  text PRIMARY KEY REFERENCES teammates(id),
  key_id       text NOT NULL,
  secret       bytea NOT NULL,                         -- sealed
  budget_id    text,
  ceiling_id   text,
  monthly_usd  numeric,
  created_at   timestamptz NOT NULL DEFAULT now(),
  retired_at   timestamptz
);
