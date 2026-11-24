-- OpenADS self-serve connections (docs/connections-design.md, first slice).
-- Every row that belongs to a tenant carries workspace_id, and child rows use
-- composite foreign keys so a row can never point at another workspace's parent.
-- Timestamps are Unix epoch milliseconds. Provider credentials are stored only
-- as AES-GCM ciphertext (see src/lib/crypto.ts); OAuth state values only as hashes.

CREATE TABLE workspace (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  -- First version: one default workspace, bootstrapped by the first admin visit.
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX workspace_single_default ON workspace (is_default) WHERE is_default = 1;

CREATE TABLE membership (
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  -- Verified Cloudflare Access email, ASCII-lowercased.
  email TEXT NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, email)
);
CREATE INDEX membership_email ON membership (email);

CREATE TABLE connection (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google_ads')),
  -- OpenID Connect subject and email of the Google account that granted access.
  provider_subject TEXT NOT NULL CHECK (length(provider_subject) BETWEEN 1 AND 255),
  provider_email TEXT CHECK (provider_email IS NULL OR length(provider_email) <= 320),
  -- "v1.<iv>.<ciphertext>" (base64url), AES-256-GCM, bound to workspace + connection id.
  refresh_token_ciphertext TEXT NOT NULL CHECK (length(refresh_token_ciphertext) BETWEEN 1 AND 8192),
  token_key_id TEXT NOT NULL CHECK (length(token_key_id) BETWEEN 1 AND 64),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'error')),
  created_by_email TEXT NOT NULL,
  -- Last successful account discovery; NULL until one succeeds.
  accounts_discovered_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, id)
);
-- First version: at most one grant per provider per workspace.
CREATE UNIQUE INDEX connection_workspace_provider ON connection (workspace_id, provider);

CREATE TABLE connected_account (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  -- Google Ads customer ID, digits only.
  customer_id TEXT NOT NULL CHECK (length(customer_id) BETWEEN 1 AND 20 AND customer_id NOT GLOB '*[^0-9]*'),
  descriptive_name TEXT CHECK (descriptive_name IS NULL OR length(descriptive_name) <= 1024),
  currency_code TEXT CHECK (currency_code IS NULL OR length(currency_code) = 3),
  time_zone TEXT CHECK (time_zone IS NULL OR length(time_zone) <= 64),
  is_manager INTEGER NOT NULL CHECK (is_manager IN (0, 1)),
  account_status TEXT NOT NULL CHECK (account_status IN ('ENABLED', 'CANCELED', 'SUSPENDED', 'CLOSED', 'UNKNOWN', 'UNREADABLE')),
  -- Customer ID sent as login-customer-id (the accessible root: itself or its manager).
  login_customer_id TEXT NOT NULL CHECK (length(login_customer_id) BETWEEN 1 AND 20 AND login_customer_id NOT GLOB '*[^0-9]*'),
  -- Manager through which the account was discovered; NULL for direct access.
  manager_customer_id TEXT CHECK (manager_customer_id IS NULL OR (length(manager_customer_id) BETWEEN 1 AND 20 AND manager_customer_id NOT GLOB '*[^0-9]*')),
  eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
  selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1) AND (selected = 0 OR eligible = 1)),
  discovered_at INTEGER NOT NULL,
  FOREIGN KEY (workspace_id, connection_id) REFERENCES connection (workspace_id, id) ON DELETE CASCADE,
  UNIQUE (connection_id, customer_id)
);
CREATE INDEX connected_account_workspace ON connected_account (workspace_id, connection_id, selected);

CREATE TABLE oauth_state (
  -- SHA-256 (base64url) of the random state; the state itself is never stored.
  state_hash TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google_ads')),
  code_verifier TEXT NOT NULL CHECK (length(code_verifier) BETWEEN 43 AND 128),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at AND expires_at - created_at <= 600000)
);
CREATE INDEX oauth_state_expiry ON oauth_state (expires_at);
CREATE INDEX oauth_state_owner ON oauth_state (workspace_id, email, provider);
