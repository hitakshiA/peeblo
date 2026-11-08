-- The person's own request when a schedule or trigger was set up: the reviewer's source of intent for its runs
-- (the stored prompt is written by the agent and is never consent, K11).
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS origin_request text;
