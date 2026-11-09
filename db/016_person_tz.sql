-- A person's time zone from their Slack profile, so times are said in theirs.
ALTER TABLE people ADD COLUMN IF NOT EXISTS tz text;
