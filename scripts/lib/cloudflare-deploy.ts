// One-command Cloudflare self-host deploy for OpenADS (scripts/deploy-cloudflare.mjs).
// Pure parts (env validation, config generation, probe classification) and an
// orchestrator whose side effects all go through injected functions (command
// runner, files, fetch), so `--plan` and the tests can prove nothing mutates.
// Commands are argument arrays for `npx --no-install wrangler`; never a shell string.
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { posix } from 'node:path';
import { parseEnv } from 'node:util';
import {
  isAllowedEmail, parseAllowlist, parseExactAddresses, validAudience, validTeamHostname,
} from '../../src/lib/access.ts';
import { googleApiVersion, publicOrigin } from '../../src/lib/config.ts';
import { importTokenKey } from '../../src/lib/crypto.ts';
import { metaApiVersion, validActionType, validMetaAppId, validMetaAppSecret } from '../../src/lib/meta-ads/config.ts';

export const MIN_NODE = [26, 13] as const;
export const DEFAULT_ENV_FILE = 'deploy/.env.cloudflare';
export const CONFIG_DIR = '.openads';
export const CONFIG_PATH = `${CONFIG_DIR}/wrangler.deploy.jsonc`;
export const BUILT_CONFIG = 'dist/server/wrangler.json';
export const KEY_SECRET = 'TOKEN_ENCRYPTION_KEY';
/**
 * Where a generated key is backed up (0600, ignored by git) for the operator to
 * move to a password manager. Timestamped and created exclusively, so a backup
 * is never overwritten (not even by a second deploy in the same second: that fails).
 */
export const keyBackupPath = (workerName: string, now: number) =>
  `${CONFIG_DIR}/${KEY_SECRET}.${workerName}.${new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.backup`;
/** Held (O_EXCL) for the whole deploy, so two deploys from one checkout cannot race. */
export const LOCK_PATH = `${CONFIG_DIR}/deploy.lock`;
/** A lock older than this is considered left behind by a crashed deploy. */
export const LOCK_STALE_MS = 30 * 60 * 1000;

/** Every setting the env file may contain; anything else is a typo and is refused. */
export const ENV_KEYS = {
  CLOUDFLARE_ACCOUNT_ID: 'required',
  OPENADS_HOSTNAME: 'required',
  OPENADS_WORKER_NAME: 'optional',
  OPENADS_D1_NAME: 'optional',
  ACCESS_TEAM_HOSTNAME: 'required',
  ACCESS_AUDIENCE: 'required',
  ACCESS_ALLOWED_EMAILS: 'required',
  OPENADS_ADMIN_EMAILS: 'required',
  GOOGLE_API_VERSION: 'optional',
  META_APP_ID: 'optional',
  META_APP_SECRET: 'optional secret',
  META_API_VERSION: 'optional',
  META_CONVERSION_ACTION_TYPE: 'optional',
  /** Only to restore the key of an existing database to a Worker that lost it; never replaces a key. */
  TOKEN_ENCRYPTION_KEY: 'optional secret',
} as const;
type EnvKey = keyof typeof ENV_KEYS;
/** Settings of the operator-configured Meta account, replaced by the in-app Meta Ads connection. */
const RETIRED_KEYS = new Set(['META_ACCOUNT_ID', 'META_ACCESS_TOKEN']);

export interface DeploySettings {
  readonly accountId: string;
  readonly hostname: string;
  readonly origin: string;
  readonly workerName: string;
  readonly d1Name: string;
  readonly admins: readonly string[];
  /** Plain-text Worker vars (in the generated config). */
  readonly vars: Readonly<Record<string, string>>;
  /** Optional secrets from the env file, uploaded with the deploy (never printed). */
  readonly secrets: Readonly<Record<string, string>>;
  /**
   * TOKEN_ENCRYPTION_KEY from the env file: uploaded only when the Worker has no
   * key and it matches the key id of the data already encrypted in D1 (never printed).
   */
  readonly tokenKey?: string;
}

export type Validation =
  | { ok: true; settings: DeploySettings; warnings: string[] }
  | { ok: false; errors: string[]; warnings: string[] };

/** KEY=value lines (Node's dotenv parser); comments and blank lines ignored. */
export function parseEnvFile(text: string): Record<string, string> {
  return parseEnv(text) as Record<string, string>;
}

const ACCOUNT_ID = /^[0-9a-f]{32}$/;
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const D1_NAME = /^[a-z0-9](?:[a-z0-9_-]{0,62})$/;
/** Standard base64 of 32 bytes, as importTokenKey (src/lib/crypto.ts) accepts. */
const TOKEN_KEY = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;
const HOSTNAME = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/**
 * Validates the env file with the app's own parsers (src/lib/access.ts and
 * src/lib/config.ts), so a value the Worker would refuse fails here, before any
 * Cloudflare call. PUBLIC_ORIGIN is derived as https://OPENADS_HOSTNAME.
 */
export function validateEnv(raw: Record<string, string>): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const value = (key: EnvKey) => (raw[key] ?? '').trim();
  for (const key of Object.keys(raw)) {
    if (RETIRED_KEYS.has(key)) {
      errors.push(`${key} is no longer used: Meta Ads is connected in the app (Sources → Set up Meta Ads). Remove it from the env file.`);
    } else if (!(key in ENV_KEYS)) {
      errors.push(`Unknown setting ${key} (check the spelling against deploy/.env.cloudflare.example).`);
    }
  }
  for (const [key, kind] of Object.entries(ENV_KEYS)) {
    if (kind === 'required' && !value(key as EnvKey)) errors.push(`${key} is required.`);
  }

  // The example file's sample values must be replaced.
  const samples: [EnvKey, RegExp][] = [
    ['OPENADS_HOSTNAME', /^openads\.example\.com$/], ['ACCESS_TEAM_HOSTNAME', /^your-team\./],
    ['ACCESS_ALLOWED_EMAILS', /(?:^|,)\s*you@example\.com\s*(?:,|$)/], ['OPENADS_ADMIN_EMAILS', /(?:^|,)\s*you@example\.com\s*(?:,|$)/],
  ];
  for (const [key, sample] of samples) {
    if (sample.test(value(key))) errors.push(`${key} still has the example value; replace it with yours.`);
  }

  const accountId = value('CLOUDFLARE_ACCOUNT_ID');
  if (accountId && !ACCOUNT_ID.test(accountId)) {
    errors.push('CLOUDFLARE_ACCOUNT_ID must be the 32-character account ID (Cloudflare dashboard → Account home → the ⋮ menu of the account → Copy account ID).');
  }
  const hostname = value('OPENADS_HOSTNAME');
  const origin = hostname ? publicOrigin(`https://${hostname}`) : null;
  if (hostname) {
    if (/^[a-z]+:\/\//i.test(hostname) || hostname.includes('/')) {
      errors.push('OPENADS_HOSTNAME is a bare host name such as openads.example.com (no https://, no path).');
    } else if (!HOSTNAME.test(hostname) || !origin) {
      errors.push('OPENADS_HOSTNAME must be a lowercase DNS name such as openads.example.com.');
    } else if (hostname.endsWith('.workers.dev') || hostname.endsWith('.cloudflareaccess.com')) {
      errors.push('OPENADS_HOSTNAME must be a host name in one of your own Cloudflare zones, not workers.dev or cloudflareaccess.com.');
    }
  }
  const workerName = value('OPENADS_WORKER_NAME') || 'openads';
  if (!WORKER_NAME.test(workerName)) errors.push('OPENADS_WORKER_NAME: lowercase letters, digits and hyphens, at most 63 characters.');
  const d1Name = value('OPENADS_D1_NAME') || 'openads';
  if (!D1_NAME.test(d1Name)) errors.push('OPENADS_D1_NAME: lowercase letters, digits, hyphens or underscores, at most 63 characters.');

  const team = value('ACCESS_TEAM_HOSTNAME');
  if (team && !validTeamHostname(team)) {
    errors.push(`ACCESS_TEAM_HOSTNAME is the bare team hostname, e.g. your-team.cloudflareaccess.com${team.startsWith('http') ? ' (without https://)' : ''}.`);
  }
  const audience = value('ACCESS_AUDIENCE');
  if (audience && !validAudience(audience)) {
    errors.push('ACCESS_AUDIENCE is the Access application\'s Audience (AUD) tag: one value without spaces or commas.');
  } else if (audience && !/^[0-9a-f]{64}$/.test(audience)) {
    warnings.push('ACCESS_AUDIENCE does not look like an Access AUD tag (64 hex characters). Copy it from the Access application\'s Overview.');
  }
  const allowed = value('ACCESS_ALLOWED_EMAILS');
  const allowlist = allowed ? parseAllowlist(allowed) : null;
  if (allowed && !allowlist) {
    errors.push('ACCESS_ALLOWED_EMAILS: comma-separated exact addresses (you@example.com) or whole domains (@example.com); one entry is malformed.');
  }
  const adminsRaw = value('OPENADS_ADMIN_EMAILS');
  const admins = adminsRaw ? parseExactAddresses(adminsRaw) : null;
  if (adminsRaw && (!admins || admins.size === 0)) {
    errors.push('OPENADS_ADMIN_EMAILS: comma-separated exact addresses (no @domain entries).');
  } else if (admins && allowlist) {
    for (const admin of admins) {
      if (!isAllowedEmail(admin, allowlist)) errors.push(`Admin ${admin} is not allowed by ACCESS_ALLOWED_EMAILS, so they could not sign in.`);
    }
  }
  const apiVersion = value('GOOGLE_API_VERSION');
  if (apiVersion && !googleApiVersion(apiVersion)) errors.push('GOOGLE_API_VERSION looks like v26 (or leave it empty for the default).');

  // Optional Meta app override (otherwise entered in the in-app wizard). The App ID
  // is a var; the App Secret a secret, uploaded with the deploy.
  const metaAppId = value('META_APP_ID');
  const metaAppSecret = value('META_APP_SECRET');
  if (metaAppId && !validMetaAppId(metaAppId)) errors.push('META_APP_ID is the numeric App ID shown at the top of the Meta App Dashboard.');
  if (metaAppSecret && !validMetaAppSecret(metaAppSecret)) errors.push('META_APP_SECRET is the 32-character App Secret (App settings → Basic).');
  if (metaAppSecret && !metaAppId) errors.push('META_APP_SECRET needs META_APP_ID (or remove both to set up Meta Ads in the app).');
  if (metaAppId && !metaAppSecret) {
    warnings.push('META_APP_ID is set but META_APP_SECRET is not in the env file: it must already be a Worker secret, or Meta Ads setup shows the deployment app as incomplete.');
  }
  const metaVersion = value('META_API_VERSION');
  if (metaVersion && !metaApiVersion(metaVersion)) errors.push('META_API_VERSION looks like v27.0 (or leave it empty for the default).');
  const actionType = value('META_CONVERSION_ACTION_TYPE');
  if (actionType && !validActionType(actionType)) {
    errors.push('META_CONVERSION_ACTION_TYPE is one exact Meta action type such as purchase (or leave it empty to choose it in the app).');
  }

  const tokenKey = value(KEY_SECRET);
  if (tokenKey && !TOKEN_KEY.test(tokenKey)) {
    errors.push(`${KEY_SECRET} is only for restoring a lost key: the exact base64 value of the old key (44 characters ending in =). Leave it out otherwise; the deploy generates the key itself.`);
  }

  if (errors.length || !origin || !admins || !allowlist) return { ok: false, errors, warnings };
  const vars: Record<string, string> = {
    PUBLIC_ORIGIN: origin,
    OPENADS_ADMIN_EMAILS: [...admins].join(','),
    ACCESS_TEAM_HOSTNAME: team,
    ACCESS_AUDIENCE: audience,
    ACCESS_ALLOWED_EMAILS: allowed.split(',').map(entry => entry.trim()).join(','),
  };
  if (apiVersion) vars.GOOGLE_API_VERSION = apiVersion;
  if (metaAppId) vars.META_APP_ID = metaAppId;
  if (metaVersion) vars.META_API_VERSION = metaVersion;
  if (actionType) vars.META_CONVERSION_ACTION_TYPE = actionType;
  const secrets: Record<string, string> = {};
  if (metaAppSecret) secrets.META_APP_SECRET = metaAppSecret;
  return {
    ok: true, warnings,
    settings: {
      accountId, hostname, origin, workerName, d1Name, admins: [...admins], vars, secrets,
      ...(tokenKey ? { tokenKey } : {}),
    },
  };
}

/** JSON with // and /* comments (wrangler.jsonc); strings are left intact. */
export function parseJsonc(text: string): unknown {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (char === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
      if (i === 0) throw new Error('Unterminated comment');
    } else {
      out += char;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

export const D1_ID_PLACEHOLDER = '<D1 database id>';

/**
 * The private deployment config, derived from the tracked wrangler.jsonc
 * template (compatibility date/flags, entry point) and the operator's settings.
 * Paths are relative to CONFIG_DIR. Access-protecting defaults are not optional:
 * no workers.dev, no preview URLs, assets behind the Worker.
 */
export function deployConfig(template: Record<string, unknown>, settings: DeploySettings, d1Id: string) {
  const main = typeof template.main === 'string' ? template.main : './src/worker.ts';
  const assets = typeof template.assets === 'object' && template.assets !== null ? template.assets : {};
  return {
    $schema: '../node_modules/wrangler/config-schema.json',
    name: settings.workerName,
    account_id: settings.accountId,
    main: posix.relative(CONFIG_DIR, posix.normalize(main)),
    compatibility_date: template.compatibility_date,
    compatibility_flags: template.compatibility_flags,
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: settings.hostname, custom_domain: true }],
    assets: { ...assets, binding: 'ASSETS', run_worker_first: true },
    observability: { enabled: false },
    d1_databases: [{
      binding: 'DB', database_name: settings.d1Name, database_id: d1Id, migrations_dir: '../migrations',
    }],
    vars: settings.vars,
  };
}

export function renderConfig(config: object): string {
  return `// Generated by scripts/deploy-cloudflare.mjs from deploy/.env.cloudflare and
// wrangler.jsonc. Do not edit: the next deploy overwrites it. Not tracked by git.
${JSON.stringify(config, null, 2)}
`;
}

/** Text with the outer JSON value printed by a wrangler --json command (banners and warnings skipped). */
export function extractJson(output: string, open: '[' | '{'): unknown {
  const close = open === '[' ? ']' : '}';
  const start = output.indexOf(open);
  const end = output.lastIndexOf(close);
  if (start < 0 || end < start) throw new Error('No JSON in output');
  return JSON.parse(output.slice(start, end + 1));
}

export type ProbeResult = 'access' | 'worker_gate' | 'access_not_configured' | 'open' | 'unreachable' | 'other';

/**
 * What an unauthenticated request saw. `access`: Cloudflare Access sent it to
 * its login. `worker_gate`: the Worker itself refused it (no Access application
 * in front: nothing is exposed, but nobody can sign in). `open`: 200, a failure.
 */
export function classifyProbe(status: number, location: string | null, body: string): ProbeResult {
  if (status >= 300 && status < 400 && location) {
    try {
      if (new URL(location).hostname.endsWith('.cloudflareaccess.com')) return 'access';
    } catch {
      // Relative or malformed Location: not Access.
    }
    return 'other';
  }
  if (status === 200) return 'open';
  if (status === 503 && body.includes('Access is not configured.')) return 'access_not_configured';
  if ((status === 401 && body.includes('Unauthorized.')) || (status === 403 && body.includes('Forbidden.'))) return 'worker_gate';
  if (status === 401 || status === 403) return 'access';
  return 'other';
}

// ── Orchestration ──────────────────────────────────────────────────────────

export interface RunOptions {
  /** True when the command changes remote state or the build output. Refused in plan mode. */
  readonly mutating: boolean;
  /** Extra environment for the child process. */
  readonly env?: Readonly<Record<string, string>>;
  /** Names removed from the child's environment (secrets that must come from a file). */
  readonly unsetEnv?: readonly string[];
  /** Stream output to the terminal instead of capturing it. */
  readonly inherit?: boolean;
}
export interface RunResult { readonly status: number; readonly stdout: string; readonly stderr: string }
export type Runner = (command: string, args: readonly string[], options: RunOptions) => RunResult;

export interface Files {
  readText(path: string): string;
  /** Writes JSON to a new private (0600) temp file; returns its path and a cleanup that deletes it. */
  writeSecretFile(json: string): { path: string; cleanup: () => void };
  /** Writes (or replaces) a private (0600, directory 0700) file under the project: the deployment config. */
  writePrivateText(path: string, text: string): void;
  /** Creates a new private (0600) file under the project; fails if it exists (the key backup: never overwritten). */
  createPrivateText(path: string, text: string): void;
  /**
   * Makes operator files private: a file becomes 0600; a directory 0700 with every
   * file in it 0600. Missing paths are ignored.
   */
  makePrivate(path: string): void;
  /** Takes the deploy lock (LOCK_PATH, see acquireDeployLock); returns its release. */
  lock(path: string, log: (line: string) => void): () => void;
}

export interface DeployDeps {
  readonly run: Runner;
  readonly files: Files;
  readonly fetch: typeof fetch;
  readonly log: (line: string) => void;
  readonly randomKey: () => string;
  readonly sleep: (ms: number) => Promise<void>;
  readonly nodeVersion: string;
  /** Asks the operator a yes/no question; false when nobody can answer (no terminal). */
  readonly confirm: (question: string) => Promise<boolean>;
  /** Current time (ms); the key backup's file name. Defaults to Date.now. */
  readonly now?: () => number;
}

export interface DeployOptions {
  readonly settings: DeploySettings;
  readonly warnings: readonly string[];
  readonly envFile: string;
  /** Print what would happen; never run a mutating command or write a file. */
  readonly plan: boolean;
  /** With plan: do not contact Cloudflare at all. */
  readonly offline: boolean;
  /** Verification attempts while a new custom domain gets DNS and a certificate. */
  readonly probeAttempts?: number;
  /**
   * When the Worker has no TOKEN_ENCRYPTION_KEY but D1 holds data encrypted with
   * an earlier one: delete that data (connections, stored OAuth client / App
   * secrets) and start with a new key, after a confirmation.
   */
  readonly resetEncryptedData?: boolean;
  /** Answer yes to the --reset-encrypted-data confirmation. */
  readonly yes?: boolean;
}

export class DeployError extends Error {
  readonly lines: string[];
  constructor(...lines: string[]) {
    super(lines[0]);
    this.name = 'DeployError';
    this.lines = lines;
  }
}

const WRANGLER = ['--no-install', 'wrangler'] as const;

/**
 * Environment forced onto every child process. At debug level with
 * WRANGLER_LOG_SANITIZE=false, Wrangler logs request bodies, including the
 * multipart upload that carries --secrets-file values, and it writes debug logs
 * to disk by default. So: sanitizing always on, no log files, and WRANGLER_LOG
 * exactly "log" (Wrangler's default). Not a quieter inherited level either: at
 * "warn" or below, `wrangler secret list --format json` prints nothing and the
 * deploy could not tell whether the Worker has a key.
 */
export function wranglerSafetyEnv(): Record<string, string> {
  return { WRANGLER_LOG: 'log', WRANGLER_LOG_SANITIZE: 'true', WRANGLER_WRITE_LOGS: 'false' };
}

/** The environment of a child process: inherited, then `env` (which wins), minus `unsetEnv`. */
export function childEnvironment(
  inherited: Readonly<Record<string, string | undefined>>, env: Readonly<Record<string, string>> = {}, unsetEnv: readonly string[] = [],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(inherited)) if (value !== undefined) result[name] = value;
  Object.assign(result, env);
  for (const name of unsetEnv) delete result[name];
  return result;
}

/** A warning when the env file (it can hold secrets) is readable by group or others; null when private. */
export function envFileModeWarning(mode: number, envFile: string): string | null {
  if ((mode & 0o077) === 0) return null;
  return `${envFile} is readable by other users (mode ${(mode & 0o777).toString(8).padStart(3, '0')}). Run: chmod 600 ${envFile}`;
}

interface LockInfo { pid: number; host: string; startedAt: number }

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Takes the deploy lock at `path` (absolute) with O_EXCL: a JSON file with the
 * pid, host and start time, mode 0600. Fails fast while another deploy holds it.
 * A lock whose process on this host is gone was left by an interrupted deploy:
 * it is replaced, with a message. A lock whose process is still alive on this
 * host is never replaced, however old (a long deploy keeps its lock). Only a
 * lock that cannot be checked that way (another host, no pid) expires after
 * LOCK_STALE_MS. Returns the release function.
 */
export function acquireDeployLock(path: string, options: {
  now?: number; pid?: number; host?: string; alive?: (pid: number) => boolean; log?: (line: string) => void;
} = {}): () => void {
  const now = options.now ?? Date.now();
  const pid = options.pid ?? process.pid;
  const host = options.host ?? osHostname();
  const alive = options.alive ?? isAlive;
  const info: LockInfo = { pid, host, startedAt: now };
  const create = () => {
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(info)}\n`);
    } finally {
      closeSync(fd);
    }
  };
  try {
    create();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let held: Partial<LockInfo> = {};
    try {
      held = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockInfo>;
    } catch {
      held = {};
    }
    let startedAt = typeof held.startedAt === 'number' ? held.startedAt : null;
    if (startedAt === null) {
      try {
        startedAt = statSync(path).mtimeMs;
      } catch {
        startedAt = now;
      }
    }
    const heldPid = typeof held.pid === 'number' ? held.pid : null;
    const since = new Date(startedAt).toISOString();
    const age = now - startedAt;
    const checkable = heldPid !== null && held.host === host;
    const running = checkable && alive(heldPid);
    const gone = checkable && !running;
    if (running || (!gone && age <= LOCK_STALE_MS)) {
      throw new DeployError(
        `Another deploy is running from this checkout (pid ${heldPid ?? 'unknown'}${held.host ? ` on ${held.host}` : ''}, started ${since}).`,
        'Do not run two deploys at once: wait for it to finish, then run the deploy again.',
        running
          ? `That process is still running on this host, so its lock is kept however old it is. If it is not a deploy (a reused pid), delete ${path} and run again.`
          : `If no deploy is running (one was interrupted), delete ${path} and run again; a lock from another host is ignored after 30 minutes.`,
      );
    }
    options.log?.(`  ! Replacing a stale deploy lock (pid ${heldPid ?? 'unknown'}, started ${since}: ${gone ? 'that process is gone' : 'over 30 minutes ago'})`);
    rmSync(path, { force: true });
    try {
      create();
    } catch (retry) {
      if ((retry as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new DeployError('Another deploy took the deploy lock at the same moment. Do not run two deploys at once.');
      }
      throw retry;
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Only remove our own lock.
    try {
      const current = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockInfo>;
      if (current.pid === pid && current.startedAt === now && current.host === host) rmSync(path, { force: true });
    } catch {
      // Already gone.
    }
  };
}

/** Every encrypted value in D1, grouped by the key id stored next to it (read-only). */
export const ENCRYPTED_DATA_QUERY = [
  "SELECT 'connection' AS source, token_key_id AS key_id, COUNT(*) AS n FROM connection GROUP BY token_key_id",
  "SELECT 'google_setup', client_secret_key_id, COUNT(*) FROM google_setup WHERE client_secret_ciphertext IS NOT NULL GROUP BY client_secret_key_id",
  "SELECT 'meta_setup', app_secret_key_id, COUNT(*) FROM meta_setup WHERE app_secret_ciphertext IS NOT NULL GROUP BY app_secret_key_id",
  "SELECT 'pending_connection', token_key_id, COUNT(*) FROM pending_connection GROUP BY token_key_id",
].join(' UNION ALL ');

/** The D1 row (migrations/0006_deploy_key_claim.sql) naming the key id the Worker's key must have. */
export const KEY_CLAIM_QUERY = "SELECT value FROM instance_meta WHERE key = 'token_key_id'";

/**
 * First writer wins: records `keyId` only when no key id is claimed yet (one
 * atomic statement). The deploy then reads the row back (KEY_CLAIM_QUERY).
 */
export function keyClaimSql(keyId: string, now: number): string {
  if (!/^k1-[0-9a-f]{16}$/.test(keyId) || !Number.isSafeInteger(now)) throw new Error('Invalid key id');
  return `INSERT INTO instance_meta (key, value, updated_at) SELECT 'token_key_id', '${keyId}', ${now} `
    + "WHERE NOT EXISTS (SELECT 1 FROM instance_meta WHERE key = 'token_key_id')";
}

/**
 * --reset-encrypted-data: removes everything encrypted with TOKEN_ENCRYPTION_KEY.
 * Deleting a connection cascades to its accounts and their project assignments;
 * projects, memberships and the setup wizards' progress (and App ID / project
 * ID) stay. Pending OAuth states and pending reconnects (another provider
 * identity, awaiting confirmation) are dropped too, and so is the key claim
 * (keyClaimSql): the new key claims it again.
 */
export const RESET_ENCRYPTED_DATA_SQL = [
  'DELETE FROM oauth_state',
  'DELETE FROM pending_connection',
  'DELETE FROM connection',
  `UPDATE google_setup SET client_id = NULL, client_secret_ciphertext = NULL, client_secret_key_id = NULL,
    client_secret_last4 = NULL, client_updated_by = NULL, client_updated_at = NULL`,
  `UPDATE meta_setup SET app_secret_ciphertext = NULL, app_secret_key_id = NULL, app_secret_last4 = NULL,
    app_secret_updated_by = NULL, app_secret_updated_at = NULL`,
  "DELETE FROM instance_meta WHERE key = 'token_key_id'",
].map(statement => statement.replace(/\s+/g, ' ')).join('; ');

export interface EncryptedData { readonly source: string; readonly keyId: string; readonly rows: number }

const SOURCE_LABEL: Record<string, string> = {
  connection: 'Google/Meta connection(s)', google_setup: 'stored Google OAuth client secret', meta_setup: 'stored Meta App Secret',
  pending_connection: 'pending Google/Meta reconnect(s)',
};

function describeEncrypted(data: readonly EncryptedData[]): string {
  return data.map(item => `${item.source === 'connection' || item.source === 'pending_connection' ? `${item.rows} ` : ''}${SOURCE_LABEL[item.source] ?? item.source} (key id ${item.keyId})`).join(', ');
}
export const show = (command: string, args: readonly string[]) =>
  [command, ...args].map(part => (/^[\w@%+=:,./<>-]+$/.test(part) ? part : JSON.stringify(part))).join(' ');

function nodeOk(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

interface WhoAmI { loggedIn?: boolean; email?: string; accounts?: { id: string; name: string }[] }

const mask = (value: string) => (value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value);

export interface DeployReport {
  readonly d1Id: string | null;
  readonly d1Created: boolean;
  readonly keyCreated: boolean;
  readonly probes: { path: string; result: ProbeResult; status: number | null }[];
}

/**
 * The deploy. Order: preflight → D1 (find or create) → private config → build
 * → remote migrations → secrets check → deploy (new TOKEN_ENCRYPTION_KEY and
 * env-file secrets via a 0600 --secrets-file, deleted afterwards) → verify.
 * Idempotent: an existing D1 and an existing TOKEN_ENCRYPTION_KEY are reused.
 * A key is never generated over data that an earlier key encrypted (checked
 * read-only in D1): that needs the old key in the env file, or --reset-encrypted-data.
 * Concurrency: one deploy per checkout (the local lock), and across checkouts or
 * machines a key is uploaded only by the deploy that claimed its id in D1 first
 * (keyClaimSql), right before the upload.
 */
export async function runDeploy(options: DeployOptions, deps: DeployDeps): Promise<DeployReport> {
  if (options.plan) return deploySteps(options, deps);
  // Two deploys at once could each generate a different key: one deploy per checkout
  // here; deploys from other checkouts are stopped by the D1 key claim (step 7).
  if (!nodeOk(deps.nodeVersion)) throw new DeployError(`Node ${deps.nodeVersion} is too old: OpenADS needs Node ${MIN_NODE.join('.')} or newer.`);
  const release = deps.files.lock(LOCK_PATH, deps.log);
  try {
    return await deploySteps(options, deps);
  } finally {
    release();
  }
}

async function deploySteps(options: DeployOptions, deps: DeployDeps): Promise<DeployReport> {
  const { settings, plan } = options;
  const { log } = deps;
  const accountEnv = { CLOUDFLARE_ACCOUNT_ID: settings.accountId, WRANGLER_SEND_METRICS: 'false' };
  const safety = wranglerSafetyEnv();
  const run: Runner = (command, args, runOptions) => {
    if (plan && runOptions.mutating) throw new Error(`plan mode must not run: ${show(command, args)}`);
    // The safety settings come last: no caller can turn sanitizing off or debug logging on.
    return deps.run(command, args, { ...runOptions, env: { ...accountEnv, ...runOptions.env, ...safety } });
  };
  const wrangler = (args: readonly string[], runOptions: RunOptions) => run('npx', [...WRANGLER, ...args], runOptions);
  const remote = !(plan && options.offline);
  const now = deps.now ?? Date.now;
  const would = (text: string) => log(`  ${plan ? 'would' : '→'} ${text}`);

  log(plan ? `OpenADS → Cloudflare: deploy plan (nothing will be changed${options.offline ? ', Cloudflare not contacted' : ''})` : 'OpenADS → Cloudflare deploy');
  log('');
  log(`Settings (${options.envFile})`);
  log(`  Account        ${settings.accountId}`);
  log(`  URL            ${settings.origin}`);
  log(`  Worker         ${settings.workerName}`);
  log(`  D1 database    ${settings.d1Name}`);
  log(`  Access         ${settings.vars.ACCESS_TEAM_HOSTNAME} · audience ${mask(settings.vars.ACCESS_AUDIENCE!)}`);
  log(`  Allowed        ${settings.vars.ACCESS_ALLOWED_EMAILS}`);
  log(`  Admins         ${settings.admins.join(', ')}`);
  if (Object.keys(settings.secrets).length) log(`  Secrets        ${Object.keys(settings.secrets).join(', ')} (from the env file, not printed)`);
  for (const warning of options.warnings) log(`  ! ${warning}`);
  log('');

  // 1. Preflight.
  log('1. Preflight');
  if (!nodeOk(deps.nodeVersion)) throw new DeployError(`Node ${deps.nodeVersion} is too old: OpenADS needs Node ${MIN_NODE.join('.')} or newer.`);
  log(`  ✓ Node ${deps.nodeVersion}`);
  if (remote) {
    const whoami = wrangler(['whoami', '--json'], { mutating: false });
    let user: WhoAmI | null = null;
    try {
      user = whoami.status === 0 ? extractJson(whoami.stdout, '{') as WhoAmI : null;
    } catch {
      user = null;
    }
    if (!user?.loggedIn) {
      throw new DeployError('Wrangler is not logged in to Cloudflare.', 'Run: npx wrangler login   (or set CLOUDFLARE_API_TOKEN)');
    }
    const account = user.accounts?.find(item => item.id === settings.accountId);
    if (!account) {
      throw new DeployError(`CLOUDFLARE_ACCOUNT_ID ${settings.accountId} is not one of the accounts this login can use.`,
        ...(user.accounts ?? []).map(item => `  ${item.id}  ${item.name}`));
    }
    log(`  ✓ Logged in${user.email ? ` as ${user.email}` : ''}; account "${account.name}"`);
  } else {
    log('  - wrangler whoami (skipped: --offline)');
  }

  // 2. D1.
  log('2. D1 database');
  let d1Id: string | null = null;
  let d1Created = false;
  const findD1 = () => {
    const listed = wrangler(['d1', 'list', '--json'], { mutating: false });
    if (listed.status !== 0) throw new DeployError('Could not list D1 databases.', listed.stderr.trim() || listed.stdout.trim());
    const databases = extractJson(listed.stdout, '[') as { uuid?: string; name?: string }[];
    return databases.find(item => item.name === settings.d1Name)?.uuid ?? null;
  };
  if (remote) d1Id = findD1();
  if (d1Id) {
    log(`  ✓ Found "${settings.d1Name}" (${d1Id})`);
  } else if (plan) {
    would(`create it: ${show('npx', [...WRANGLER, 'd1', 'create', settings.d1Name])}${remote ? '' : ' (if missing)'}`);
  } else {
    const created = wrangler(['d1', 'create', settings.d1Name], { mutating: true });
    if (created.status !== 0) throw new DeployError(`Could not create D1 database "${settings.d1Name}".`, created.stderr.trim() || created.stdout.trim());
    d1Id = findD1();
    if (!d1Id) throw new DeployError(`D1 database "${settings.d1Name}" was created but is not listed yet; run the deploy again.`);
    d1Created = true;
    log(`  ✓ Created "${settings.d1Name}" (${d1Id})`);
  }

  // 3. Private config.
  log(`3. Deployment config (${CONFIG_PATH}, not tracked by git)`);
  const template = parseJsonc(deps.files.readText('wrangler.jsonc')) as Record<string, unknown>;
  const config = renderConfig(deployConfig(template, settings, d1Id ?? D1_ID_PLACEHOLDER));
  if (plan) {
    would('write:');
    for (const line of config.trimEnd().split('\n')) log(`      ${line}`);
  } else {
    deps.files.writePrivateText(CONFIG_PATH, config);
    log('  ✓ Written (mode 0600)');
  }

  // 4. Build.
  log('4. Build');
  const build = ['--no-install', 'vite', 'build'];
  if (plan) {
    would(`run: OPENADS_WRANGLER_CONFIG=${CONFIG_PATH} ${show('npx', build)}  (writes ${BUILT_CONFIG})`);
  } else {
    const built = run('npx', build, { mutating: true, inherit: true, env: { OPENADS_WRANGLER_CONFIG: CONFIG_PATH } });
    if (built.status !== 0) throw new DeployError('The build failed (output above).');
    // The built config carries the operator's settings (account, hostname, Access, admins):
    // keep it, like everything under .openads/, readable by the operator only.
    deps.files.makePrivate(BUILT_CONFIG);
    deps.files.makePrivate(CONFIG_DIR);
    log(`  ✓ Built (${BUILT_CONFIG} and ${CONFIG_DIR}/ made private: 0600)`);
  }

  // 5. Migrations.
  log('5. Database migrations');
  const migrate = ['d1', 'migrations', 'apply', 'DB', '--remote', '-c', CONFIG_PATH];
  if (plan) {
    would(`run: ${show('npx', [...WRANGLER, ...migrate])}  (applies only migrations not yet applied)`);
  } else {
    const migrated = wrangler(migrate, { mutating: true, inherit: true });
    if (migrated.status !== 0) throw new DeployError('Applying migrations failed (output above). Nothing was deployed.');
    log('  ✓ Migrations applied');
  }

  /** Read-only: what D1 holds encrypted, by key id. Fails closed when it cannot tell. */
  const encryptedData = (): EncryptedData[] => {
    const result = wrangler(['d1', 'execute', 'DB', '--remote', '--json', '-c', CONFIG_PATH, '--command', ENCRYPTED_DATA_QUERY], { mutating: false });
    let rows: unknown[] | null = null;
    try {
      const output = result.status === 0 ? extractJson(result.stdout, '[') as { results?: unknown[] }[] : null;
      rows = output?.[0]?.results ?? null;
    } catch {
      rows = null;
    }
    if (!Array.isArray(rows)) {
      throw new DeployError(`Could not check D1 database "${settings.d1Name}" for encrypted data; nothing was deployed.`,
        result.stderr.trim() || result.stdout.trim() || 'Unexpected output from wrangler d1 execute.');
    }
    return rows.flatMap(row => {
      const { source, key_id: keyId, n } = (row ?? {}) as { source?: unknown; key_id?: unknown; n?: unknown };
      return typeof source === 'string' && typeof keyId === 'string' && typeof n === 'number' && n > 0
        ? [{ source, keyId, rows: n }] : [];
    });
  };

  // 6. Secrets.
  log('6. Secrets');
  /** Whether the Worker has TOKEN_ENCRYPTION_KEY (false: no Worker yet). Never guesses. */
  const hasKey = (): boolean => {
    const listed = wrangler(['secret', 'list', '--name', settings.workerName, '--format', 'json'], { mutating: false });
    const output = `${listed.stdout}\n${listed.stderr}`;
    if (listed.status === 0) {
      let secrets: unknown;
      try {
        secrets = extractJson(listed.stdout, '[');
      } catch {
        secrets = null;
      }
      if (!Array.isArray(secrets)) {
        throw new DeployError(`Could not read the secret list of Worker "${settings.workerName}" (no JSON from wrangler secret list).`, output.trim());
      }
      return secrets.some(item => (item as { name?: unknown } | null)?.name === KEY_SECRET);
    }
    if (output.includes(`Worker "${settings.workerName}"`) && output.includes('not found')) return false; // First deploy.
    // Never guess: generating a new key over an existing one would orphan every stored grant.
    throw new DeployError(`Could not list the secrets of Worker "${settings.workerName}".`, output.trim());
  };
  /**
   * Cross-checkout guard (the local lock only covers this checkout): records this
   * key's id in D1 unless a key id is already claimed (first writer wins), then
   * reads the claim back. Another id means another deploy (another checkout or
   * machine, or an earlier deploy that stopped after claiming) owns the key:
   * stop before deploying anything, so the Worker never gets a second key.
   */
  const claimKey = (key: string, backup: string | null) => {
    const keyId = keyIdOf(key);
    const claimed = wrangler(['d1', 'execute', 'DB', '--remote', '--yes', '-c', CONFIG_PATH, '--command', keyClaimSql(keyId, now())], { mutating: true });
    if (claimed.status !== 0) {
      throw new DeployError('Could not record the encryption key id in D1; nothing was deployed.', claimed.stderr.trim() || claimed.stdout.trim());
    }
    const read = wrangler(['d1', 'execute', 'DB', '--remote', '--json', '-c', CONFIG_PATH, '--command', KEY_CLAIM_QUERY], { mutating: false });
    let winner: unknown = null;
    try {
      const output = read.status === 0 ? extractJson(read.stdout, '[') as { results?: { value?: unknown }[] }[] : null;
      winner = output?.[0]?.results?.[0]?.value ?? null;
    } catch {
      winner = null;
    }
    if (typeof winner !== 'string') {
      throw new DeployError('Could not read the encryption key id back from D1; nothing was deployed.', read.stderr.trim() || read.stdout.trim());
    }
    if (winner !== keyId) {
      throw new DeployError(
        `Another deploy already claimed a different ${KEY_SECRET} for D1 database "${settings.d1Name}" (key id ${winner}; this deploy's key id is ${keyId}).`,
        'Nothing was deployed and no key was uploaded. Two deploys (another checkout or machine?) ran at once, or an earlier deploy stopped after claiming its key.',
        `Use the winning key: it is in the ${CONFIG_DIR}/${KEY_SECRET}.${settings.workerName}.*.backup file of the checkout that claimed it.`,
        `  Add ${KEY_SECRET}=<that key> to ${options.envFile} and run the deploy again (its id must be ${winner}).`,
        ...(backup ? [`The backup this deploy just wrote (${backup}) holds a key that was never used: delete it.`] : []),
        'Only if no deploy is running and nobody has that key any more: clear the claim with',
        `  npx wrangler d1 execute ${settings.d1Name} --remote --command "DELETE FROM instance_meta WHERE key = 'token_key_id'"`,
        '  and run the deploy again.',
      );
    }
    log(`  ✓ Key id ${keyId} claimed in D1 (first deploy wins)`);
  };
  const keyIds = new Map<string, string>();
  const keyIdOf = (key: string) => {
    const id = keyIds.get(key);
    if (!id) throw new DeployError(`${KEY_SECRET} is not a valid key (base64 of 32 bytes); nothing was deployed.`);
    return id;
  };

  let keyPresent: boolean | null = null;
  if (remote) keyPresent = hasKey();
  const upload: Record<string, string> = { ...settings.secrets };
  let keyCreated = false;
  let encryptedDataReset = false;
  if (keyPresent === true) {
    log(`  ✓ ${KEY_SECRET} is set; left untouched`);
    if (settings.tokenKey) log(`  ! ${KEY_SECRET} from the env file is not uploaded: the Worker already has one, and the deploy never replaces it. Remove it from the env file.`);
    if (options.resetEncryptedData) log('  ! --reset-encrypted-data ignored: the Worker still has its key, so the stored data stays readable.');
  } else if (plan) {
    const source = settings.tokenKey ? `upload ${KEY_SECRET} from the env file` : `generate ${KEY_SECRET} (32 random bytes, base64) and upload it`;
    would(`${source}${keyPresent === false ? '' : ' if the Worker has none'} with the deploy via a private temp file; never printed${settings.tokenKey ? '' : ` (a generated key is backed up to a new ${keyBackupPath(settings.workerName, now())} file)`}`);
    would(`claim its key id in D1 first (${show('npx', [...WRANGLER, 'd1', 'execute', 'DB', '--remote', '--json', '-c', CONFIG_PATH, '--command', '<INSERT … WHERE NOT EXISTS>'])}) and stop if another deploy already claimed a different key`);
    if (d1Id) {
      would(`but first check D1 read-only for data encrypted with an earlier key (${show('npx', [...WRANGLER, 'd1', 'execute', 'DB', '--remote', '--json', '-c', CONFIG_PATH, '--command', '<SELECT …>'])}) and stop if a new key could not read it`);
    }
  } else {
    const stored = d1Created ? [] : encryptedData();
    const tokenKeyId = settings.tokenKey ? (await importTokenKey(settings.tokenKey))?.id ?? null : null;
    if (settings.tokenKey && !tokenKeyId) throw new DeployError(`${KEY_SECRET} in the env file is not a valid key (base64 of 32 bytes).`);
    if (stored.length && settings.tokenKey) {
      // Restoring: the key must be the one every stored value was encrypted with.
      const foreign = stored.filter(item => item.keyId !== tokenKeyId);
      if (foreign.length) {
        throw new DeployError(
          `${KEY_SECRET} in the env file (key id ${tokenKeyId}) is not the key that encrypted the data in D1 database "${settings.d1Name}".`,
          `Encrypted with another key: ${describeEncrypted(foreign)}.`,
          'Put the original key in the env file, or remove it and use --reset-encrypted-data to start over.',
        );
      }
      log(`  ✓ ${KEY_SECRET} from the env file matches the encrypted data in D1 (${describeEncrypted(stored)})`);
    } else if (stored.length) {
      if (!options.resetEncryptedData) {
        throw new DeployError(
          `Worker "${settings.workerName}" has no ${KEY_SECRET}, but D1 database "${settings.d1Name}" holds data encrypted with one: ${describeEncrypted(stored)}.`,
          'A new key could not decrypt it (connections would fail and the stored secrets would be unreadable), so nothing was deployed.',
          `To keep the data, restore the original key: add ${KEY_SECRET}=<the old key> to ${options.envFile} and run the deploy again.`,
          '  It is uploaded through a private temp file and never printed; remove it from the env file afterwards.',
          'To start over instead: run again with --reset-encrypted-data. It deletes the stored Google/Meta connections',
          '  (and their accounts\' project assignments) and the stored Google OAuth client secret / Meta App Secret after a confirmation',
          '  (--yes skips it); projects and setup progress stay. Then reconnect in the app.',
        );
      }
      const question = `Delete ${describeEncrypted(stored)} from D1 database "${settings.d1Name}" and generate a new ${KEY_SECRET}?`;
      if (!options.yes && !(await deps.confirm(question))) {
        throw new DeployError('Not confirmed: nothing was deleted or deployed.', 'Run with --yes to confirm without a prompt.');
      }
      const reset = wrangler(['d1', 'execute', 'DB', '--remote', '--yes', '-c', CONFIG_PATH, '--command', RESET_ENCRYPTED_DATA_SQL], { mutating: true });
      if (reset.status !== 0) throw new DeployError('Deleting the encrypted data failed; nothing was deployed.', reset.stderr.trim() || reset.stdout.trim());
      if (encryptedData().length) throw new DeployError('Encrypted data is still present after the reset; nothing was deployed.');
      encryptedDataReset = true;
      log(`  ! Deleted ${describeEncrypted(stored)}; reconnect Google Ads / Meta Ads in the app after the deploy`);
    }
    if (settings.tokenKey) {
      upload[KEY_SECRET] = settings.tokenKey;
      log(`  + ${KEY_SECRET} from the env file will be uploaded with the deploy (not printed)`);
    } else {
      upload[KEY_SECRET] = deps.randomKey();
      keyCreated = true;
      log(`  + ${KEY_SECRET} will be generated and uploaded with the deploy (not printed)`);
    }
    const uploadedId = (await importTokenKey(upload[KEY_SECRET]!))?.id;
    if (uploadedId) keyIds.set(upload[KEY_SECRET]!, uploadedId);
  }
  for (const name of Object.keys(settings.secrets)) log(`  ${plan ? 'would upload' : '+ uploading'} ${name} from the env file (not printed)`);

  // 7. Deploy.
  log('7. Deploy');
  const deployArgs = ['deploy', '-c', BUILT_CONFIG];
  const secretNames = Object.keys(upload);
  if (plan) {
    would(`run: ${show('npx', [...WRANGLER, ...deployArgs, ...(secretNames.length || keyPresent !== true ? ['--secrets-file', '<private temp file, deleted afterwards>'] : [])])}`);
    would(`attach the custom domain ${settings.hostname} (must be in a zone of this account)`);
  } else {
    // Another deploy (another checkout or machine) may have set a key since step 6:
    // check again right before uploading one, and never overwrite it.
    if (KEY_SECRET in upload && hasKey()) {
      throw new DeployError(
        `Worker "${settings.workerName}" got a ${KEY_SECRET} while this deploy was running (another deploy?).`,
        'Nothing was deployed and that key was not overwritten. Do not run two deploys at once; run the deploy again.',
      );
    }
    // Cloudflare never shows a secret again: without a copy, a lost Worker strands the
    // encrypted data. Written before the claim and the upload, so a key is never
    // claimed or in use without a copy.
    const backup = keyBackupPath(settings.workerName, now());
    if (keyCreated) {
      try {
        deps.files.createPrivateText(backup, `${upload[KEY_SECRET]}\n`);
      } catch (error) {
        throw new DeployError(`Could not create the key backup ${backup} (existing backups are never overwritten); nothing was deployed.`,
          error instanceof Error ? error.message : String(error));
      }
    }
    if (KEY_SECRET in upload) claimKey(upload[KEY_SECRET]!, keyCreated ? backup : null);
    let secretFile: { path: string; cleanup: () => void } | null = null;
    try {
      if (secretNames.length) secretFile = deps.files.writeSecretFile(JSON.stringify(upload));
      const deployed = wrangler([...deployArgs, ...(secretFile ? ['--secrets-file', secretFile.path] : [])], {
        mutating: true, inherit: true,
        // Wrangler lets process env values override --secrets-file values: remove them.
        unsetEnv: [KEY_SECRET, ...Object.keys(settings.secrets)],
      });
      if (deployed.status !== 0) {
        throw new DeployError('wrangler deploy failed (output above).',
          `If it mentions the custom domain: ${settings.hostname} must be in a zone of account ${settings.accountId}.`);
      }
    } finally {
      secretFile?.cleanup();
    }
    log(`  ✓ Deployed to ${settings.origin}`);
    if (keyCreated) {
      log(`  ✓ ${KEY_SECRET} is set. Never change or delete it: it encrypts the stored Google OAuth client secret, Meta App Secret and grants (a new key means re-entering the secrets and reconnecting).`);
      log(`  ! A copy is in ${backup} (mode 0600, not tracked by git): move it to your password manager, then delete the file.`);
    }
    if (encryptedDataReset) log('  ! Encrypted data was reset: set up and connect Google Ads / Meta Ads again in the app.');
  }

  // 8. Verify.
  log('8. Verify that the app is not public');
  const probes: DeployReport['probes'] = [];
  if (plan) {
    would(`GET ${settings.origin}/ and ${settings.origin}/api/campaigns.json without signing in: expect a redirect to *.cloudflareaccess.com (or 401/403), never 200`);
  } else {
    const attempts = options.probeAttempts ?? 12;
    for (const path of ['/', '/api/campaigns.json']) {
      let result: ProbeResult = 'unreachable';
      let status: number | null = null;
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          const response = await deps.fetch(`${settings.origin}${path}`, {
            redirect: 'manual', headers: { Accept: path === '/' ? 'text/html' : 'application/json' },
            signal: AbortSignal.timeout(10_000),
          });
          status = response.status;
          const body = status === 200 ? '' : (await response.text()).slice(0, 2_000);
          result = classifyProbe(status, response.headers.get('Location'), body);
        } catch {
          result = 'unreachable';
        }
        if (result !== 'unreachable' && result !== 'other') break;
        if (attempt < attempts - 1) await deps.sleep(5_000);
      }
      probes.push({ path, result, status });
      const label: Record<ProbeResult, string> = {
        access: '✓ protected by Cloudflare Access',
        worker_gate: '! refused by OpenADS itself (401/403): no Access application covers this hostname yet, so nobody can sign in',
        access_not_configured: '! OpenADS says "Access is not configured" (503): check the ACCESS_* values',
        open: '✗ returned 200 without signing in',
        unreachable: '! not reachable yet (new custom domains can take a few minutes for DNS and the certificate)',
        other: `! unexpected response${status ? ` (${status})` : ''}`,
      };
      log(`  ${path.padEnd(22)} ${label[result]}`);
    }
    if (probes.some(probe => probe.result === 'open')) {
      throw new DeployError(`${settings.origin} answered without signing in. Check the Access application and that the Worker is the one serving this hostname.`);
    }
  }

  // Summary.
  log('');
  if (plan) {
    log('Run without --plan to deploy.');
  } else {
    log('Done.');
    log(`  URL            ${settings.origin}`);
    log(`  D1 database    ${settings.d1Name} (${d1Id})`);
    log(`  Next           Open ${settings.origin} → sign in → Sources → Set up Google Ads / Set up Meta Ads`);
    log(`                 (redirect URIs ${settings.origin}/api/oauth/google/callback`);
    log(`                  and ${settings.origin}/api/oauth/meta/callback)`);
  }
  log('');
  log('Cloudflare Access is not created by this command. Its application must cover the whole');
  log(`hostname ${settings.hostname} (no path) and allow the same people as ACCESS_ALLOWED_EMAILS;`);
  log('see docs/SELF_HOSTING_CLOUDFLARE.md.');
  return { d1Id, d1Created, keyCreated, probes };
}
