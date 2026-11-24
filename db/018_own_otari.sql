-- A person's own Otari account, connected with Otari's app sign-in (OAuth with PKCE). Their model calls then go
-- out on the key Otari issued them, billed to their account and held to their limits there, not the team's.
CREATE TABLE IF NOT EXISTS person_otari (
  person_id     text PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
  key           bytea NOT NULL,          -- sealed
  key_hint      text NOT NULL,           -- the last 4 characters, to name the key on the person's Otari keys page
  scope         text,
  manage_url    text,
  connected_at  timestamptz NOT NULL DEFAULT now(),
  broken        text                     -- why Otari stopped accepting the key (revoked, expired), when it did
);
-- A sign-in in progress: one per link, for 15 minutes.
CREATE TABLE IF NOT EXISTS otari_connects (
  state       text PRIMARY KEY,
  person_id   text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  verifier    bytea NOT NULL,            -- sealed
  created_at  timestamptz NOT NULL DEFAULT now()
);
