-- Pending reconnect as another provider identity (stage 12). Never edit
-- 0001–0006: they are applied on running instances.
--
-- When an admin reconnects Google Ads or Meta Ads and signs in as a different
-- Google account / Facebook user than the stored connection, the new grant is
-- not applied right away (that used to delete every account, selection and
-- project assignment of the old connection). It waits here, encrypted, for at
-- most 10 minutes, while Sources shows what the change keeps and removes. On
-- confirm the connection row is updated in place (same id), so accounts the new
-- login also discovers keep their row, selection and project; cancel or expiry
-- deletes the row. At most one pending change per workspace and provider.
CREATE TABLE pending_connection (
  -- Random id; part of the encryption context of token_ciphertext.
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google_ads', 'meta_ads')),
  -- The connection (and its provider identity) this change would replace.
  replaces_connection_id TEXT NOT NULL,
  replaces_subject TEXT NOT NULL CHECK (length(replaces_subject) BETWEEN 1 AND 255),
  -- The new provider identity (Google: OIDC subject and email; Meta: app-scoped user ID and name).
  provider_subject TEXT NOT NULL CHECK (length(provider_subject) BETWEEN 1 AND 255),
  provider_email TEXT CHECK (provider_email IS NULL OR length(provider_email) <= 320),
  provider_name TEXT CHECK (provider_name IS NULL OR length(provider_name) <= 256),
  -- "v1.<iv>.<ciphertext>", AES-256-GCM, bound to workspace + this row's id (not a connection id).
  token_ciphertext TEXT NOT NULL CHECK (length(token_ciphertext) BETWEEN 1 AND 8192),
  token_key_id TEXT NOT NULL CHECK (length(token_key_id) BETWEEN 1 AND 64),
  token_expires_at INTEGER,
  -- JSON: the accounts the new login discovered ({ accounts, incompleteLogins }).
  discovery TEXT NOT NULL CHECK (length(discovery) BETWEEN 2 AND 2000000),
  created_by_email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at AND expires_at - created_at <= 600000),
  UNIQUE (workspace_id, provider),
  -- Disconnecting (deleting) the connection discards its pending change too.
  FOREIGN KEY (workspace_id, replaces_connection_id) REFERENCES connection (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX pending_connection_expiry ON pending_connection (expires_at);
CREATE INDEX pending_connection_replaces ON pending_connection (workspace_id, replaces_connection_id);
