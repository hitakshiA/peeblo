-- A paused teammate doesn't run (its owner pauses it from App Home); the run rail checks this.
ALTER TABLE teammates ADD COLUMN IF NOT EXISTS paused_at timestamptz;
