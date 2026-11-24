// D1 persistence for workspaces, memberships, connections, connected accounts
// and OAuth state (schema: migrations/). Every tenant query takes a workspace id
// and filters on it; nothing here trusts an id that came from the browser
// without that filter. No query returns ciphertext to a caller that renders it.
import { asciiLower } from './access.ts';

export type Role = 'admin' | 'member';
export type Provider = 'google_ads' | 'meta_ads';
/** `expired`: Meta's long-lived token (or its data access) reached its expiry. */
export type ConnectionStatus = 'active' | 'revoked' | 'error' | 'expired';

export interface Membership {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly email: string;
  readonly role: Role;
}

export const DEFAULT_WORKSPACE_NAME = 'Default workspace';

/**
 * First version: one default workspace. The first admin (OPENADS_ADMIN_EMAILS)
 * to visit creates it; any other Access-authenticated user becomes a member on
 * first visit, once it exists. For the default workspace the admin list is the
 * source of truth, so roles follow the configuration on every visit.
 * Returns null when no workspace exists yet and the visitor is not an admin.
 */
export async function resolveDefaultMembership(
  db: D1Database, email: string, admins: ReadonlySet<string>, now = Date.now(),
): Promise<Membership | null> {
  const normalized = asciiLower(email);
  const role: Role = admins.has(normalized) ? 'admin' : 'member';
  let workspace = await db.prepare('SELECT id, name FROM workspace WHERE is_default = 1')
    .first<{ id: string; name: string }>();
  if (!workspace) {
    if (role !== 'admin') return null;
    // The partial unique index makes concurrent first visits converge on one row.
    await db.prepare('INSERT OR IGNORE INTO workspace (id, name, is_default, created_at) VALUES (?, ?, 1, ?)')
      .bind(crypto.randomUUID(), DEFAULT_WORKSPACE_NAME, now).run();
    workspace = await db.prepare('SELECT id, name FROM workspace WHERE is_default = 1')
      .first<{ id: string; name: string }>();
    if (!workspace) return null;
  }
  const current = await db.prepare('SELECT role FROM membership WHERE workspace_id = ? AND email = ?')
    .bind(workspace.id, normalized).first<{ role: Role }>();
  if (current?.role !== role) {
    await db.prepare(`INSERT INTO membership (workspace_id, email, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, email) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`)
      .bind(workspace.id, normalized, role, now, now).run();
  }
  return { workspaceId: workspace.id, workspaceName: workspace.name, email: normalized, role };
}

/** Membership of a specific workspace (multi-workspace ready); null when not a member. */
export async function getMembership(db: D1Database, workspaceId: string, email: string): Promise<Membership | null> {
  const row = await db.prepare(`SELECT m.workspace_id, w.name, m.email, m.role FROM membership m
    JOIN workspace w ON w.id = m.workspace_id WHERE m.workspace_id = ? AND m.email = ?`)
    .bind(workspaceId, asciiLower(email))
    .first<{ workspace_id: string; name: string; email: string; role: Role }>();
  return row ? { workspaceId: row.workspace_id, workspaceName: row.name, email: row.email, role: row.role } : null;
}

// ── Connections ────────────────────────────────────────────────────────────

export interface ConnectionRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly provider: Provider;
  readonly subject: string;
  readonly email: string | null;
  /** Display name of the provider account (Meta: the Facebook user's name). */
  readonly name: string | null;
  readonly ciphertext: string;
  readonly keyId: string;
  /** When the stored grant stops working (epoch ms); null when unknown or never. */
  readonly tokenExpiresAt: number | null;
  readonly status: ConnectionStatus;
  readonly createdByEmail: string;
  readonly accountsDiscoveredAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface ConnectionRecord {
  id: string; workspace_id: string; provider: Provider; provider_subject: string; provider_email: string | null;
  provider_name: string | null; refresh_token_ciphertext: string; token_key_id: string; token_expires_at: number | null;
  status: ConnectionStatus; created_by_email: string;
  accounts_discovered_at: number | null; created_at: number; updated_at: number;
}

const connection = (row: ConnectionRecord): ConnectionRow => ({
  id: row.id, workspaceId: row.workspace_id, provider: row.provider, subject: row.provider_subject,
  email: row.provider_email, name: row.provider_name, ciphertext: row.refresh_token_ciphertext, keyId: row.token_key_id,
  tokenExpiresAt: row.token_expires_at, status: row.status, createdByEmail: row.created_by_email, accountsDiscoveredAt: row.accounts_discovered_at,
  createdAt: row.created_at, updatedAt: row.updated_at,
});

export async function getConnection(db: D1Database, workspaceId: string, provider: Provider): Promise<ConnectionRow | null> {
  const row = await db.prepare('SELECT * FROM connection WHERE workspace_id = ? AND provider = ?')
    .bind(workspaceId, provider).first<ConnectionRecord>();
  return row ? connection(row) : null;
}

export interface NewConnection {
  readonly id: string;
  readonly workspaceId: string;
  readonly provider: Provider;
  readonly subject: string;
  readonly email: string | null;
  readonly name?: string | null;
  readonly ciphertext: string;
  readonly keyId: string;
  readonly tokenExpiresAt?: number | null;
  readonly createdByEmail: string;
}

/**
 * Stores a fresh grant. The same provider identity keeps its connection id (and
 * so its selected accounts) only when the caller sealed the token for that id;
 * any previous connection of another identity is replaced, cascading its accounts.
 */
export async function saveConnection(db: D1Database, value: NewConnection, now = Date.now()): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM connection WHERE workspace_id = ? AND provider = ? AND id <> ?')
      .bind(value.workspaceId, value.provider, value.id),
    db.prepare(`INSERT INTO connection (id, workspace_id, provider, provider_subject, provider_email, provider_name,
        refresh_token_ciphertext, token_key_id, token_expires_at, status, created_by_email, accounts_discovered_at,
        created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?, ?)
      ON CONFLICT (id) DO UPDATE SET provider_email = excluded.provider_email, provider_name = excluded.provider_name,
        refresh_token_ciphertext = excluded.refresh_token_ciphertext, token_key_id = excluded.token_key_id,
        token_expires_at = excluded.token_expires_at, status = 'active', updated_at = excluded.updated_at
      WHERE connection.workspace_id = excluded.workspace_id AND connection.provider = excluded.provider
        AND connection.provider_subject = excluded.provider_subject`)
      .bind(value.id, value.workspaceId, value.provider, value.subject, value.email, value.name ?? null,
        value.ciphertext, value.keyId, value.tokenExpiresAt ?? null, value.createdByEmail, now, now),
  ]);
}

// ── Pending reconnect as another provider identity ──────────────────────────────

/** How long a reconnect as another identity waits for the admin's confirmation. */
export const PENDING_CONNECTION_TTL_MS = 10 * 60_000;

/**
 * A new grant for a different provider identity than the stored connection,
 * waiting for an admin to confirm or cancel the change (migration 0007).
 * `ciphertext` is sealed with pendingGrantContext(workspaceId, id).
 */
export interface PendingConnectionRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly provider: Provider;
  readonly replacesConnectionId: string;
  readonly replacesSubject: string;
  readonly subject: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly ciphertext: string;
  readonly keyId: string;
  readonly tokenExpiresAt: number | null;
  /** What the new login discovered (null: the stored value could not be read). */
  readonly discovery: Discovery | null;
  readonly createdByEmail: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

interface PendingConnectionRecord {
  id: string; workspace_id: string; provider: Provider; replaces_connection_id: string; replaces_subject: string;
  provider_subject: string; provider_email: string | null; provider_name: string | null; token_ciphertext: string;
  token_key_id: string; token_expires_at: number | null; discovery: string; created_by_email: string;
  created_at: number; expires_at: number;
}

function parseDiscovery(value: string): Discovery | null {
  try {
    const parsed = JSON.parse(value) as { accounts?: unknown; incompleteLogins?: unknown };
    if (!Array.isArray(parsed.accounts) || !Array.isArray(parsed.incompleteLogins)) return null;
    return {
      accounts: parsed.accounts as DiscoveredAccount[],
      incompleteLogins: new Set(parsed.incompleteLogins.filter((item): item is string => typeof item === 'string')),
    };
  } catch {
    return null;
  }
}

const pendingConnection = (row: PendingConnectionRecord): PendingConnectionRow => ({
  id: row.id, workspaceId: row.workspace_id, provider: row.provider, replacesConnectionId: row.replaces_connection_id,
  replacesSubject: row.replaces_subject, subject: row.provider_subject, email: row.provider_email, name: row.provider_name,
  ciphertext: row.token_ciphertext, keyId: row.token_key_id, tokenExpiresAt: row.token_expires_at,
  discovery: parseDiscovery(row.discovery), createdByEmail: row.created_by_email, createdAt: row.created_at,
  expiresAt: row.expires_at,
});

/** Normalizes Google's Discovery and Meta's plain list to one shape. */
export const asDiscovery = (value: readonly DiscoveredAccount[] | Discovery): Discovery =>
  ('accounts' in value ? value : { accounts: value, incompleteLogins: new Set<string>() });

/**
 * Stores the pending change for (workspace, provider), replacing any earlier one;
 * expired rows of every workspace are purged first.
 */
export async function savePendingConnection(db: D1Database, value: {
  id: string; workspaceId: string; provider: Provider; replacesConnectionId: string; replacesSubject: string;
  subject: string; email: string | null; name: string | null; ciphertext: string; keyId: string;
  tokenExpiresAt: number | null; discovery: Discovery; createdByEmail: string;
}, now = Date.now()): Promise<void> {
  const discovery = JSON.stringify({ accounts: value.discovery.accounts, incompleteLogins: [...value.discovery.incompleteLogins] });
  await db.batch([
    db.prepare('DELETE FROM pending_connection WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM pending_connection WHERE workspace_id = ? AND provider = ?').bind(value.workspaceId, value.provider),
    db.prepare(`INSERT INTO pending_connection (id, workspace_id, provider, replaces_connection_id, replaces_subject,
        provider_subject, provider_email, provider_name, token_ciphertext, token_key_id, token_expires_at, discovery,
        created_by_email, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(value.id, value.workspaceId, value.provider, value.replacesConnectionId, value.replacesSubject, value.subject,
        value.email, value.name, value.ciphertext, value.keyId, value.tokenExpiresAt, discovery, value.createdByEmail,
        now, now + PENDING_CONNECTION_TTL_MS),
  ]);
}

/** The unexpired pending change of (workspace, provider), if any; expired rows are purged (ciphertext included). */
export async function getPendingConnection(
  db: D1Database, workspaceId: string, provider: Provider, now = Date.now(),
): Promise<PendingConnectionRow | null> {
  await db.prepare('DELETE FROM pending_connection WHERE expires_at <= ?').bind(now).run();
  const row = await db.prepare('SELECT * FROM pending_connection WHERE workspace_id = ? AND provider = ? AND expires_at > ?')
    .bind(workspaceId, provider, now).first<PendingConnectionRecord>();
  return row ? pendingConnection(row) : null;
}

/**
 * Atomically deletes and returns the pending change `id` of (workspace, provider):
 * a second confirm or cancel finds nothing. Null when absent or expired.
 */
export async function takePendingConnection(
  db: D1Database, workspaceId: string, provider: Provider, id: string, now = Date.now(),
): Promise<PendingConnectionRow | null> {
  const { results } = await db.prepare(`DELETE FROM pending_connection WHERE workspace_id = ? AND provider = ? AND id = ?
    RETURNING *`).bind(workspaceId, provider, id).all<PendingConnectionRecord>();
  const row = results[0];
  return row && row.expires_at > now ? pendingConnection(row) : null;
}

/** Discards any pending change of (workspace, provider). */
export async function deletePendingConnection(db: D1Database, workspaceId: string, provider: Provider): Promise<void> {
  await db.prepare('DELETE FROM pending_connection WHERE workspace_id = ? AND provider = ?').bind(workspaceId, provider).run();
}

/**
 * Applies a confirmed change of provider identity, in one transaction: the
 * connection row is updated in place (same id, the new grant sealed for it) and
 * only the accounts the new login does not list (`keepCustomerIds`) are deleted,
 * with their project assignments. The others keep their row, so their
 * selection and project survive; rediscovery (replaceAccounts) then refreshes
 * them. Nothing changes unless the connection still belongs to
 * `previousSubject`. Returns whether the change was applied.
 */
export async function switchConnectionIdentity(db: D1Database, value: {
  workspaceId: string; provider: Provider; connectionId: string; previousSubject: string;
  subject: string; email: string | null; name: string | null; ciphertext: string; keyId: string;
  tokenExpiresAt: number | null; createdByEmail: string; keepCustomerIds: readonly string[];
}, now = Date.now()): Promise<boolean> {
  const [updated] = await db.batch([
    db.prepare(`UPDATE connection SET provider_subject = ?, provider_email = ?, provider_name = ?,
        refresh_token_ciphertext = ?, token_key_id = ?, token_expires_at = ?, status = 'active', created_by_email = ?,
        accounts_discovered_at = NULL, created_at = ?, updated_at = ?
      WHERE workspace_id = ? AND id = ? AND provider = ? AND provider_subject = ?`)
      .bind(value.subject, value.email, value.name, value.ciphertext, value.keyId, value.tokenExpiresAt,
        value.createdByEmail, now, now, value.workspaceId, value.connectionId, value.provider, value.previousSubject),
    // Runs only when the UPDATE above applied (the connection now has the new identity).
    db.prepare(`DELETE FROM connected_account WHERE workspace_id = ? AND connection_id = ?
        AND customer_id NOT IN (SELECT value FROM json_each(?))
        AND EXISTS (SELECT 1 FROM connection c WHERE c.workspace_id = ? AND c.id = ? AND c.provider_subject = ?)`)
      .bind(value.workspaceId, value.connectionId, JSON.stringify(value.keepCustomerIds),
        value.workspaceId, value.connectionId, value.subject),
    db.prepare('DELETE FROM pending_connection WHERE workspace_id = ? AND provider = ?').bind(value.workspaceId, value.provider),
  ]);
  return (updated?.meta.changes ?? 0) > 0;
}

/** Marks a grant revoked/error/expired only if it is still the grant the caller used. */
export async function setConnectionStatus(
  db: D1Database, workspaceId: string, connectionId: string, ciphertext: string, status: ConnectionStatus, now = Date.now(),
): Promise<void> {
  await db.prepare(`UPDATE connection SET status = ?, updated_at = ?
    WHERE workspace_id = ? AND id = ? AND refresh_token_ciphertext = ?`)
    .bind(status, now, workspaceId, connectionId, ciphertext).run();
}

/** Deletes the grant (ciphertext included) and, by cascade, its accounts. */
export async function deleteConnection(db: D1Database, workspaceId: string, connectionId: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM connection WHERE workspace_id = ? AND id = ?')
    .bind(workspaceId, connectionId).run();
  return (result.meta.changes ?? 0) > 0;
}

// ── Connected accounts ─────────────────────────────────────────────────────

export type AccountStatus = 'ENABLED' | 'CANCELED' | 'SUSPENDED' | 'CLOSED' | 'UNKNOWN' | 'UNREADABLE'
  // Meta account_status values (1 ACTIVE is stored as ENABLED, 101 CLOSED as CLOSED).
  | 'DISABLED' | 'UNSETTLED' | 'PENDING_RISK_REVIEW' | 'PENDING_SETTLEMENT' | 'IN_GRACE_PERIOD' | 'PENDING_CLOSURE';

export interface DiscoveredAccount {
  readonly customerId: string;
  readonly name: string | null;
  readonly currencyCode: string | null;
  readonly timeZone: string | null;
  readonly manager: boolean;
  readonly status: AccountStatus;
  readonly loginCustomerId: string;
  readonly managerCustomerId: string | null;
  /** Meta: the business portfolio that owns the ad account. */
  readonly businessId?: string | null;
  readonly businessName?: string | null;
  readonly eligible: boolean;
}

/**
 * The result of one account discovery. `incompleteLogins`: login customers
 * (Google: accessible roots) whose account hierarchy could not be read this
 * time, so the accounts reached through them are neither confirmed nor known to
 * be gone. Meta's discovery is all-or-nothing and returns a plain list.
 */
export interface Discovery {
  readonly accounts: readonly DiscoveredAccount[];
  readonly incompleteLogins: ReadonlySet<string>;
}

export interface AccountRow extends DiscoveredAccount {
  /** connected_account.id: stable across rediscovery while the account stays listed. */
  readonly id: string;
  readonly businessId: string | null;
  readonly businessName: string | null;
  readonly selected: boolean;
  /** Epoch ms since when discoveries could not confirm the account (kept as it was); null when confirmed. */
  readonly staleSince: number | null;
}

interface AccountRecord {
  id: string; customer_id: string; descriptive_name: string | null; currency_code: string | null; time_zone: string | null;
  is_manager: number; account_status: AccountStatus; login_customer_id: string; manager_customer_id: string | null;
  business_id: string | null; business_name: string | null; eligible: number; selected: number; stale_since: number | null;
}

const account = (row: AccountRecord): AccountRow => ({
  id: row.id, customerId: row.customer_id, name: row.descriptive_name, currencyCode: row.currency_code, timeZone: row.time_zone,
  manager: row.is_manager === 1, status: row.account_status, loginCustomerId: row.login_customer_id,
  managerCustomerId: row.manager_customer_id, businessId: row.business_id, businessName: row.business_name,
  eligible: row.eligible === 1, selected: row.selected === 1, staleSince: row.stale_since,
});

const ACCOUNT_COLUMNS = `id, customer_id, descriptive_name, currency_code, time_zone, is_manager, account_status,
  login_customer_id, manager_customer_id, business_id, business_name, eligible, selected, stale_since`;

export async function listAccounts(db: D1Database, workspaceId: string, connectionId: string): Promise<AccountRow[]> {
  const { results } = await db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM connected_account
    WHERE workspace_id = ? AND connection_id = ? ORDER BY eligible DESC, descriptive_name COLLATE NOCASE, customer_id`)
    .bind(workspaceId, connectionId).all<AccountRecord>();
  return results.map(account);
}

export async function listSelectedAccounts(db: D1Database, workspaceId: string, connectionId: string): Promise<AccountRow[]> {
  const { results } = await db.prepare(`SELECT ${ACCOUNT_COLUMNS} FROM connected_account
    WHERE workspace_id = ? AND connection_id = ? AND selected = 1 AND eligible = 1 ORDER BY customer_id`)
    .bind(workspaceId, connectionId).all<AccountRecord>();
  return results.map(account);
}

/**
 * SQL condition: the account carries a user decision (it is selected, or assigned
 * to a project). Such an account is never deleted by automatic rediscovery, only
 * by an explicit admin action (removeStaleAccount) or by disconnecting.
 */
const UNDECIDED = `selected = 0 AND NOT EXISTS (SELECT 1 FROM project_account p
  WHERE p.workspace_id = connected_account.workspace_id AND p.connected_account_id = connected_account.id)`;

/**
 * Reconciles the stored accounts of a connection with a discovery, in one
 * transaction. Accounts that are still listed keep their row (and so their id,
 * selection while still eligible, and project).
 *
 * Invariant: a stored account that is selected or assigned to a project is never
 * deleted here. When the discovery does not list it (for whatever reason: a
 * transient failure, a manager Google answered for only partly, access really
 * removed), it is kept exactly as it was and marked stale; an admin removes it
 * explicitly. Accounts reached through a login customer the discovery could not
 * read (`incompleteLogins`) are kept and marked stale the same way, including
 * when the discovery only has an UNREADABLE placeholder for them. Any other
 * account that is no longer listed (unselected, unassigned) is deleted. The
 * selected/assigned check is part of the DELETE itself, so a concurrent
 * selection or assignment is never lost. When nothing is selected afterwards and
 * exactly one account is eligible, it is selected. Returns the stored list.
 */
export async function replaceAccounts(
  db: D1Database, workspaceId: string, connectionId: string,
  discovery: readonly DiscoveredAccount[] | Discovery, now = Date.now(),
): Promise<AccountRow[]> {
  const found = 'accounts' in discovery ? discovery.accounts : discovery;
  const incomplete = 'accounts' in discovery ? discovery.incompleteLogins : new Set<string>();
  const stored = await listAccounts(db, workspaceId, connectionId);
  // What earlier discoveries actually read (an UNREADABLE row has nothing to preserve).
  const known = new Set(stored.filter(row => row.status !== 'UNREADABLE').map(row => row.customerId));
  // A discovered entry reached through an unread root is a placeholder (the root
  // itself, UNREADABLE): it never overwrites what an earlier discovery read. Real
  // rows of a root that is incomplete only because of a sub-manager still refresh.
  const placeholder = (item: DiscoveredAccount) => item.status === 'UNREADABLE'
    && incomplete.has(item.loginCustomerId) && known.has(item.customerId);
  const discovered = found.filter(item => !placeholder(item));
  const listed = new Set(discovered.map(item => item.customerId));
  const kept = stored.filter(row => !listed.has(row.customerId)
    && (incomplete.has(row.loginCustomerId) || (known.has(row.customerId) && found.some(item => item.customerId === row.customerId))));
  const keptIds = new Set(kept.map(row => row.customerId));
  const missing = stored.filter(row => !listed.has(row.customerId));
  const removable = missing.filter(row => !keptIds.has(row.customerId));
  // Rows the DELETE below will keep anyway (user decisions); only used to decide auto-selection.
  const { results: assignedRows } = await db.prepare(`SELECT connected_account_id FROM project_account
    WHERE workspace_id = ? AND connected_account_id IN (SELECT id FROM connected_account WHERE workspace_id = ? AND connection_id = ?)`)
    .bind(workspaceId, workspaceId, connectionId).all<{ connected_account_id: string }>();
  const assigned = new Set(assignedRows.map(row => row.connected_account_id));
  const staying = missing.filter(row => keptIds.has(row.customerId) || row.selected || assigned.has(row.id));

  const previous = new Set(stored.filter(row => row.selected && row.eligible).map(row => row.customerId));
  const eligible = discovered.filter(item => item.eligible);
  let selected = new Set(eligible.filter(item => previous.has(item.customerId)).map(item => item.customerId));
  const keptSelected = staying.some(row => row.selected && row.eligible);
  const eligibleCount = eligible.length + staying.filter(row => row.eligible).length;
  if (selected.size === 0 && !keptSelected && eligibleCount === 1 && eligible.length === 1) selected = new Set([eligible[0]!.customerId]);
  await db.batch([
    ...removable.map(row => db.prepare(
      `DELETE FROM connected_account WHERE workspace_id = ? AND connection_id = ? AND id = ? AND ${UNDECIDED}`,
    ).bind(workspaceId, connectionId, row.id)),
    // Every missing row that survived the DELETE (incomplete root, or a user decision) is marked stale.
    ...missing.map(row => db.prepare(`UPDATE connected_account SET stale_since = coalesce(stale_since, ?)
      WHERE workspace_id = ? AND connection_id = ? AND id = ?`).bind(now, workspaceId, connectionId, row.id)),
    ...discovered.map(item => db.prepare(`INSERT INTO connected_account (id, workspace_id, connection_id, customer_id,
        descriptive_name, currency_code, time_zone, is_manager, account_status, login_customer_id, manager_customer_id,
        business_id, business_name, eligible, selected, discovered_at, stale_since)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT (connection_id, customer_id) DO UPDATE SET descriptive_name = excluded.descriptive_name,
        currency_code = excluded.currency_code, time_zone = excluded.time_zone, is_manager = excluded.is_manager,
        account_status = excluded.account_status, login_customer_id = excluded.login_customer_id,
        manager_customer_id = excluded.manager_customer_id, business_id = excluded.business_id,
        business_name = excluded.business_name, eligible = excluded.eligible, selected = excluded.selected,
        discovered_at = excluded.discovered_at, stale_since = NULL
      WHERE connected_account.workspace_id = excluded.workspace_id`)
      .bind(crypto.randomUUID(), workspaceId, connectionId, item.customerId, item.name, item.currencyCode, item.timeZone,
        item.manager ? 1 : 0, item.status, item.loginCustomerId, item.managerCustomerId, item.businessId ?? null,
        item.businessName ?? null, item.eligible ? 1 : 0, selected.has(item.customerId) ? 1 : 0, now)),
    db.prepare('UPDATE connection SET accounts_discovered_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ?')
      .bind(now, now, workspaceId, connectionId),
  ]);
  return listAccounts(db, workspaceId, connectionId);
}

/**
 * Explicit admin action: deletes one account that the last discoveries could not
 * confirm (stale), with its project assignment (cascade). Accounts that are
 * still listed are never removed this way. Returns whether a row was deleted.
 */
export async function removeStaleAccount(
  db: D1Database, workspaceId: string, connectionId: string, customerId: string,
): Promise<boolean> {
  const result = await db.prepare(`DELETE FROM connected_account
    WHERE workspace_id = ? AND connection_id = ? AND customer_id = ? AND stale_since IS NOT NULL`)
    .bind(workspaceId, connectionId, customerId).run();
  return (result.meta.changes ?? 0) > 0;
}

/** Sets exactly `customerIds` as selected; the caller has checked they are eligible accounts of this connection. */
export async function setSelectedAccounts(
  db: D1Database, workspaceId: string, connectionId: string, customerIds: readonly string[],
): Promise<void> {
  await db.batch([
    db.prepare('UPDATE connected_account SET selected = 0 WHERE workspace_id = ? AND connection_id = ?')
      .bind(workspaceId, connectionId),
    ...customerIds.map(id => db.prepare(`UPDATE connected_account SET selected = 1
      WHERE workspace_id = ? AND connection_id = ? AND customer_id = ? AND eligible = 1`)
      .bind(workspaceId, connectionId, id)),
  ]);
}

// ── Projects ───────────────────────────────────────────────────────────────

export interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
}

/** A connected account of any provider, with the project it belongs to (null: unassigned). */
export interface WorkspaceAccountRow {
  readonly id: string;
  readonly provider: Provider;
  readonly customerId: string;
  readonly name: string | null;
  readonly currencyCode: string | null;
  /** The account's reporting time zone (IANA), when known. */
  readonly timeZone: string | null;
  readonly eligible: boolean;
  readonly selected: boolean;
  readonly projectId: string | null;
}

export async function listProjects(db: D1Database, workspaceId: string): Promise<ProjectRow[]> {
  const { results } = await db.prepare(`SELECT id, name, created_at FROM project WHERE workspace_id = ?
    ORDER BY name COLLATE NOCASE, created_at, id`).bind(workspaceId)
    .all<{ id: string; name: string; created_at: number }>();
  return results.map(row => ({ id: row.id, name: row.name, createdAt: row.created_at }));
}

/** Every connected account of the workspace (all providers) with its project. */
export async function listWorkspaceAccounts(db: D1Database, workspaceId: string): Promise<WorkspaceAccountRow[]> {
  const { results } = await db.prepare(`SELECT a.id, c.provider, a.customer_id, a.descriptive_name, a.currency_code,
      a.time_zone, a.eligible, a.selected, p.project_id
    FROM connected_account a
    JOIN connection c ON c.workspace_id = a.workspace_id AND c.id = a.connection_id
    LEFT JOIN project_account p ON p.workspace_id = a.workspace_id AND p.connected_account_id = a.id
    WHERE a.workspace_id = ?
    ORDER BY c.provider, a.descriptive_name COLLATE NOCASE, a.customer_id`).bind(workspaceId)
    .all<{
      id: string; provider: Provider; customer_id: string; descriptive_name: string | null; currency_code: string | null;
      time_zone: string | null; eligible: number; selected: number; project_id: string | null;
    }>();
  return results.map(row => ({
    id: row.id, provider: row.provider, customerId: row.customer_id, name: row.descriptive_name,
    currencyCode: row.currency_code, timeZone: row.time_zone, eligible: row.eligible === 1, selected: row.selected === 1,
    projectId: row.project_id,
  }));
}

/** A project to create (with a caller-generated id) and the accounts to move into it. */
export interface ProjectChange {
  /** Create this project first; omitted when the assignments target existing projects. */
  readonly create?: { readonly id: string; readonly name: string };
  /** Account → project (null: unassign). The caller has checked both belong to the workspace. */
  readonly assignments?: readonly { readonly accountId: string; readonly projectId: string | null }[];
}

const isUniqueViolation = (error: unknown) => error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
const isForeignKeyViolation = (error: unknown) => error instanceof Error && /FOREIGN KEY constraint failed/i.test(error.message);

/**
 * Creates projects and (re)assigns accounts in one transaction. The composite
 * foreign keys reject any id of another workspace. Nothing is written unless
 * everything applies: `name_taken` when a project name is already used in the
 * workspace, `stale` when a project or account no longer exists.
 */
export async function applyProjectChanges(
  db: D1Database, workspaceId: string, changes: readonly ProjectChange[], now = Date.now(),
): Promise<'applied' | 'name_taken' | 'stale'> {
  const statements: D1PreparedStatement[] = [];
  for (const change of changes) {
    if (change.create) {
      statements.push(db.prepare('INSERT INTO project (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)')
        .bind(change.create.id, workspaceId, change.create.name, now));
    }
    for (const { accountId, projectId } of change.assignments ?? []) {
      statements.push(projectId === null
        ? db.prepare('DELETE FROM project_account WHERE workspace_id = ? AND connected_account_id = ?').bind(workspaceId, accountId)
        : db.prepare(`INSERT INTO project_account (connected_account_id, workspace_id, project_id, created_at) VALUES (?, ?, ?, ?)
            ON CONFLICT (connected_account_id) DO UPDATE SET project_id = excluded.project_id, created_at = excluded.created_at
            WHERE project_account.workspace_id = excluded.workspace_id`)
          .bind(accountId, workspaceId, projectId, now));
    }
  }
  if (!statements.length) return 'applied';
  try {
    await db.batch(statements);
  } catch (error) {
    if (isUniqueViolation(error)) return 'name_taken';
    if (isForeignKeyViolation(error)) return 'stale';
    throw error;
  }
  return 'applied';
}

/** 'conflict' when another project of the workspace already has that name. */
export async function renameProject(
  db: D1Database, workspaceId: string, projectId: string, name: string,
): Promise<'renamed' | 'not_found' | 'conflict'> {
  try {
    const result = await db.prepare('UPDATE project SET name = ? WHERE workspace_id = ? AND id = ?')
      .bind(name, workspaceId, projectId).run();
    return (result.meta.changes ?? 0) > 0 ? 'renamed' : 'not_found';
  } catch (error) {
    if (isUniqueViolation(error)) return 'conflict';
    throw error;
  }
}

/** Deletes the project; its accounts become unassigned (cascade). */
export async function deleteProject(db: D1Database, workspaceId: string, projectId: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM project WHERE workspace_id = ? AND id = ?').bind(workspaceId, projectId).run();
  return (result.meta.changes ?? 0) > 0;
}

// ── OAuth state ────────────────────────────────────────────────────────────

export const OAUTH_STATE_TTL_MS = 10 * 60_000;

export interface OAuthStateRow {
  readonly workspaceId: string;
  readonly email: string;
  readonly provider: Provider;
  /** Google's PKCE verifier; null for Meta (confidential web flow without PKCE). */
  readonly codeVerifier: string | null;
  readonly expiresAt: number;
}

/** One pending authorization per (workspace, email, provider); expired rows are purged. */
export async function createOAuthState(db: D1Database, value: {
  stateHash: string; workspaceId: string; email: string; provider: Provider; codeVerifier: string | null;
}, now = Date.now()): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM oauth_state WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM oauth_state WHERE workspace_id = ? AND email = ? AND provider = ?')
      .bind(value.workspaceId, value.email, value.provider),
    db.prepare(`INSERT INTO oauth_state (state_hash, workspace_id, email, provider, code_verifier, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(value.stateHash, value.workspaceId, value.email, value.provider, value.codeVerifier, now, now + OAUTH_STATE_TTL_MS),
  ]);
}

/** Atomically deletes and returns the state: a second presentation finds nothing. */
export async function consumeOAuthState(db: D1Database, stateHash: string): Promise<OAuthStateRow | null> {
  const { results } = await db.prepare(`DELETE FROM oauth_state WHERE state_hash = ?
    RETURNING workspace_id, email, provider, code_verifier, expires_at`).bind(stateHash)
    .all<{ workspace_id: string; email: string; provider: Provider; code_verifier: string | null; expires_at: number }>();
  const row = results[0];
  return row ? {
    workspaceId: row.workspace_id, email: row.email, provider: row.provider,
    codeVerifier: row.code_verifier, expiresAt: row.expires_at,
  } : null;
}

// ── Instance Google setup (self-hosting wizard) ────────────────────────────

export type SetupStep = 'api' | 'explorer' | 'consent' | 'client';
const STEP_COLUMNS: Record<SetupStep, string> = {
  api: 'api_enabled_at', explorer: 'explorer_requested_at', consent: 'consent_configured_at', client: 'client_created_at',
};

export interface GoogleSetupRow {
  readonly projectId: string | null;
  readonly steps: Readonly<Record<SetupStep, number | null>>;
  readonly client: {
    readonly clientId: string;
    readonly secretCiphertext: string;
    readonly secretKeyId: string;
    readonly secretLast4: string;
    readonly updatedBy: string | null;
    readonly updatedAt: number | null;
  } | null;
}

interface SetupRecord {
  project_id: string | null; api_enabled_at: number | null; explorer_requested_at: number | null;
  consent_configured_at: number | null; client_created_at: number | null; client_id: string | null;
  client_secret_ciphertext: string | null; client_secret_key_id: string | null; client_secret_last4: string | null;
  client_updated_by: string | null; client_updated_at: number | null;
}

export async function getGoogleSetup(db: D1Database): Promise<GoogleSetupRow | null> {
  const row = await db.prepare('SELECT * FROM google_setup WHERE id = 1').first<SetupRecord>();
  if (!row) return null;
  return {
    projectId: row.project_id,
    steps: {
      api: row.api_enabled_at, explorer: row.explorer_requested_at,
      consent: row.consent_configured_at, client: row.client_created_at,
    },
    client: row.client_id && row.client_secret_ciphertext && row.client_secret_key_id && row.client_secret_last4 ? {
      clientId: row.client_id, secretCiphertext: row.client_secret_ciphertext, secretKeyId: row.client_secret_key_id,
      secretLast4: row.client_secret_last4, updatedBy: row.client_updated_by, updatedAt: row.client_updated_at,
    } : null,
  };
}

const ENSURE_SETUP = 'INSERT OR IGNORE INTO google_setup (id, updated_at) VALUES (1, ?)';

/** Saves wizard progress: the project ID (null clears it) and done/not-done per step. */
export async function saveGoogleSetupProgress(db: D1Database, change: {
  projectId?: string | null; steps?: Partial<Record<SetupStep, boolean>>;
}, now = Date.now()): Promise<void> {
  const statements = [db.prepare(ENSURE_SETUP).bind(now)];
  if (change.projectId !== undefined) {
    statements.push(db.prepare('UPDATE google_setup SET project_id = ?, updated_at = ? WHERE id = 1').bind(change.projectId, now));
  }
  for (const [step, done] of Object.entries(change.steps ?? {}) as [SetupStep, boolean][]) {
    const column = STEP_COLUMNS[step];
    // Keep the first completion time; clearing sets NULL.
    statements.push(db.prepare(`UPDATE google_setup SET ${column} = ${done ? `coalesce(${column}, ?)` : 'NULL'}, updated_at = ? WHERE id = 1`)
      .bind(...(done ? [now, now] : [now])));
  }
  await db.batch(statements);
}

/**
 * Stores the instance OAuth client (secret already sealed). A different client
 * ID invalidates every Google grant issued to the previous client, so those
 * connections are marked `error` (shown as "reconnect"); the same client ID
 * (for example a rotated secret) keeps them.
 */
export async function saveGoogleClient(db: D1Database, value: {
  clientId: string; secretCiphertext: string; secretKeyId: string; secretLast4: string; updatedBy: string;
}, previousClientId: string | null, now = Date.now()): Promise<void> {
  const statements = [
    db.prepare(ENSURE_SETUP).bind(now),
    db.prepare(`UPDATE google_setup SET client_id = ?, client_secret_ciphertext = ?, client_secret_key_id = ?,
      client_secret_last4 = ?, client_updated_by = ?, client_updated_at = ?, updated_at = ? WHERE id = 1`)
      .bind(value.clientId, value.secretCiphertext, value.secretKeyId, value.secretLast4, value.updatedBy, now, now),
  ];
  if (previousClientId !== null && previousClientId !== value.clientId) {
    statements.push(db.prepare("UPDATE connection SET status = 'error', updated_at = ? WHERE provider = 'google_ads' AND status = 'active'").bind(now));
  }
  await db.batch(statements);
}

export async function deleteGoogleClient(db: D1Database, now = Date.now()): Promise<void> {
  await db.prepare(`UPDATE google_setup SET client_id = NULL, client_secret_ciphertext = NULL, client_secret_key_id = NULL,
    client_secret_last4 = NULL, client_updated_by = NULL, client_updated_at = NULL, updated_at = ? WHERE id = 1`).bind(now).run();
}

// ── Instance Meta setup (self-hosting wizard) ──────────────────────────────

export type MetaSetupStep = 'app' | 'login' | 'access';
const META_STEP_COLUMNS: Record<MetaSetupStep, string> = {
  app: 'app_created_at', login: 'login_configured_at', access: 'access_confirmed_at',
};

export interface MetaSetupRow {
  readonly appId: string | null;
  readonly steps: Readonly<Record<MetaSetupStep, number | null>>;
  readonly secret: {
    readonly ciphertext: string;
    readonly keyId: string;
    readonly last4: string;
    readonly updatedBy: string | null;
    readonly updatedAt: number | null;
  } | null;
  readonly conversionActionType: string | null;
}

interface MetaSetupRecord {
  app_id: string | null; app_created_at: number | null; login_configured_at: number | null;
  access_confirmed_at: number | null; app_secret_ciphertext: string | null; app_secret_key_id: string | null;
  app_secret_last4: string | null; app_secret_updated_by: string | null; app_secret_updated_at: number | null;
  conversion_action_type: string | null;
}

export async function getMetaSetup(db: D1Database): Promise<MetaSetupRow | null> {
  const row = await db.prepare('SELECT * FROM meta_setup WHERE id = 1').first<MetaSetupRecord>();
  if (!row) return null;
  return {
    appId: row.app_id,
    steps: { app: row.app_created_at, login: row.login_configured_at, access: row.access_confirmed_at },
    secret: row.app_secret_ciphertext && row.app_secret_key_id && row.app_secret_last4 ? {
      ciphertext: row.app_secret_ciphertext, keyId: row.app_secret_key_id, last4: row.app_secret_last4,
      updatedBy: row.app_secret_updated_by, updatedAt: row.app_secret_updated_at,
    } : null,
    conversionActionType: row.conversion_action_type,
  };
}

const ENSURE_META_SETUP = 'INSERT OR IGNORE INTO meta_setup (id, updated_at) VALUES (1, ?)';
const CLEAR_META_SECRET = `app_secret_ciphertext = NULL, app_secret_key_id = NULL, app_secret_last4 = NULL,
  app_secret_updated_by = NULL, app_secret_updated_at = NULL`;
/** Grants belong to the Meta app that issued them: another app invalidates them all. */
const INVALIDATE_META_GRANTS = "UPDATE connection SET status = 'error', updated_at = ? WHERE provider = 'meta_ads' AND status = 'active'";

/**
 * Saves wizard progress: the App ID and done/not-done per step. A different App
 * ID clears a stored App Secret (it belongs to the previous app) and marks Meta
 * connections `error` (their tokens were issued to the previous app).
 */
export async function saveMetaSetupProgress(db: D1Database, change: {
  appId?: string; steps?: Partial<Record<MetaSetupStep, boolean>>;
}, now = Date.now()): Promise<void> {
  const statements = [db.prepare(ENSURE_META_SETUP).bind(now)];
  if (change.appId !== undefined) {
    const current = await getMetaSetup(db);
    if (current?.appId && current.appId !== change.appId) {
      statements.push(db.prepare(`UPDATE meta_setup SET ${CLEAR_META_SECRET}, updated_at = ? WHERE id = 1`).bind(now));
      statements.push(db.prepare(INVALIDATE_META_GRANTS).bind(now));
    }
    statements.push(db.prepare('UPDATE meta_setup SET app_id = ?, updated_at = ? WHERE id = 1').bind(change.appId, now));
  }
  for (const [step, done] of Object.entries(change.steps ?? {}) as [MetaSetupStep, boolean][]) {
    const column = META_STEP_COLUMNS[step];
    statements.push(db.prepare(`UPDATE meta_setup SET ${column} = ${done ? `coalesce(${column}, ?)` : 'NULL'}, updated_at = ? WHERE id = 1`)
      .bind(...(done ? [now, now] : [now])));
  }
  await db.batch(statements);
}

/** Stores the App ID with its (already sealed) App Secret; see saveMetaSetupProgress for a changed App ID. */
export async function saveMetaApp(db: D1Database, value: {
  appId: string; secretCiphertext: string; secretKeyId: string; secretLast4: string; updatedBy: string;
}, now = Date.now()): Promise<void> {
  const previous = (await getMetaSetup(db))?.appId ?? null;
  const statements = [
    db.prepare(ENSURE_META_SETUP).bind(now),
    db.prepare(`UPDATE meta_setup SET app_id = ?, app_secret_ciphertext = ?, app_secret_key_id = ?, app_secret_last4 = ?,
      app_secret_updated_by = ?, app_secret_updated_at = ?, updated_at = ? WHERE id = 1`)
      .bind(value.appId, value.secretCiphertext, value.secretKeyId, value.secretLast4, value.updatedBy, now, now),
  ];
  if (previous !== null && previous !== value.appId) statements.push(db.prepare(INVALIDATE_META_GRANTS).bind(now));
  await db.batch(statements);
}

/** Removes the stored App Secret (the App ID stays for the wizard's links). */
export async function deleteMetaSecret(db: D1Database, now = Date.now()): Promise<void> {
  await db.prepare(`UPDATE meta_setup SET ${CLEAR_META_SECRET}, updated_at = ? WHERE id = 1`).bind(now).run();
}

/** Sets (or, with null, resets to the default) the conversion action type. */
export async function saveMetaConversionActionType(db: D1Database, actionType: string | null, now = Date.now()): Promise<void> {
  await db.batch([
    db.prepare(ENSURE_META_SETUP).bind(now),
    db.prepare('UPDATE meta_setup SET conversion_action_type = ?, updated_at = ? WHERE id = 1').bind(actionType, now),
  ]);
}
