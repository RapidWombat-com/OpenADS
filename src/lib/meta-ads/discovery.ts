// Meta ad account discovery: `/me/adaccounts` (ads_read), paginated with opaque
// cursors on the fixed host. Accounts reached through a business portfolio are
// included when the person has a role on them.
// https://developers.facebook.com/documentation/ads-commerce/marketing-api/reference/ad-account
import { isRecord } from '../providers/http.ts';
import type { Fetcher } from '../providers/types.ts';
import type { AccountStatus, DiscoveredAccount } from '../store.ts';
import { graphRequest, graphUrl, MetaGraphError, nextCursor } from './graph.ts';

const MAX_PAGES = 50;
const MAX_ACCOUNTS = 5_000;
const PAGE_SIZE = '100';
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 25_000;
const FIELDS = 'id,account_id,name,currency,timezone_name,account_status';
const currencies = new Intl.DisplayNames('en', { type: 'currency', fallback: 'none' });

/**
 * Meta's numeric account_status. Reports can be read for open accounts (active,
 * unsettled, under review, pending settlement, in grace period); disabled,
 * closing and closed accounts are listed but not selectable.
 */
const STATUSES: Record<number, { status: AccountStatus; reportable: boolean }> = {
  1: { status: 'ENABLED', reportable: true },
  2: { status: 'DISABLED', reportable: false },
  3: { status: 'UNSETTLED', reportable: true },
  7: { status: 'PENDING_RISK_REVIEW', reportable: true },
  8: { status: 'PENDING_SETTLEMENT', reportable: true },
  9: { status: 'IN_GRACE_PERIOD', reportable: true },
  100: { status: 'PENDING_CLOSURE', reportable: false },
  101: { status: 'CLOSED', reportable: false },
};

function validTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** One `/me/adaccounts` entry; throws on a malformed one (the whole discovery fails closed). */
export function adAccount(value: unknown): DiscoveredAccount {
  if (!isRecord(value)) throw new MetaGraphError('other');
  const id = typeof value.account_id === 'string' ? value.account_id
    : typeof value.id === 'string' ? value.id.replace(/^act_/, '') : null;
  if (!id || !/^[1-9]\d{0,19}$/.test(id) || (typeof value.id === 'string' && value.id !== `act_${id}`)) {
    throw new MetaGraphError('other');
  }
  if (value.name !== undefined && typeof value.name !== 'string') throw new MetaGraphError('other');
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.slice(0, 1024) : null;
  const currencyCode = typeof value.currency === 'string' && /^[A-Z]{3}$/.test(value.currency)
    && currencies.of(value.currency) !== undefined ? value.currency : null;
  const timeZone = validTimeZone(value.timezone_name) ? value.timezone_name : null;
  const known = typeof value.account_status === 'number' ? STATUSES[value.account_status] : undefined;
  const business = isRecord(value.business) ? value.business : null;
  const businessId = business && typeof business.id === 'string' && /^\d{1,32}$/.test(business.id) ? business.id : null;
  const businessName = businessId && typeof business?.name === 'string' && business.name.trim()
    ? business.name.slice(0, 1024) : null;
  return {
    customerId: id, name, currencyCode, timeZone, manager: false, status: known?.status ?? 'UNKNOWN',
    loginCustomerId: id, managerCustomerId: null, businessId, businessName,
    // Reportable: an open account with a known currency and IANA timezone (Insights dates use it).
    eligible: Boolean(known?.reportable) && currencyCode !== null && timeZone !== null,
  };
}

export interface MetaAuth {
  readonly accessToken: string;
  readonly appSecret: string;
  readonly version: string;
}

async function listPages(auth: MetaAuth, fields: string, fetcher: Fetcher, signal: AbortSignal): Promise<DiscoveredAccount[]> {
  const accounts = new Map<string, DiscoveredAccount>();
  const seen = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = graphUrl(auth.version, '/me/adaccounts', { fields, limit: PAGE_SIZE });
    if (after) url.searchParams.set('after', after);
    const body = await graphRequest(fetcher, url, {
      accessToken: auth.accessToken, appSecret: auth.appSecret, maxBytes: MAX_PAGE_BYTES, signal,
    });
    if (!Array.isArray(body.data)) throw new MetaGraphError('other');
    for (const value of body.data) {
      const account = adAccount(value);
      if (!accounts.has(account.customerId)) accounts.set(account.customerId, account);
      if (accounts.size > MAX_ACCOUNTS) throw new MetaGraphError('other');
    }
    after = nextCursor(body, seen);
    if (after === null) return [...accounts.values()];
  }
  throw new MetaGraphError('other');
}

/**
 * Every ad account the person can read. The owning business portfolio's name is
 * requested too; if Meta refuses that field (permission error, or #100 for a
 * field this token may not read), the list is
 * loaded again without it rather than failing. Throws MetaGraphError otherwise
 * (`token` when the token is no longer valid).
 */
export async function discoverAdAccounts(auth: MetaAuth, fetcher: Fetcher): Promise<DiscoveredAccount[]> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    return await listPages(auth, `${FIELDS},business{id,name}`, fetcher, signal);
  } catch (error) {
    const fieldRefused = error instanceof MetaGraphError
      && (error.kind === 'permission' || (error.kind === 'other' && error.code === 100));
    if (!fieldRefused || signal.aborted) throw error;
    return listPages(auth, FIELDS, fetcher, signal);
  }
}
