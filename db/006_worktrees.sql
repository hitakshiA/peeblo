-- Session worktrees: one per (session, repo), with the checkout on the VM disk and git's objects on /workspace.
CREATE TABLE IF NOT EXISTS session_worktrees (
  session_id   text NOT NULL REFERENCES sessions(id),
  teammate_id  text NOT NULL REFERENCES teammates(id),
  repo         text NOT NULL,
  branch       text NOT NULL,
  base         text NOT NULL,
  base_commit  text,
  path         text NOT NULL,                          -- guest path, /work/<session>/<repo>
  published    boolean NOT NULL DEFAULT false,
  pr_url       text,
  setup_hash   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  removed_at   timestamptz,
  PRIMARY KEY (session_id, repo)
);
CREATE INDEX IF NOT EXISTS session_worktrees_teammate ON session_worktrees (teammate_id) WHERE removed_at IS NULL;
