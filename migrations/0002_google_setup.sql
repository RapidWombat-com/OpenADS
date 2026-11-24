-- Instance-level Google Ads setup (self-hosting): the operator's own Google
-- OAuth client, entered in the setup wizard, and the wizard's saved progress.
-- One row per instance (id = 1). Deployment env vars GOOGLE_OAUTH_CLIENT_ID /
-- GOOGLE_OAUTH_CLIENT_SECRET, when set, take precedence over the stored client.
-- The client secret is stored only as AES-GCM ciphertext (TOKEN_ENCRYPTION_KEY);
-- its last four characters are kept for display, as Google Cloud does.

CREATE TABLE google_setup (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  -- Google Cloud project ID, used only to build console links.
  project_id TEXT CHECK (project_id IS NULL OR (length(project_id) BETWEEN 6 AND 30 AND project_id NOT GLOB '*[^a-z0-9-]*')),
  -- Steps the admin marked as done in the wizard (epoch ms), NULL when not done.
  api_enabled_at INTEGER,
  explorer_requested_at INTEGER,
  consent_configured_at INTEGER,
  client_created_at INTEGER,
  client_id TEXT CHECK (client_id IS NULL OR length(client_id) BETWEEN 30 AND 255),
  client_secret_ciphertext TEXT CHECK (client_secret_ciphertext IS NULL OR length(client_secret_ciphertext) <= 2048),
  client_secret_key_id TEXT,
  client_secret_last4 TEXT CHECK (client_secret_last4 IS NULL OR length(client_secret_last4) = 4),
  client_updated_by TEXT,
  client_updated_at INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK ((client_id IS NULL) = (client_secret_ciphertext IS NULL)
    AND (client_id IS NULL) = (client_secret_key_id IS NULL)
    AND (client_id IS NULL) = (client_secret_last4 IS NULL))
);
