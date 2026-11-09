-- A recurring routine's time zone (the person's who set it), so "every Monday at 9" stays at 9 across
-- daylight-saving changes. Empty: UTC.
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS tz text;
