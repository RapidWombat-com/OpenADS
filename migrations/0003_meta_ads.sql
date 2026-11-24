-- Meta Ads self-serve connections (stage 6). Never edit 0001/0002: they are
-- applied on running instances.
--
-- SQLite cannot change a CHECK constraint in place, so `connection`,
-- `connected_account` and `oauth_state` are rebuilt to accept the `meta_ads`
-- provider. Order matters and preserves every existing Google row:
--   1. create the new tables (the new account table references the new
--      connection table) and copy all rows;
--   2. drop the old account table first, then the old connection table, so the
--      DROP's implicit DELETE has no child rows left to cascade into;
--   3. rename; SQLite rewrites the REFERENCES clause of connected_account_v2
--      from connection_v2 to connection; recreate the indexes.

-- ── connection ─────────────────────────────────────────────────────────────
CREATE TABLE connection_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google_ads', 'meta_ads')),
  -- Google: OpenID Connect subject. Meta: app-scoped user ID.
  provider_subject TEXT NOT NULL CHECK (length(provider_subject) BETWEEN 1 AND 255),
  provider_email TEXT CHECK (provider_email IS NULL OR length(provider_email) <= 320),
  -- Display name of the provider account (Meta: the Facebook user's name).
  provider_name TEXT CHECK (provider_name IS NULL OR length(provider_name) <= 256),
  -- "v1.<iv>.<ciphertext>" (base64url), AES-256-GCM, bound to workspace + connection id.
  -- Google: refresh token. Meta: long-lived user access token.
  refresh_token_ciphertext TEXT NOT NULL CHECK (length(refresh_token_ciphertext) BETWEEN 1 AND 8192),
  token_key_id TEXT NOT NULL CHECK (length(token_key_id) BETWEEN 1 AND 64),
  -- When the stored grant stops working (Meta: token or data-access expiry); NULL when unknown/never.
  token_expires_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'error', 'expired')),
  created_by_email TEXT NOT NULL,
  accounts_discovered_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, id)
);
INSERT INTO connection_v2 (id, workspace_id, provider, provider_subject, provider_email, provider_name,
    refresh_token_ciphertext, token_key_id, token_expires_at, status, created_by_email, accounts_discovered_at,
    created_at, updated_at)
  SELECT id, workspace_id, provider, provider_subject, provider_email, NULL,
    refresh_token_ciphertext, token_key_id, NULL, status, created_by_email, accounts_discovered_at,
    created_at, updated_at
  FROM connection;

-- ── connected_account ──────────────────────────────────────────────────────
CREATE TABLE connected_account_v2 (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  -- Google Ads customer ID or Meta ad account ID (without "act_"), digits only.
  customer_id TEXT NOT NULL CHECK (length(customer_id) BETWEEN 1 AND 20 AND customer_id NOT GLOB '*[^0-9]*'),
  descriptive_name TEXT CHECK (descriptive_name IS NULL OR length(descriptive_name) <= 1024),
  currency_code TEXT CHECK (currency_code IS NULL OR length(currency_code) = 3),
  time_zone TEXT CHECK (time_zone IS NULL OR length(time_zone) <= 64),
  is_manager INTEGER NOT NULL CHECK (is_manager IN (0, 1)),
  -- Google statuses, plus Meta's account_status values (1 ACTIVE is stored as ENABLED).
  account_status TEXT NOT NULL CHECK (account_status IN ('ENABLED', 'CANCELED', 'SUSPENDED', 'CLOSED', 'UNKNOWN',
    'UNREADABLE', 'DISABLED', 'UNSETTLED', 'PENDING_RISK_REVIEW', 'PENDING_SETTLEMENT', 'IN_GRACE_PERIOD', 'PENDING_CLOSURE')),
  login_customer_id TEXT NOT NULL CHECK (length(login_customer_id) BETWEEN 1 AND 20 AND login_customer_id NOT GLOB '*[^0-9]*'),
  manager_customer_id TEXT CHECK (manager_customer_id IS NULL OR (length(manager_customer_id) BETWEEN 1 AND 20 AND manager_customer_id NOT GLOB '*[^0-9]*')),
  -- Meta: the business portfolio that owns the ad account, when Meta returns it.
  business_id TEXT CHECK (business_id IS NULL OR (length(business_id) BETWEEN 1 AND 32 AND business_id NOT GLOB '*[^0-9]*')),
  business_name TEXT CHECK (business_name IS NULL OR length(business_name) <= 1024),
  eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
  selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1) AND (selected = 0 OR eligible = 1)),
  discovered_at INTEGER NOT NULL,
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connection_v2 (workspace_id, id) ON DELETE CASCADE,
  UNIQUE (connection_id, customer_id)
);
INSERT INTO connected_account_v2 (id, workspace_id, connection_id, customer_id, descriptive_name, currency_code,
    time_zone, is_manager, account_status, login_customer_id, manager_customer_id, business_id, business_name,
    eligible, selected, discovered_at)
  SELECT id, workspace_id, connection_id, customer_id, descriptive_name, currency_code,
    time_zone, is_manager, account_status, login_customer_id, manager_customer_id, NULL, NULL,
    eligible, selected, discovered_at
  FROM connected_account;

DROP TABLE connected_account;
DROP TABLE connection;
ALTER TABLE connection_v2 RENAME TO connection;
ALTER TABLE connected_account_v2 RENAME TO connected_account;
CREATE UNIQUE INDEX connection_workspace_provider ON connection (workspace_id, provider);
CREATE INDEX connected_account_workspace ON connected_account (workspace_id, connection_id, selected);

-- ── oauth_state ────────────────────────────────────────────────────────────
-- Meta's confidential web flow has no PKCE verifier, so code_verifier may be NULL.
CREATE TABLE oauth_state_v2 (
  state_hash TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google_ads', 'meta_ads')),
  code_verifier TEXT CHECK (code_verifier IS NULL OR length(code_verifier) BETWEEN 43 AND 128),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at AND expires_at - created_at <= 600000)
);
INSERT INTO oauth_state_v2 (state_hash, workspace_id, email, provider, code_verifier, created_at, expires_at)
  SELECT state_hash, workspace_id, email, provider, code_verifier, created_at, expires_at FROM oauth_state;
DROP TABLE oauth_state;
ALTER TABLE oauth_state_v2 RENAME TO oauth_state;
CREATE INDEX oauth_state_expiry ON oauth_state (expires_at);
CREATE INDEX oauth_state_owner ON oauth_state (workspace_id, email, provider);

-- ── meta_setup ─────────────────────────────────────────────────────────────
-- Instance-level Meta Ads setup (self-hosting): the operator's own Meta app,
-- entered in the setup wizard, the wizard's saved progress and the conversion
-- action type reported as "conversions". One row per instance (id = 1).
-- Deployment env vars META_APP_ID / META_APP_SECRET, when set, take precedence
-- over the stored app; META_CONVERSION_ACTION_TYPE over the stored action type.
-- The App Secret is stored only as AES-GCM ciphertext (TOKEN_ENCRYPTION_KEY).
CREATE TABLE meta_setup (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  -- Meta App ID (numeric): builds App Dashboard links and the OAuth client_id.
  app_id TEXT CHECK (app_id IS NULL OR (length(app_id) BETWEEN 5 AND 20 AND app_id NOT GLOB '*[^0-9]*')),
  -- Steps the admin marked as done in the wizard (epoch ms), NULL when not done.
  app_created_at INTEGER,
  login_configured_at INTEGER,
  access_confirmed_at INTEGER,
  app_secret_ciphertext TEXT CHECK (app_secret_ciphertext IS NULL OR length(app_secret_ciphertext) <= 2048),
  app_secret_key_id TEXT,
  app_secret_last4 TEXT CHECK (app_secret_last4 IS NULL OR length(app_secret_last4) = 4),
  app_secret_updated_by TEXT,
  app_secret_updated_at INTEGER,
  -- Exact Meta action_type counted as "conversions"; NULL means the default (purchase).
  conversion_action_type TEXT CHECK (conversion_action_type IS NULL OR length(conversion_action_type) BETWEEN 1 AND 128),
  updated_at INTEGER NOT NULL,
  -- A secret is only ever stored together with the App ID it belongs to.
  CHECK ((app_secret_ciphertext IS NULL) = (app_secret_key_id IS NULL)
    AND (app_secret_ciphertext IS NULL) = (app_secret_last4 IS NULL)
    AND (app_secret_ciphertext IS NULL OR app_id IS NOT NULL))
);
