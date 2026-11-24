// Client view of the Meta Ads Sources API and setup wizard (contract:
// docs/dev.md). Same-origin requests only; no token or App Secret ever reaches
// this code.
import { call, SourcesError, type ConnectionStatus, type MetaConnectionSummary, type Prerequisite, type Role } from './sources.ts';

export type MetaAccountStatus = 'ENABLED' | 'DISABLED' | 'UNSETTLED' | 'PENDING_RISK_REVIEW' | 'PENDING_SETTLEMENT'
  | 'IN_GRACE_PERIOD' | 'PENDING_CLOSURE' | 'CLOSED' | 'UNKNOWN';

export interface MetaAccount {
  /** Ad account ID without "act_". */
  accountId: string;
  name: string | null;
  currency: string | null;
  timeZone: string | null;
  status: MetaAccountStatus;
  businessId: string | null;
  businessName: string | null;
  eligible: boolean;
  selected: boolean;
  /** Not listed by the last refresh but kept (selected or in a project); an admin may remove it. */
  stale?: boolean;
}

export interface MetaAccounts {
  role: Role | null;
  connection: MetaConnectionSummary | null;
  accounts: MetaAccount[];
  maxSelected?: number;
}

const UNAVAILABLE = 'The request did not complete. Try again in a moment.';

export const fetchMetaAccounts = () => call<MetaAccounts>('/api/sources/meta/accounts');
export const saveMetaAccounts = (accountIds: string[]) =>
  call<MetaAccounts>('/api/sources/meta/accounts', { method: 'POST', body: JSON.stringify({ accountIds }) });
export const removeStaleMetaAccount = (accountId: string) =>
  call<MetaAccounts>('/api/sources/meta/remove-account', { method: 'POST', body: JSON.stringify({ customerId: accountId }) });
export const rediscoverMetaAccounts = () => call<MetaAccounts>('/api/sources/meta/discover', { method: 'POST' });
export const disconnectMeta = () =>
  call<{ disconnected: boolean; revoked: boolean }>('/api/sources/meta/disconnect', { method: 'POST' });
export const saveConversionActionType = (actionType: string | null) =>
  call<{ conversion: { value: string; source: 'deployment' | 'instance' | 'default' } | null }>(
    '/api/sources/meta/conversion', { method: 'POST', body: JSON.stringify({ actionType }) });

/**
 * Asks the server for a one-time Facebook Login URL and opens it in this tab.
 * Only Facebook's dialog origin (or this origin) is ever followed. `rerequest`
 * asks again for a declined permission.
 */
export async function startMetaConnect(rerequest = false): Promise<void> {
  const { authorizationUrl } = await call<{ authorizationUrl: unknown }>('/api/oauth/meta/start', {
    method: 'POST', ...(rerequest ? { body: JSON.stringify({ rerequest: true }) } : {}),
  });
  if (typeof authorizationUrl !== 'string') throw new SourcesError(UNAVAILABLE, 0);
  const target = new URL(authorizationUrl, window.location.origin);
  if (target.origin !== 'https://www.facebook.com' && target.origin !== window.location.origin) {
    throw new SourcesError(UNAVAILABLE, 0);
  }
  window.location.assign(target.toString());
}

// ── Picker ─────────────────────────────────────────────────────────────────

export interface MetaAccountGroups {
  /** Reportable accounts by owning business portfolio; `businessId` null = not in a portfolio / not reported. */
  groups: { businessId: string | null; businessName: string | null; accounts: MetaAccount[] }[];
  unavailable: MetaAccount[];
}

export function groupMetaAccounts(accounts: readonly MetaAccount[], filter = ''): MetaAccountGroups {
  const needle = filter.trim().toLocaleLowerCase('en').replace(/^act_/, '');
  const matches = (account: MetaAccount) => !needle
    || (account.name ?? '').toLocaleLowerCase('en').includes(needle) || account.accountId.includes(needle)
    || (account.businessName ?? '').toLocaleLowerCase('en').includes(needle);
  const groups = new Map<string, { businessId: string | null; businessName: string | null; accounts: MetaAccount[] }>();
  const unavailable: MetaAccount[] = [];
  for (const account of accounts) {
    if (!matches(account)) continue;
    if (!account.eligible) {
      unavailable.push(account);
      continue;
    }
    const key = account.businessId ?? '';
    const group = groups.get(key) ?? { businessId: account.businessId, businessName: account.businessName, accounts: [] };
    group.accounts.push(account);
    groups.set(key, group);
  }
  // Accounts outside a business portfolio first, then portfolios by name.
  const ordered = [...groups.values()].sort((a, b) => (a.businessId === null ? -1 : b.businessId === null ? 1
    : (a.businessName ?? '').localeCompare(b.businessName ?? '', 'en')));
  return { groups: ordered, unavailable };
}

export function metaUnavailableReason(account: MetaAccount): string {
  switch (account.status) {
    case 'DISABLED': return 'Disabled by Meta';
    case 'PENDING_CLOSURE': return 'Closing';
    case 'CLOSED': return 'Closed';
    case 'UNKNOWN': return 'Status not reported by Meta';
    default: return 'Missing currency or timezone';
  }
}

/** Shown next to reportable accounts that need attention in Ads Manager. */
export function metaStatusNote(status: MetaAccountStatus): string | null {
  switch (status) {
    case 'UNSETTLED': return 'Unsettled balance';
    case 'PENDING_RISK_REVIEW': return 'Under review';
    case 'PENDING_SETTLEMENT': return 'Pending settlement';
    case 'IN_GRACE_PERIOD': return 'Grace period';
    default: return null;
  }
}

// ── Conversion action type ─────────────────────────────────────────────────

/** Common Insights action types; any other exact action_type can be typed in. */
export const COMMON_ACTION_TYPES: readonly { value: string; label: string }[] = [
  { value: 'purchase', label: 'Purchases (purchase)' },
  { value: 'omni_purchase', label: 'Purchases, all channels (omni_purchase)' },
  { value: 'offsite_conversion.fb_pixel_purchase', label: 'Website purchases (Pixel)' },
  { value: 'lead', label: 'Leads (lead)' },
  { value: 'offsite_conversion.fb_pixel_lead', label: 'Website leads (Pixel)' },
  { value: 'complete_registration', label: 'Registrations (complete_registration)' },
  { value: 'offsite_conversion.fb_pixel_complete_registration', label: 'Website registrations (Pixel)' },
  { value: 'subscribe', label: 'Subscriptions (subscribe)' },
  { value: 'start_trial', label: 'Trials started (start_trial)' },
  { value: 'add_to_cart', label: 'Adds to cart (add_to_cart)' },
  { value: 'initiate_checkout', label: 'Checkouts initiated (initiate_checkout)' },
  { value: 'mobile_app_install', label: 'App installs (mobile_app_install)' },
];

export const isActionType = (value: string) => value.length <= 128 && /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*$/.test(value);

// ── Setup wizard ───────────────────────────────────────────────────────────

export type MetaSetupStepKey = 'app' | 'appId' | 'login' | 'access' | 'credentials' | 'connect';
export type MetaManualStep = 'app' | 'login' | 'access';
export const META_SETUP_STEPS: MetaSetupStepKey[] = ['app', 'appId', 'login', 'access', 'credentials', 'connect'];

export interface MetaSetup {
  prerequisites: {
    publicOrigin: Prerequisite;
    encryptionKey: Prerequisite;
    database: boolean;
    apiVersion: 'ok' | 'invalid';
    deploymentApp: 'none' | 'ok' | 'invalid';
    conversionActionType: 'none' | 'ok' | 'invalid';
  };
  values: {
    origin: string | null;
    redirectUri: string | null;
    appDomain: string | null;
    authorizedDomain: string | null;
    appName: string;
    scope: string;
    adminEmail: string;
    apiVersion: string | null;
    /** PUBLIC_ORIGIN is http://localhost: Meta accepts it only in Development mode. */
    localhost: boolean;
  };
  appId: string | null;
  steps: Record<MetaManualStep, string | null>;
  app: {
    source: 'deployment' | 'instance';
    appId: string | null;
    secretLast4: string | null;
    updatedAt: string | null;
    valid: boolean;
  } | null;
  ready: boolean;
  connection: (MetaConnectionSummary & { status: ConnectionStatus }) | null;
}

export const fetchMetaSetup = () => call<MetaSetup>('/api/sources/meta/setup');
export const saveMetaSetup = (change: { appId?: string; steps?: Partial<Record<MetaManualStep, boolean>> }) =>
  call<MetaSetup>('/api/sources/meta/setup', { method: 'POST', body: JSON.stringify(change) });
export const saveMetaCredentials = (appId: string, appSecret: string) =>
  call<MetaSetup>('/api/sources/meta/credentials', { method: 'POST', body: JSON.stringify({ appId, appSecret }) });
export const deleteMetaCredentials = () => call<MetaSetup>('/api/sources/meta/credentials/delete', { method: 'POST' });

/** Self-hosting guide (mirrors the wizard) in the OpenADS repository. */
export const META_ADS_GUIDE_URL = 'https://github.com/RapidWombat-com/OpenADS/blob/main/docs/SELF_HOSTING_META_ADS.md';

export const META_SETUP_ERRORS = ['invalid_app', 'redirect_mismatch', 'access_denied', 'permission_declined', 'client_missing'] as const;
export type MetaSetupError = (typeof META_SETUP_ERRORS)[number];

export function validateMetaSetupSearch(raw: Record<string, unknown>): { error?: MetaSetupError } {
  return {
    error: typeof raw.error === 'string' && (META_SETUP_ERRORS as readonly string[]).includes(raw.error)
      ? raw.error as MetaSetupError : undefined,
  };
}

/** The wizard step that fixes each callback/report setup problem. */
export const META_SETUP_ERROR_STEP: Record<MetaSetupError, MetaSetupStepKey> = {
  invalid_app: 'credentials',
  client_missing: 'credentials',
  redirect_mismatch: 'login',
  access_denied: 'access',
  permission_declined: 'connect',
};

/** Client-side mirrors of the server validation (the server re-checks everything). */
export const isMetaAppId = (value: string) => /^[1-9]\d{4,19}$/.test(value);
export const isMetaAppSecret = (value: string) => /^[0-9a-fA-F]{32}$/.test(value);

/**
 * Meta App Dashboard links. Meta's forms cannot be prefilled, so every link
 * opens the exact page of the operator's app (by App ID) and the wizard offers
 * copy buttons for the values to enter there.
 */
export const META_CREATE_APP_URL = 'https://developers.facebook.com/apps/creation/';
export const META_DASHBOARD = {
  dashboard: 'dashboard/',
  basicSettings: 'settings/basic/',
  useCases: 'use_cases/',
  businessLogin: 'business-login/settings/',
  facebookLogin: 'fb-login/settings/',
  roles: 'roles/roles/',
} as const;

export function metaAppUrl(appId: string | null, path: string): string {
  return appId && /^\d+$/.test(appId) ? `https://developers.facebook.com/apps/${appId}/${path}` : 'https://developers.facebook.com/apps/';
}

/** Which steps are done, from server state. */
export function completedMetaSteps(setup: MetaSetup): Record<MetaSetupStepKey, boolean> {
  return {
    app: Boolean(setup.steps.app) || Boolean(setup.appId),
    appId: Boolean(setup.appId),
    login: Boolean(setup.steps.login),
    access: Boolean(setup.steps.access),
    credentials: setup.ready,
    connect: setup.connection?.status === 'active' && setup.connection.accountsDiscoveredAt !== null,
  };
}

/** The step to open: the one that fixes `error`, else the first step not done. */
export function initialMetaStep(setup: MetaSetup, error: MetaSetupError | undefined): MetaSetupStepKey {
  if (error) return META_SETUP_ERROR_STEP[error];
  const done = completedMetaSteps(setup);
  return META_SETUP_STEPS.find(step => !done[step]) ?? 'connect';
}

const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
export const formatExpiry = (iso: string) => dateFormat.format(new Date(iso));
