-- Secrets a teammate's computer can use without ever seeing them: the VM gets a placeholder in an environment
-- variable, and the host swaps in the real value only on requests to the secret's own hosts.
CREATE TABLE IF NOT EXISTS teammate_secrets (
  teammate_id  text NOT NULL REFERENCES teammates(id),
  name         text NOT NULL CHECK (name ~ '^[A-Z][A-Z0-9_]{1,63}$'),
  value        bytea NOT NULL,                         -- sealed
  hosts        text[] NOT NULL CHECK (cardinality(hosts) > 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (teammate_id, name)
);
