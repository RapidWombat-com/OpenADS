// Google Ads account discovery: customers:listAccessibleCustomers, then one
// read-only GAQL query on customer_client (level <= 1) per accessible customer
// to expand manager accounts into their direct children.
// https://developers.google.com/google-ads/api/docs/account-management/listing-accounts
import {
  adsHeaders, adsRequest, customerId, GoogleAdsApiError, searchAll, type AdsAuth, type AdsSetupIssue,
} from '../providers/google.ts';
import { isRecord } from '../providers/http.ts';
import type { Fetcher } from '../providers/types.ts';
import type { AccountStatus, DiscoveredAccount, Discovery } from '../store.ts';

const MAX_ROOTS = 100;
const MAX_ACCOUNTS = 5_000;
const CONCURRENCY = 4;
const TIMEOUT_MS = 25_000;
const STATUSES = new Set(['ENABLED', 'CANCELED', 'SUSPENDED', 'CLOSED']);
const currencies = new Intl.DisplayNames('en', { type: 'currency', fallback: 'none' });
const CLIENT_QUERY = 'SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.manager, customer_client.level, customer_client.status FROM customer_client WHERE customer_client.level <= 1';

function validTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

interface ClientRow {
  customerId: string;
  level: number;
  name: string | null;
  currencyCode: string | null;
  timeZone: string | null;
  manager: boolean;
  status: AccountStatus;
}

/** Protobuf JSON omits default values (false, 0, ""), so absent fields take them. */
function clientRow(value: unknown): ClientRow {
  if (!isRecord(value) || !isRecord(value.customerClient)) throw new Error('Invalid account');
  const client = value.customerClient;
  const id = typeof client.id === 'string' || typeof client.id === 'number' ? customerId(String(client.id)) : null;
  const level = client.level === undefined ? 0 : Number(client.level);
  if (!id || !Number.isInteger(level) || level < 0 || level > 1
    || (client.manager !== undefined && typeof client.manager !== 'boolean')
    || (client.descriptiveName !== undefined && typeof client.descriptiveName !== 'string')) {
    throw new Error('Invalid account');
  }
  const name = typeof client.descriptiveName === 'string' && client.descriptiveName.trim()
    ? client.descriptiveName.slice(0, 1024) : null;
  const currencyCode = typeof client.currencyCode === 'string' && /^[A-Z]{3}$/.test(client.currencyCode)
    && currencies.of(client.currencyCode) !== undefined ? client.currencyCode : null;
  const timeZone = validTimeZone(client.timeZone) ? client.timeZone : null;
  const status = typeof client.status === 'string' && STATUSES.has(client.status)
    ? client.status as AccountStatus : 'UNKNOWN';
  return { customerId: id, level, name, currencyCode, timeZone, manager: client.manager === true, status };
}

function discovered(row: ClientRow, loginCustomerId: string, managerCustomerId: string | null): DiscoveredAccount {
  return {
    customerId: row.customerId, name: row.name, currencyCode: row.currencyCode, timeZone: row.timeZone,
    manager: row.manager, status: row.status, loginCustomerId, managerCustomerId,
    // Reportable: an enabled client (not manager) account with a known currency and timezone.
    eligible: !row.manager && row.status === 'ENABLED' && row.currencyCode !== null && row.timeZone !== null,
  };
}

/**
 * Every account the grant can read, deduplicated by customer ID. Direct access
 * wins over access through a manager. A root that cannot be queried (cancelled,
 * suspended, permission removed or a transient failure) is listed as UNREADABLE,
 * never as eligible, and reported in `incompleteLogins`: its children are
 * unknown this time, not gone, so reconciliation (replaceAccounts) keeps what it
 * stored for them. Throws when the accessible-customer list itself fails, and
 * a GoogleAdsApiError with an `issue` when Google reports a Cloud project setup problem.
 * A query that succeeds without the root's own row counts as not read.
 */
export async function discoverAccounts(auth: AdsAuth, fetcher: Fetcher): Promise<Discovery> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const list = await adsRequest(fetcher, `https://googleads.googleapis.com/${auth.version}/customers:listAccessibleCustomers`, {
    method: 'GET', headers: adsHeaders(auth, null),
  }, signal);
  const names = list.resourceNames === undefined ? [] : list.resourceNames;
  if (!Array.isArray(names) || names.length > MAX_ROOTS) throw new Error('Invalid customer list');
  const roots = [...new Set(names.map(name => {
    const match = typeof name === 'string' ? /^customers\/(\d{1,20})$/.exec(name) : null;
    const id = match ? customerId(match[1]) : null;
    if (!id) throw new Error('Invalid customer list');
    return id;
  }))].sort();

  const perRoot = new Map<string, ClientRow[] | null>();
  let setupIssue: AdsSetupIssue | null = null;
  let total = 0;
  let next = 0;
  const worker = async () => {
    while (next < roots.length) {
      const root = roots[next++]!;
      const rows: ClientRow[] = [];
      try {
        await searchAll(fetcher, auth, root, root, CLIENT_QUERY, signal, results => {
          total += results.length;
          if (total > MAX_ACCOUNTS) throw new Error('Account limit');
          for (const value of results) rows.push(clientRow(value));
        });
        perRoot.set(root, rows);
      } catch (error) {
        if (signal.aborted || (error instanceof Error && error.message === 'Account limit')) throw error;
        if (error instanceof GoogleAdsApiError && error.issue) setupIssue ??= error.issue;
        perRoot.set(root, null);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, roots.length) }, worker));
  // A Cloud project problem (API disabled, Test access only) is not an account
  // problem: report it instead of listing every account as unreadable.
  if (setupIssue) throw new GoogleAdsApiError(setupIssue);

  const accounts = new Map<string, DiscoveredAccount>();
  // Pass 1: the accessible customers themselves (direct access).
  for (const root of roots) {
    const rows = perRoot.get(root);
    const self = rows?.find(row => row.level === 0 && row.customerId === root);
    accounts.set(root, self ? discovered(self, root, null) : {
      customerId: root, name: null, currencyCode: null, timeZone: null, manager: false,
      status: 'UNREADABLE', loginCustomerId: root, managerCustomerId: null, eligible: false,
    });
  }
  // Pass 2: direct children of manager roots, reached with the manager as login customer.
  for (const root of roots) {
    const parent = accounts.get(root);
    if (!parent?.manager) continue;
    for (const row of perRoot.get(root) ?? []) {
      if (row.level !== 1 || accounts.has(row.customerId)) continue;
      accounts.set(row.customerId, discovered(row, root, root));
    }
  }
  // A root whose query failed or did not return its own row was not read: what
  // is stored under it is kept (stale). This only spares unselected, unassigned
  // accounts from pruning; selected or assigned accounts are never deleted by
  // rediscovery at all (see replaceAccounts), whatever this reports.
  const incompleteLogins = new Set(roots.filter(root =>
    !perRoot.get(root)?.some(row => row.level === 0 && row.customerId === root)));
  return { accounts: [...accounts.values()], incompleteLogins };
}
