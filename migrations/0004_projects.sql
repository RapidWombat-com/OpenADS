-- Projects (stage 9): a workspace groups its connected ad accounts into named
-- projects, and the dashboard reports on one project at a time. Never edit
-- 0001–0003: they are applied on running instances.
--
-- Isolation follows 0001: every row carries workspace_id and child rows use
-- composite foreign keys, so a project can never hold another workspace's
-- account and an assignment can never point at another workspace's project.
-- An account belongs to at most one project (connected_account_id is the key);
-- accounts without a row here are "Unassigned". Deleting a project, an account
-- (rediscovery drops it, or its connection is replaced/disconnected) or the
-- workspace removes the assignments by cascade. Timestamps are epoch ms.

-- Parent key for project_account's composite foreign key (id is already unique).
CREATE UNIQUE INDEX connected_account_workspace_id ON connected_account (workspace_id, id);

CREATE TABLE project (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  -- Trimmed, single-spaced, no control characters (checked by the API).
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  created_at INTEGER NOT NULL,
  UNIQUE (workspace_id, id)
);
-- Names are unique per workspace, ignoring ASCII case.
CREATE UNIQUE INDEX project_workspace_name ON project (workspace_id, name COLLATE NOCASE);

CREATE TABLE project_account (
  -- At most one project per account.
  connected_account_id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (workspace_id, project_id) REFERENCES project (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, connected_account_id) REFERENCES connected_account (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX project_account_project ON project_account (workspace_id, project_id);
