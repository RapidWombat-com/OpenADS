-- Deploy key claim (stage 11). Never edit 0001–0005: they are applied on
-- running instances.
--
-- Written only by `npm run deploy:cloudflare`, never by the app. Before a deploy
-- uploads a TOKEN_ENCRYPTION_KEY to a Worker that has none, it claims the key's
-- id here with `INSERT … WHERE NOT EXISTS` and reads the row back: the first
-- deploy wins, and a concurrent deploy from another checkout or machine (which
-- generated a different key) sees another id and stops before deploying, so the
-- Worker never ends up with a key other than the one that was claimed (and
-- backed up). `--reset-encrypted-data` clears the claim with the data.
CREATE TABLE instance_meta (
  key TEXT PRIMARY KEY NOT NULL CHECK (key IN ('token_key_id')),
  -- Key id of TOKEN_ENCRYPTION_KEY (src/lib/crypto.ts importTokenKey): k1-<16 hex>.
  value TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 64),
  updated_at INTEGER NOT NULL
);
