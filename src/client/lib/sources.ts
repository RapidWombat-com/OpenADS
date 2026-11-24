// Client view of the Sources API (contract: docs/dev.md). Same-origin requests
// only: the Access cookie travels automatically and the browser sends Origin
// on every POST, which the server checks. No token ever reaches this code.

export type Role = 'admin' | 'member';
export type ConnectionStatus = 'active' | 'revoked' | 'error' | 'expired';

export interface ConnectionSummary {
  status: ConnectionStatus;
  googleEmail: string | null;
  connectedAt: string;
  updatedAt: string;
  accountsDiscoveredAt: string | null;
  eligibleAccounts: number;
  selectedAccounts: number;
}

/**
 * A reconnect as another Google account / Facebook user, waiting for an admin to
 * confirm (admins only; expires after 10 minutes). Nothing is replaced until then.
 */
export interface PendingSwitch {
  id: string;
  /** Google: email; Meta: the Facebook user's name. */
  next: { email: string | null; name: string | null };
  current: { email: string | null; name: string | null };
  /** Stored accounts the new login also lists: they keep their selection and project. */
  keptAccounts: number;
  /** Stored accounts the new login does not list: confirming removes them. */
  removedAccounts: number;
  /** The first of them (up to 20). */
  removed: { customerId: string; name: string | null; selected: boolean }[];
  /** Reportable accounts only the new login lists (added unselected). */
  newAccounts: number;
  expiresAt: string;
}

export interface SourcesSummary {
  workspace: { name: string; role: Role } | null;
  /** available: this instance has a usable Google OAuth client (deployment env or setup wizard). */
  google: {
    available: boolean;
    clientSource: 'deployment' | 'instance' | null;
    /** The viewer is an instance admin and may open the setup wizard. */
    canSetUp: boolean;
    connection: ConnectionSummary | null;
    pendingSwitch?: PendingSwitch | null;
  };
  /** available: this instance has a usable Meta app (deployment env or setup wizard). */
  meta: {
    available: boolean;
    appSource: 'deployment' | 'instance' | null;
    canSetUp: boolean;
    /** Exact Meta action type counted as conversions, and where it comes from; null when misconfigured. */
    conversion: { value: string; source: 'deployment' | 'instance' | 'default' } | null;
    connection: MetaConnectionSummary | null;
    pendingSwitch?: PendingSwitch | null;
  };
}

export interface MetaConnectionSummary {
  status: ConnectionStatus;
  /** The Facebook user's name. */
  name: string | null;
  connectedAt: string;
  updatedAt: string;
  accountsDiscoveredAt: string | null;
  eligibleAccounts: number;
  selectedAccounts: number;
  /** When Meta's long-lived token (or its data access) expires; null when unknown. */
  expiresAt: string | null;
  /** Within 7 days of expiresAt: reconnect before then. */
  expiresSoon: boolean;
}

export type AccountStatus = 'ENABLED' | 'CANCELED' | 'SUSPENDED' | 'CLOSED' | 'UNKNOWN' | 'UNREADABLE';

export interface GoogleAccount {
  customerId: string;
  name: string | null;
  currency: string | null;
  timeZone: string | null;
  manager: boolean;
  status: AccountStatus;
  managerCustomerId: string | null;
  eligible: boolean;
  selected: boolean;
  /** Not confirmed by the last refresh; kept as it was (an admin may remove it). */
  stale?: boolean;
}

export interface GoogleAccounts {
  role: Role | null;
  connection: ConnectionSummary | null;
  accounts: GoogleAccount[];
  maxSelected?: number;
}

/** A fixed, application-authored message (server `error` strings are authored too). */
export class SourcesError extends Error {
  readonly status: number;
  readonly reconnect: boolean;
  /** A setup problem the wizard can fix (from 409 `setupIssue`). */
  readonly setupIssue: SetupError | null;
  /** The form field a 400 refers to. */
  readonly field: string | null;
  constructor(message: string, status: number, reconnect = false, setupIssue: SetupError | null = null, field: string | null = null) {
    super(message);
    this.name = 'SourcesError';
    this.status = status;
    this.reconnect = reconnect;
    this.setupIssue = setupIssue;
    this.field = field;
  }
}

const SESSION = 'Your Cloudflare Access session has ended. Reload the page to sign in again.';
const UNAVAILABLE = 'The request did not complete. Try again in a moment.';

/** Same-origin JSON call to the Sources API; errors become SourcesError with a fixed message. */
export async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      credentials: 'same-origin',
      redirect: 'manual',
    });
  } catch {
    throw new SourcesError(UNAVAILABLE, 0);
  }
  if (response.type === 'opaqueredirect' || response.status === 401) throw new SourcesError(SESSION, 401);
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Handled below.
  }
  const record = typeof body === 'object' && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : null;
  if (response.ok && record) return record as T;
  const message = typeof record?.error === 'string' && record.error.length <= 200 ? record.error : UNAVAILABLE;
  const setupIssue = typeof record?.setupIssue === 'string' && (SETUP_ERRORS as readonly string[]).includes(record.setupIssue)
    ? record.setupIssue as SetupError : null;
  throw new SourcesError(message, response.status, record?.reconnect === true, setupIssue,
    typeof record?.field === 'string' ? record.field : null);
}

export const fetchSources = () => call<SourcesSummary>('/api/sources.json');
export const fetchGoogleAccounts = () => call<GoogleAccounts>('/api/sources/google/accounts');

export const saveGoogleAccounts = (customerIds: string[]) =>
  call<GoogleAccounts>('/api/sources/google/accounts', { method: 'POST', body: JSON.stringify({ customerIds }) });

export const removeStaleGoogleAccount = (customerId: string) =>
  call<GoogleAccounts>('/api/sources/google/remove-account', { method: 'POST', body: JSON.stringify({ customerId }) });

export const rediscoverGoogleAccounts = () =>
  call<GoogleAccounts>('/api/sources/google/discover', { method: 'POST' });

/** Result of confirming a reconnect as another identity. */
export interface SwitchResult { switched: true; revoked: boolean; eligibleAccounts: number; selectedAccounts: number }

/** Confirm or cancel a pending reconnect as another identity (`platform`: google or meta). */
export const resolveSwitch = (platform: 'google' | 'meta', id: string, action: 'confirm' | 'cancel') =>
  call<SwitchResult | { cancelled: true; revoked: boolean }>(`/api/sources/${platform}/switch`, {
    method: 'POST', body: JSON.stringify({ id, action }),
  });

export const disconnectGoogle = () =>
  call<{ disconnected: boolean; revoked: boolean }>('/api/sources/google/disconnect', { method: 'POST' });

/**
 * Asks the server for a one-time Google authorization URL and opens it in this
 * tab. Only Google's authorization origin (or this origin) is ever followed.
 */
export async function startGoogleConnect(): Promise<void> {
  const { authorizationUrl } = await call<{ authorizationUrl: unknown }>('/api/oauth/google/start', { method: 'POST' });
  if (typeof authorizationUrl !== 'string') throw new SourcesError(UNAVAILABLE, 0);
  const target = new URL(authorizationUrl, window.location.origin);
  if (target.origin !== 'https://accounts.google.com' && target.origin !== window.location.origin) {
    throw new SourcesError(UNAVAILABLE, 0);
  }
  window.location.assign(target.toString());
}

/** 1234567890 → 123-456-7890, as Google Ads displays customer IDs. */
export function formatCustomerId(id: string): string {
  return /^\d{10}$/.test(id) ? `${id.slice(0, 3)}-${id.slice(3, 6)}-${id.slice(6)}` : id;
}

export const CONNECT_RESULTS = [
  'connected', 'expired', 'invalid', 'no_refresh_token', 'error', 'unavailable', 'disconnected',
  'confirm_switch', 'switch_failed',
] as const;
export type ConnectResult = (typeof CONNECT_RESULTS)[number];

export const META_CONNECT_RESULTS = [
  'connected', 'expired', 'invalid', 'error', 'unavailable', 'disconnected', 'confirm_switch', 'switch_failed',
] as const;
export type MetaConnectResult = (typeof META_CONNECT_RESULTS)[number];

export function validateSourcesSearch(raw: Record<string, unknown>): { google?: ConnectResult; meta?: MetaConnectResult } {
  return {
    google: typeof raw.google === 'string' && (CONNECT_RESULTS as readonly string[]).includes(raw.google)
      ? raw.google as ConnectResult : undefined,
    meta: typeof raw.meta === 'string' && (META_CONNECT_RESULTS as readonly string[]).includes(raw.meta)
      ? raw.meta as MetaConnectResult : undefined,
  };
}

export function validatePickerSearch(raw: Record<string, unknown>): { discovery?: 'failed' } {
  return { discovery: raw.discovery === 'failed' ? 'failed' : undefined };
}

/** Accounts grouped for the picker: reportable ones by access path, the rest apart. */
export interface AccountGroups {
  direct: GoogleAccount[];
  managers: { manager: GoogleAccount | null; managerId: string; accounts: GoogleAccount[] }[];
  unavailable: GoogleAccount[];
}

export function groupAccounts(accounts: readonly GoogleAccount[], filter = ''): AccountGroups {
  const needle = filter.trim().toLocaleLowerCase('en').replaceAll('-', '');
  const matches = (account: GoogleAccount) => !needle
    || (account.name ?? '').toLocaleLowerCase('en').includes(needle) || account.customerId.includes(needle);
  const byId = new Map(accounts.map(account => [account.customerId, account]));
  const direct: GoogleAccount[] = [];
  const managed = new Map<string, GoogleAccount[]>();
  const unavailable: GoogleAccount[] = [];
  for (const account of accounts) {
    if (!matches(account)) continue;
    if (!account.eligible) unavailable.push(account);
    else if (account.managerCustomerId) {
      const list = managed.get(account.managerCustomerId) ?? [];
      list.push(account);
      managed.set(account.managerCustomerId, list);
    } else direct.push(account);
  }
  return {
    direct,
    managers: [...managed.entries()].map(([managerId, list]) => ({ managerId, manager: byId.get(managerId) ?? null, accounts: list })),
    unavailable,
  };
}

export function unavailableReason(account: GoogleAccount): string {
  if (account.manager) return 'Manager account — choose its client accounts instead';
  switch (account.status) {
    case 'CANCELED': return 'Cancelled';
    case 'SUSPENDED': return 'Suspended';
    case 'CLOSED': return 'Closed';
    case 'UNREADABLE': return 'Could not be read with this Google account';
    case 'ENABLED': return 'Missing currency or timezone';
    default: return 'Not available for reporting';
  }
}

// ── Google Ads setup wizard (self-hosting) ─────────────────────────────────

export type SetupStepKey = 'project' | 'api' | 'explorer' | 'consent' | 'client' | 'credentials' | 'connect';
export type ManualStep = 'api' | 'explorer' | 'consent' | 'client';
export type Prerequisite = 'ok' | 'missing' | 'invalid';

export interface GoogleSetup {
  prerequisites: {
    publicOrigin: Prerequisite;
    encryptionKey: Prerequisite;
    database: boolean;
    apiVersion: 'ok' | 'invalid';
    deploymentClient: 'none' | 'ok' | 'invalid';
    developerToken: 'none' | 'ok' | 'invalid';
  };
  values: {
    origin: string | null;
    redirectUri: string | null;
    appName: string;
    scope: string;
    adminEmail: string;
    authorizedDomain: string | null;
  };
  projectId: string | null;
  steps: Record<ManualStep, string | null>;
  client: {
    source: 'deployment' | 'instance';
    clientId: string | null;
    secretLast4: string | null;
    updatedAt: string | null;
    valid: boolean;
  } | null;
  ready: boolean;
  connection: {
    status: ConnectionStatus;
    googleEmail: string | null;
    accountsDiscoveredAt: string | null;
    eligibleAccounts: number;
    selectedAccounts: number;
  } | null;
}

export const fetchGoogleSetup = () => call<GoogleSetup>('/api/sources/google/setup');
export const saveGoogleSetup = (change: { projectId?: string | null; steps?: Partial<Record<ManualStep, boolean>> }) =>
  call<GoogleSetup>('/api/sources/google/setup', { method: 'POST', body: JSON.stringify(change) });
export const saveGoogleCredentials = (clientId: string, clientSecret: string) =>
  call<GoogleSetup>('/api/sources/google/credentials', { method: 'POST', body: JSON.stringify({ clientId, clientSecret }) });
export const deleteGoogleCredentials = () =>
  call<GoogleSetup>('/api/sources/google/credentials/delete', { method: 'POST' });

/** Self-hosting guide (mirrors the wizard) in the OpenADS repository. */
export const GOOGLE_ADS_GUIDE_URL = 'https://github.com/RapidWombat-com/OpenADS/blob/main/docs/SELF_HOSTING_GOOGLE_ADS.md';

export const SETUP_ERRORS = [
  'access_denied', 'scope_denied', 'invalid_client', 'api_disabled', 'access_level', 'client_missing',
] as const;
export type SetupError = (typeof SETUP_ERRORS)[number];

export function validateSetupSearch(raw: Record<string, unknown>): { error?: SetupError } {
  return {
    error: typeof raw.error === 'string' && (SETUP_ERRORS as readonly string[]).includes(raw.error)
      ? raw.error as SetupError : undefined,
  };
}

/** The wizard step that fixes each callback/report setup problem. */
export const SETUP_ERROR_STEP: Record<SetupError, SetupStepKey> = {
  access_denied: 'consent',
  scope_denied: 'consent',
  invalid_client: 'credentials',
  client_missing: 'credentials',
  api_disabled: 'api',
  access_level: 'explorer',
};

/** Client-side mirrors of the server validation (the server re-checks everything). */
export const isProjectId = (value: string) => /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value);
export const isClientId = (value: string) => value.length >= 30 && value.length <= 255
  && /^[A-Za-z0-9][A-Za-z0-9._-]*\.apps\.googleusercontent\.com$/.test(value);
export const isClientSecret = (value: string) => value.length >= 8 && value.length <= 512 && /^[\x21-\x7e]+$/.test(value);

/**
 * Google Cloud console links. Google's forms cannot be prefilled beyond the
 * project, so every link carries `project=<id>` and the wizard offers copy
 * buttons for the values to type. Paths follow Google's current documentation.
 */
export function consoleUrl(path: string, projectId: string | null): string {
  const url = new URL(path, 'https://console.cloud.google.com');
  if (projectId) url.searchParams.set('project', projectId);
  return url.toString();
}

export const CONSOLE = {
  createProject: '/projectcreate',
  enableApi: '/flows/enableapi?apiid=googleads.googleapis.com',
  adsApiOverview: '/google/ads-apis/overview',
  authOverview: '/auth/overview',
  branding: '/auth/branding',
  audience: '/auth/audience',
  scopes: '/auth/scopes',
  clients: '/auth/clients',
} as const;

/** Which steps are done, from server state. */
export function completedSteps(setup: GoogleSetup): Record<SetupStepKey, boolean> {
  return {
    project: Boolean(setup.projectId),
    api: Boolean(setup.steps.api),
    explorer: Boolean(setup.steps.explorer),
    consent: Boolean(setup.steps.consent),
    client: Boolean(setup.steps.client) || Boolean(setup.client),
    credentials: setup.ready,
    connect: setup.connection?.status === 'active' && setup.connection.accountsDiscoveredAt !== null,
  };
}

export const SETUP_STEPS: SetupStepKey[] = ['project', 'api', 'explorer', 'consent', 'client', 'credentials', 'connect'];

/** The step to open: the one that fixes `error`, else the first step not done. */
export function initialStep(setup: GoogleSetup, error: SetupError | undefined): SetupStepKey {
  if (error) return SETUP_ERROR_STEP[error];
  const done = completedSteps(setup);
  return SETUP_STEPS.find(step => !done[step]) ?? 'connect';
}
