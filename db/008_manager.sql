-- The Slack app configuration token (sealed), used to make teammate apps; and hires that wait for their app install.
CREATE TABLE IF NOT EXISTS slack_config (id int PRIMARY KEY DEFAULT 1, token bytea NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS hires (
  teammate_id  text PRIMARY KEY REFERENCES teammates(id),
  app_id       text,
  install_url  text,
  hired_by     text REFERENCES people(id),
  place        jsonb NOT NULL DEFAULT '{}',          -- the Slack thread the hire happened in
  avatar       jsonb NOT NULL DEFAULT '{}',          -- {shape, color}
  installed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- Per-channel attention for Peeblo (K2): listen (the channel session reads and decides), mentions (only when tagged), off.
CREATE TABLE IF NOT EXISTS channel_settings (
  team_id    text NOT NULL,
  channel    text NOT NULL,
  attention  text NOT NULL DEFAULT 'listen' CHECK (attention IN ('listen', 'mentions', 'off')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, channel)
);
