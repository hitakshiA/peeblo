-- Teammate computers in layers: L0 base image (pinned per tier by Gondolin buildId), L1 recipe disk (immutable,
-- one per build hash), L2 working disk (resumed from L1, thrown away when L0 or L1 changes), L3 /workspace.
ALTER TABLE environments ADD COLUMN IF NOT EXISTS pins jsonb NOT NULL DEFAULT '{}'::jsonb;        -- {small: buildId, large: buildId}
ALTER TABLE environments ADD COLUMN IF NOT EXISTS l1 jsonb NOT NULL DEFAULT '{}'::jsonb;          -- {small: build_id, large: build_id} in use
ALTER TABLE environments ADD COLUMN IF NOT EXISTS l2 jsonb NOT NULL DEFAULT '{}'::jsonb;          -- {small: {l0, l1}}: what each L2 disk was made from
ALTER TABLE environments ADD COLUMN IF NOT EXISTS l2_reset_at timestamptz;

CREATE TABLE IF NOT EXISTS recipe_builds (
  id           text PRIMARY KEY,
  teammate_id  text NOT NULL REFERENCES teammates(id),
  size         text NOT NULL CHECK (size IN ('small', 'large')),
  hash         text NOT NULL,                         -- build hash: recipe build fields + L0 buildId + runner version
  l0_build_id  text NOT NULL,
  recipe       jsonb NOT NULL,
  status       text NOT NULL CHECK (status IN ('queued', 'building', 'built', 'failed', 'cancelled', 'active', 'superseded')),
  purpose      text NOT NULL DEFAULT 'config' CHECK (purpose IN ('config', 'trial')),
  disk         text,                                  -- host path of recipe-<hash>.qcow2 once built
  bytes        bigint,
  error        text,
  verify       jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX IF NOT EXISTS recipe_builds_teammate ON recipe_builds (teammate_id, size, created_at DESC);
