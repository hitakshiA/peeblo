-- Test and check teammates are hidden from crew lists by a flag, not by their slug.
ALTER TABLE teammates ADD COLUMN IF NOT EXISTS hidden boolean NOT NULL DEFAULT false;
UPDATE teammates SET hidden = true WHERE (slug LIKE 'eval-%' OR slug LIKE 'vm-%' OR slug LIKE '%-check' OR slug LIKE 'rail-%') AND NOT hidden;
