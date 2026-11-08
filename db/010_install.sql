-- Where a hire's ID card and hello message are, so the install button can be added and then marked done.
ALTER TABLE hires ADD COLUMN IF NOT EXISTS card jsonb;   -- {app_id, channel, ts}
ALTER TABLE hires ADD COLUMN IF NOT EXISTS hello jsonb;  -- {app_id, channel, ts}
