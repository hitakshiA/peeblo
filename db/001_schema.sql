-- Peeblo's own tables. DBOS keeps its workflow state in the separate "dbos" schema.
-- The events table is the source of truth; turns, steps, queues and receipts are views over it.

CREATE TABLE IF NOT EXISTS teammates (
  id           text PRIMARY KEY,                       -- tm_<random>
  slug         text NOT NULL UNIQUE,                   -- "sprout"
  owner_person text,                                   -- people.id of the hirer
  version      integer NOT NULL DEFAULT 1,             -- current config version
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Identity and instructions are versioned config the agent can't edit: every change is a new row.
CREATE TABLE IF NOT EXISTS teammate_versions (
  teammate_id text NOT NULL REFERENCES teammates(id),
  version     integer NOT NULL,
  config      jsonb NOT NULL,
  changed_by  text NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (teammate_id, version)
);

-- People join on Slack user id + team, never on display names.
CREATE TABLE IF NOT EXISTS people (
  id            text PRIMARY KEY,                      -- pe_<random>
  slack_team    text,
  slack_user    text,
  email         text,
  display_name  text,
  end_user_id   text,                                  -- the person's id at the model gateway
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (slack_team, slack_user)
);

-- A teammate is reachable through sessions: a desk, a channel, a thread, a DM, or the API.
CREATE TABLE IF NOT EXISTS sessions (
  id            text PRIMARY KEY,                      -- se_<random>
  teammate_id   text NOT NULL REFERENCES teammates(id),
  kind          text NOT NULL CHECK (kind IN ('desk', 'channel', 'thread', 'dm', 'api')),
  place_key     text NOT NULL,                         -- e.g. "C123:1794040871.320069" or "api:<id>"
  place         jsonb NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (teammate_id, kind, place_key)
);

-- One thing someone asked for. request_id makes a retried delivery a no-op.
CREATE TABLE IF NOT EXISTS submissions (
  id          text PRIMARY KEY,                        -- su_<random>
  session_id  text NOT NULL REFERENCES sessions(id),
  person_id   text REFERENCES people(id),
  chain_id    text,
  request_id  text NOT NULL UNIQUE,
  text        text NOT NULL,
  source      text NOT NULL,                           -- api | slack | schedule | teammate
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- One attempt to act on a submission. DBOS drives it; the workflow id equals the run id.
CREATE TABLE IF NOT EXISTS runs (
  id            text PRIMARY KEY,                      -- ru_<random>
  submission_id text NOT NULL REFERENCES submissions(id),
  session_id    text NOT NULL REFERENCES sessions(id),
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'waiting', 'done', 'failed', 'cancelled')),
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz
);

-- Append-only. Nothing updates or deletes rows here.
CREATE TABLE IF NOT EXISTS events (
  id          bigserial PRIMARY KEY,
  session_id  text REFERENCES sessions(id),
  run_id      text REFERENCES runs(id),
  type        text NOT NULL,                           -- run.started, turn.started, step.*, model.call, run.finished, ...
  data        jsonb NOT NULL DEFAULT '{}',
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_run ON events (run_id, id);
CREATE INDEX IF NOT EXISTS events_session ON events (session_id, id);
CREATE INDEX IF NOT EXISTS events_type ON events (type, at);

CREATE OR REPLACE FUNCTION events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'events are append-only'; END $$;
DROP TRIGGER IF EXISTS events_no_change ON events;
CREATE TRIGGER events_no_change BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION events_append_only();

-- Views over the log.
CREATE OR REPLACE VIEW turns AS
  SELECT run_id, session_id, (data->>'turn')::int AS turn, min(at) AS started_at, max(at) AS last_at
  FROM events WHERE data ? 'turn' GROUP BY run_id, session_id, (data->>'turn')::int;
CREATE OR REPLACE VIEW steps AS
  SELECT id, run_id, session_id, (data->>'turn')::int AS turn, type, data, at
  FROM events WHERE type LIKE 'step.%';

-- A teammate's computer.
CREATE TABLE IF NOT EXISTS environments (
  teammate_id  text PRIMARY KEY REFERENCES teammates(id),
  size         text NOT NULL DEFAULT 'small' CHECK (size IN ('small', 'large')),
  state        text NOT NULL DEFAULT 'asleep' CHECK (state IN ('asleep', 'booting', 'awake')),
  vm_id        text,
  workspace    text NOT NULL,                          -- host path mounted at /workspace
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Teammate-to-teammate work hangs off a chain; the person at the root pays.
CREATE TABLE IF NOT EXISTS chains (
  id             text PRIMARY KEY,                     -- ch_<random>
  root_person_id text REFERENCES people(id),
  root_session_id text REFERENCES sessions(id),
  depth          integer NOT NULL DEFAULT 0,
  spend_cap_usd  numeric,
  stopped_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- An approval is a paused run. The Slack card is only a view of this row.
CREATE TABLE IF NOT EXISTS approvals (
  id           text PRIMARY KEY,                       -- ap_<random>
  run_id       text NOT NULL REFERENCES runs(id),
  fingerprint  text NOT NULL,                          -- hash of the exact action
  action       jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  scope        text CHECK (scope IN ('once', 'job', 'always')),
  decided_by   text REFERENCES people(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  decided_at   timestamptz
);

CREATE TABLE IF NOT EXISTS grants (
  id           text PRIMARY KEY,                       -- gr_<random>
  teammate_id  text NOT NULL REFERENCES teammates(id),
  fingerprint  text NOT NULL,
  scope        text NOT NULL CHECK (scope IN ('job', 'always')),
  run_id       text REFERENCES runs(id),               -- set for job grants
  granted_by   text REFERENCES people(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz
);

-- Schedules are stored records that post submissions into a session.
CREATE TABLE IF NOT EXISTS schedules (
  id           text PRIMARY KEY,                       -- sc_<random>
  teammate_id  text NOT NULL REFERENCES teammates(id),
  session_id   text NOT NULL REFERENCES sessions(id),
  cron         text NOT NULL,
  prompt       text NOT NULL,
  created_by   text REFERENCES people(id),
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit (
  id      bigserial PRIMARY KEY,
  actor   text NOT NULL,
  action  text NOT NULL,
  target  text,
  data    jsonb NOT NULL DEFAULT '{}',
  at      timestamptz NOT NULL DEFAULT now()
);

-- Slack apps (Peeblo's and one per teammate) and the claim that makes one human message count once.
CREATE TABLE IF NOT EXISTS slack_apps (
  app_id        text PRIMARY KEY,
  teammate_id   text REFERENCES teammates(id),        -- null for Peeblo's own app
  team_id       text,
  bot_user_id   text,
  secrets       bytea NOT NULL,                        -- AES-GCM sealed JSON: signing secret, client secret, bot token
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS slack_claims (
  team_id    text NOT NULL,
  channel    text NOT NULL,
  ts         text NOT NULL,
  app_id     text NOT NULL,
  event_type text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, channel, ts)
);
