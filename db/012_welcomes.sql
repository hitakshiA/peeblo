-- Who each teammate has welcomed in its DM (the first time a person opens its Messages tab, or the installer).
CREATE TABLE IF NOT EXISTS welcomes (
  app_id     text NOT NULL,
  slack_user text NOT NULL,
  at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, slack_user)
);
