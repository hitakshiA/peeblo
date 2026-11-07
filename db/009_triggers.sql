-- Schedules and triggers (K11): durable prompts the agent writes. kind: cron (recurring), once (a single time),
-- webhook (a signed event on /hooks/<teammate>/<id>), watch (a connector read polled on a timer; it wakes the teammate
-- only when the result changed). output_to is where results go (the origin, or a public channel it's in).
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'cron' CHECK (kind IN ('cron', 'once', 'webhook', 'watch'));
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS run_at timestamptz;                  -- once
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS output_to jsonb NOT NULL DEFAULT '{}';
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS budget_usd numeric NOT NULL DEFAULT 0.05;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS filter jsonb NOT NULL DEFAULT '{}';  -- webhook: event filter
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS watch jsonb;                         -- watch: {server, tool, arguments}
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS state_hash text;                     -- watch / cursor: last state
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS secret bytea;                        -- webhook: sealed signing secret
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS last_run_at timestamptz;
ALTER TABLE schedules ALTER COLUMN cron DROP NOT NULL;
