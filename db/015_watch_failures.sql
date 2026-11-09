-- A watch that keeps failing is turned off after 3 tries in a row, and its creator is told.
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS failures int NOT NULL DEFAULT 0;
