// Google Ads connection lifecycle: Sources → OAuth → discovery → selection →
// report → reconnect/disconnect. Every handler resolves the Access identity's
// workspace membership server-side; account IDs from the browser are only ever
// matched against that workspace's own discovered accounts.
import {
  ADMIN_ONLY, apiError, json, readBody, redirect, rejectCrossOrigin, session, type AppContext,
} from '../api.ts';
import { googleConfig, publicOrigin, type GoogleConfig } from '../config.ts';
import { grantContext, open, pkceChallenge, randomToken, seal, sha256 } from '../crypto.ts';
import { fetchGoogle, GoogleAdsApiError, MAX_GOOGLE_ACCOUNTS } from '../providers/google.ts';
import { fetchGoogleCampaignDetail } from '../providers/google-detail.ts';
import type { ReportScope } from '../reporting.ts';
import {
  CampaignDetailError, type CampaignDetail, type DateWindow, type SetupIssue, type SourceResult,
} from '../providers/types.ts';
import {
  consumeOAuthState, createOAuthState, deleteConnection, deletePendingConnection, getConnection, listAccounts,
  listSelectedAccounts, replaceAccounts, saveConnection, setConnectionStatus, setSelectedAccounts,
  type AccountRow, type ConnectionRow, type Discovery,
} from '../store.ts';
import { pendingSwitchRequest, revocationUnsafe, stagePendingSwitch } from '../connection-switch.ts';
import { discoverAccounts } from './discovery.ts';
import {
  authorizationUrl, exchangeCode, GoogleOAuthError, refreshAccessToken, revokeGrant,
} from './oauth.ts';

const PROVIDER = 'google_ads';

/**
 * Callback outcomes shown on the Sources page (`/sources?google=…`).
 * `confirm_switch`: another Google account signed in; Sources asks to confirm the
 * change (nothing replaced yet). `switch_failed`: its accounts could not be listed,
 * so the current connection was kept and the new grant discarded.
 */
export type ConnectResult =
  | 'connected' | 'expired' | 'invalid' | 'no_refresh_token' | 'error' | 'unavailable' | 'disconnected'
  | 'confirm_switch' | 'switch_failed';

/**
 * Outcomes caused by the instance's Google Cloud setup; the callback sends the
 * admin to the wizard step that fixes them (`/sources/google/setup?error=…`).
 */
export type SetupError = SetupIssue | 'access_denied' | 'scope_denied';

function accountView(row: AccountRow) {
  return {
    customerId: row.customerId, name: row.name, currency: row.currencyCode, timeZone: row.timeZone,
    manager: row.manager, status: row.status, managerCustomerId: row.managerCustomerId,
    eligible: row.eligible, selected: row.selected,
    // Not confirmed by the last refresh (Google did not answer for its manager, or no longer lists it
    // while it is selected or in a project): shown as it was before; an admin may remove it.
    stale: row.staleSince !== null,
  };
}

export function connectionView(row: ConnectionRow, accounts: readonly AccountRow[]) {
  return {
    status: row.status,
    googleEmail: row.email,
    connectedAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    accountsDiscoveredAt: row.accountsDiscoveredAt === null ? null : new Date(row.accountsDiscoveredAt).toISOString(),
    eligibleAccounts: accounts.filter(account => account.eligible).length,
    selectedAccounts: accounts.filter(account => account.selected && account.eligible).length,
  };
}

/** Admin session plus Google configuration for state-changing endpoints, or the response to send. */
async function adminContext(request: Request, ctx: AppContext) {
  const rejected = rejectCrossOrigin(request, ctx.env);
  if (rejected) return rejected;
  const current = await session(ctx);
  if (current instanceof Response) return current;
  if (current.membership?.role !== 'admin') return apiError(ADMIN_ONLY, 403);
  const config = await googleConfig(ctx.env);
  if (!config) return apiError('Google Ads connection is not configured.', 503);
  return { db: current.db, membership: current.membership, config };
}

/**
 * POST /api/oauth/google/start (admin, same origin). Creates a one-time state
 * (stored hashed, 10-minute TTL, bound to workspace + Access email + provider
 * + PKCE verifier) and returns Google's authorization URL for the browser to open.
 */
export async function startGoogleConnect(request: Request, ctx: AppContext): Promise<Response> {
  const admin = await adminContext(request, ctx);
  if (admin instanceof Response) return admin;
  const state = randomToken(32);
  const codeVerifier = randomToken(48);
  await createOAuthState(admin.db, {
    stateHash: await sha256(state), workspaceId: admin.membership.workspaceId,
    email: admin.membership.email, provider: PROVIDER, codeVerifier,
  }, ctx.now());
  return json({
    authorizationUrl: authorizationUrl({
      clientId: admin.config.clientId, redirectUri: admin.config.redirectUri,
      state, codeChallenge: await pkceChallenge(codeVerifier),
    }),
  });
}

async function revokeStored(config: GoogleConfig, row: ConnectionRow, ctx: AppContext): Promise<boolean> {
  try {
    const token = await open(config.tokenKey, { ciphertext: row.ciphertext, keyId: row.keyId },
      grantContext(row.workspaceId, row.id));
    return await revokeGrant(token, ctx.fetcher);
  } catch {
    return false;
  }
}

/**
 * GET /api/oauth/google/callback. Consumes the state first (so it can never be
 * replayed), then checks expiry, Access email, workspace and admin role before
 * looking at the provider response. Always answers with a redirect into the app.
 */
export async function googleCallback(request: Request, ctx: AppContext): Promise<Response> {
  const origin = publicOrigin(ctx.env.PUBLIC_ORIGIN);
  const to = (path: string) => redirect(`${origin ?? ''}${path}`);
  const result = (value: ConnectResult) => to(`/sources?google=${value}`);
  const setup = (value: SetupError) => to(`/sources/google/setup?error=${value}`);
  const config = await googleConfig(ctx.env);
  const current = await session(ctx);
  if (!config || current instanceof Response) return result('unavailable');
  const params = new URL(request.url).searchParams;
  if (['state', 'code', 'error'].some(key => params.getAll(key).length > 1)) return result('invalid');
  const state = params.get('state');
  if (!state || state.length > 512) return result('invalid');
  const pending = await consumeOAuthState(current.db, await sha256(state));
  if (!pending || pending.expiresAt <= ctx.now() || pending.provider !== PROVIDER || !pending.codeVerifier) {
    return result('expired');
  }
  const membership = current.membership;
  if (pending.email !== ctx.identity.email || !membership || membership.email !== pending.email
    || membership.workspaceId !== pending.workspaceId || membership.role !== 'admin') {
    return result('invalid');
  }
  const error = params.get('error');
  // access_denied: cancelled, or (app in Testing) the Google account is not a test user.
  if (error !== null) return error === 'access_denied' ? setup('access_denied') : result('error');
  const code = params.get('code');
  if (!code || code.length > 4096 || !/^[\x21-\x7e]+$/.test(code)) return result('invalid');

  let grant;
  try {
    grant = await exchangeCode({
      clientId: config.clientId, clientSecret: config.clientSecret, redirectUri: config.redirectUri,
      code, codeVerifier: pending.codeVerifier,
    }, ctx.fetcher, ctx.now());
  } catch (failure) {
    const reason = failure instanceof GoogleOAuthError ? failure.code : 'upstream';
    if (reason === 'invalid_client') return setup('invalid_client');
    if (reason === 'insufficient_scope') return setup('scope_denied');
    return result(reason === 'missing_refresh_token' ? 'no_refresh_token' : 'error');
  }
  const workspaceId = membership.workspaceId;
  const existing = await getConnection(current.db, workspaceId, PROVIDER);
  // Drops a new grant that is not stored. Refresh tokens of one client and Google
  // account can share a grant, so it is never revoked while the connection (or a
  // pending change) belongs to the same account: the token is then just not kept.
  const discard = async () => {
    if (await revocationUnsafe(current.db, workspaceId, PROVIDER, grant.subject, ctx.now())) return false;
    return revokeGrant(grant.refreshToken, ctx.fetcher);
  };
  if (existing && existing.subject !== grant.subject) {
    // Another Google account: replacing the connection would drop accounts,
    // selections and projects. Stage it; Sources shows what changes and asks to confirm.
    let found: Discovery;
    try {
      found = await discoverAccounts({
        accessToken: grant.accessToken, version: config.version, developerToken: config.developerToken,
      }, ctx.fetcher);
    } catch (failure) {
      // Nothing was stored: discard the new grant (another Google user, so the current one is unaffected).
      await discard();
      if (failure instanceof GoogleAdsApiError && failure.issue) return setup(failure.issue);
      return result('switch_failed');
    }
    try {
      await stagePendingSwitch(current.db, config.tokenKey, {
        existing, subject: grant.subject, email: grant.email, name: null, token: grant.refreshToken,
        tokenExpiresAt: null, discovery: found, createdByEmail: membership.email,
      }, ctx.now());
    } catch {
      await discard();
      return result('switch_failed');
    }
    return result('confirm_switch');
  }
  // Same Google identity (or none yet): keep the connection (and its selections).
  // Revoking the previous token would revoke this new grant too, since Google
  // revokes per grant. A change to another account awaiting confirmation is dropped.
  await deletePendingConnection(current.db, workspaceId, PROVIDER);
  const id = existing ? existing.id : crypto.randomUUID();
  const sealed = await seal(config.tokenKey, grant.refreshToken, grantContext(workspaceId, id));
  await saveConnection(current.db, {
    id, workspaceId, provider: PROVIDER, subject: grant.subject, email: grant.email,
    ciphertext: sealed.ciphertext, keyId: sealed.keyId, createdByEmail: membership.email,
  }, ctx.now());

  let accounts: AccountRow[];
  try {
    const found = await discoverAccounts({
      accessToken: grant.accessToken, version: config.version, developerToken: config.developerToken,
    }, ctx.fetcher);
    accounts = await replaceAccounts(current.db, workspaceId, id, found, ctx.now());
  } catch (failure) {
    // The grant is stored either way; a Cloud project problem goes to its wizard step.
    if (failure instanceof GoogleAdsApiError && failure.issue) return setup(failure.issue);
    return to('/sources/google/accounts?discovery=failed');
  }
  const eligible = accounts.filter(account => account.eligible);
  if (eligible.length === 1) return to('/');
  if (eligible.some(account => account.selected)) return result('connected');
  return to('/sources/google/accounts');
}

/**
 * POST /api/sources/google/switch (admin, same origin): confirm or cancel a
 * reconnect as another Google account (see connection-switch.ts).
 */
export function resolveGoogleSwitch(request: Request, ctx: AppContext): Promise<Response> {
  return pendingSwitchRequest(request, ctx, {
    provider: PROVIDER,
    config: context => googleConfig(context.env),
    revoke: (_config, token, context) => revokeGrant(token, context.fetcher),
  });
}

/** GET /api/sources/google/accounts — readable by every member. */
export async function googleAccounts(ctx: AppContext): Promise<Response> {
  const current = await session(ctx);
  if (current instanceof Response) return current;
  const { db, membership } = current;
  if (!membership) return json({ role: null, connection: null, accounts: [] });
  const connection = await getConnection(db, membership.workspaceId, PROVIDER);
  const accounts = connection ? await listAccounts(db, membership.workspaceId, connection.id) : [];
  return json({
    role: membership.role,
    connection: connection ? connectionView(connection, accounts) : null,
    accounts: accounts.map(accountView),
    maxSelected: MAX_GOOGLE_ACCOUNTS,
  });
}

async function activeConnection(admin: { db: D1Database; membership: { workspaceId: string } }) {
  const connection = await getConnection(admin.db, admin.membership.workspaceId, PROVIDER);
  if (!connection) return apiError('Google Ads is not connected.', 404);
  if (connection.status !== 'active') {
    return apiError('Google Ads access expired. Reconnect to continue.', 409, { reconnect: true });
  }
  return connection;
}

/** POST /api/sources/google/discover (admin, same origin): reload the account list. */
export async function rediscoverGoogle(request: Request, ctx: AppContext): Promise<Response> {
  const admin = await adminContext(request, ctx);
  if (admin instanceof Response) return admin;
  const connection = await activeConnection(admin);
  if (connection instanceof Response) return connection;
  const workspaceId = admin.membership.workspaceId;
  let refreshToken: string;
  try {
    refreshToken = await open(admin.config.tokenKey, { ciphertext: connection.ciphertext, keyId: connection.keyId },
      grantContext(workspaceId, connection.id));
  } catch {
    await setConnectionStatus(admin.db, workspaceId, connection.id, connection.ciphertext, 'error', ctx.now());
    return apiError('Google Ads access expired. Reconnect to continue.', 409, { reconnect: true });
  }
  try {
    const accessToken = await refreshAccessToken({
      clientId: admin.config.clientId, clientSecret: admin.config.clientSecret, refreshToken,
    }, ctx.fetcher);
    const found = await discoverAccounts({
      accessToken, version: admin.config.version, developerToken: admin.config.developerToken,
    }, ctx.fetcher);
    await replaceAccounts(admin.db, workspaceId, connection.id, found, ctx.now());
  } catch (failure) {
    if (failure instanceof GoogleOAuthError && failure.code === 'invalid_grant') {
      await setConnectionStatus(admin.db, workspaceId, connection.id, connection.ciphertext, 'revoked', ctx.now());
      return apiError('Google Ads access expired. Reconnect to continue.', 409, { reconnect: true });
    }
    if (failure instanceof GoogleOAuthError && failure.code === 'invalid_client') {
      return apiError('Google rejected this instance’s OAuth client. Check the Client ID and secret in setup.', 409, { setupIssue: 'invalid_client' });
    }
    if (failure instanceof GoogleAdsApiError && failure.issue) {
      return apiError(failure.issue === 'api_disabled'
        ? 'The Google Ads API is not enabled in this instance’s Google Cloud project.'
        : 'This instance’s Google Cloud project does not have production access to the Google Ads API yet.', 409, { setupIssue: failure.issue });
    }
    return apiError('Google Ads accounts could not be loaded. Try again.', 502);
  }
  return googleAccounts(ctx);
}

/** POST /api/sources/google/accounts (admin, same origin): `{ customerIds: string[] }`. */
export async function selectGoogleAccounts(request: Request, ctx: AppContext): Promise<Response> {
  const admin = await adminContext(request, ctx);
  if (admin instanceof Response) return admin;
  const body = await readBody(request);
  const ids = body !== null && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>).customerIds : undefined;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_GOOGLE_ACCOUNTS
    || !ids.every(id => typeof id === 'string' && /^\d{1,20}$/.test(id)) || new Set(ids).size !== ids.length) {
    return apiError(`Select between 1 and ${MAX_GOOGLE_ACCOUNTS} accounts.`, 400);
  }
  const connection = await activeConnection(admin);
  if (connection instanceof Response) return connection;
  const workspaceId = admin.membership.workspaceId;
  const eligible = new Set((await listAccounts(admin.db, workspaceId, connection.id))
    .filter(account => account.eligible).map(account => account.customerId));
  if (!ids.every(id => eligible.has(id))) return apiError('Select only accounts listed for this connection.', 400);
  await setSelectedAccounts(admin.db, workspaceId, connection.id, ids as string[]);
  return googleAccounts(ctx);
}

/**
 * POST /api/sources/google/disconnect (admin, same origin). Revokes the grant at
 * Google (best effort), then deletes the connection, its ciphertext and accounts.
 */
export async function disconnectGoogle(request: Request, ctx: AppContext): Promise<Response> {
  const rejected = rejectCrossOrigin(request, ctx.env);
  if (rejected) return rejected;
  const current = await session(ctx);
  if (current instanceof Response) return current;
  if (current.membership?.role !== 'admin') return apiError(ADMIN_ONLY, 403);
  const workspaceId = current.membership.workspaceId;
  const connection = await getConnection(current.db, workspaceId, PROVIDER);
  if (!connection) return json({ disconnected: false, revoked: false });
  const config = await googleConfig(ctx.env);
  const revoked = config ? await revokeStored(config, connection, ctx) : false;
  await deleteConnection(current.db, workspaceId, connection.id);
  return json({ disconnected: true, revoked });
}

const NOT_CONNECTED: SourceResult = { platform: 'google', status: 'not_configured', campaigns: null, detail: 'not_connected' };

/**
 * The Google source of /api/campaigns.json for the requester's workspace.
 * Never throws; never returns zeros for a source that did not report.
 */
export async function googleReportSource(ctx: AppContext, window: DateWindow, scope: ReportScope | null = null): Promise<SourceResult> {
  try {
    const current = await session(ctx);
    if (current instanceof Response || !current.membership) return NOT_CONNECTED;
    return await googleReportForWorkspace(ctx, current.db, current.membership.workspaceId, window, scope);
  } catch {
    return { platform: 'google', status: 'unavailable', campaigns: null };
  }
}

/** The Google source for one workspace: its own grant and its own selected accounts only. */
export async function googleReportForWorkspace(
  ctx: AppContext, db: D1Database, workspaceId: string, window: DateWindow, scope: ReportScope | null = null,
): Promise<SourceResult> {
  const connection = await getConnection(db, workspaceId, PROVIDER);
  if (!connection) return NOT_CONNECTED;
  const config = await googleConfig(ctx.env);
  // A grant exists but the instance's OAuth client is gone or unusable.
  if (!config) return { platform: 'google', status: 'unavailable', campaigns: null, detail: 'setup_required', setupIssue: 'client_missing' };
  // A scoped report (project/account filter) queries only the scope's accounts.
  const selected = (await listSelectedAccounts(db, workspaceId, connection.id))
    .filter(account => !scope || scope.accountIds.has(account.id));
  const targets = selected.map(account => ({
    customerId: account.customerId, loginCustomerId: account.loginCustomerId, name: account.name,
    currencyCode: account.currencyCode, timeZone: account.timeZone,
  }));
  const reconnect = (): SourceResult => ({
    platform: 'google', status: 'unavailable', campaigns: null, detail: 'reconnect_required',
    accounts: targets.map(target => ({
      id: target.customerId, name: target.name, currency: target.currencyCode, timeZone: target.timeZone, status: 'unavailable',
    })),
  });
  if (connection.status !== 'active') return reconnect();
  if (!targets.length) return { platform: 'google', status: 'not_configured', campaigns: null, detail: 'no_accounts_selected' };
  let refreshToken: string;
  try {
    refreshToken = await open(config.tokenKey, { ciphertext: connection.ciphertext, keyId: connection.keyId },
      grantContext(workspaceId, connection.id));
  } catch {
    // Wrong/rotated key or tampered row: fail closed and ask for a new grant.
    await setConnectionStatus(db, workspaceId, connection.id, connection.ciphertext, 'error', ctx.now());
    return reconnect();
  }
  const result = await fetchGoogle({
    clientId: config.clientId, clientSecret: config.clientSecret, refreshToken,
    version: config.version, developerToken: config.developerToken, accounts: targets,
  }, window, ctx.fetcher);
  if (result.status !== 'available' && result.detail === 'reconnect_required') {
    await setConnectionStatus(db, workspaceId, connection.id, connection.ciphertext, 'revoked', ctx.now());
  }
  if (result.status !== 'available') return result;
  // Rows name their connected account, which the campaign detail endpoint takes.
  const ids = new Map(selected.map(account => [account.customerId, account.id]));
  return {
    ...result,
    campaigns: result.campaigns.map(row => {
      const connectedAccountId = row.accountId === undefined ? undefined : ids.get(row.accountId);
      return connectedAccountId ? { ...row, connectedAccountId } : row;
    }),
  };
}

/**
 * One campaign of one selected Google Ads account of this workspace (the
 * connected_account id was already checked against the workspace and project).
 * Throws CampaignDetailError; marks the grant revoked when Google says so.
 */
export async function googleCampaignDetail(
  ctx: AppContext, db: D1Database, workspaceId: string, connectedAccountId: string, campaignId: string, window: DateWindow,
): Promise<{ detail: CampaignDetail; account: AccountRow }> {
  const connection = await getConnection(db, workspaceId, PROVIDER);
  if (!connection) throw new CampaignDetailError('not_found');
  const account = (await listSelectedAccounts(db, workspaceId, connection.id)).find(item => item.id === connectedAccountId);
  if (!account) throw new CampaignDetailError('not_found');
  const config = await googleConfig(ctx.env);
  if (!config) throw new CampaignDetailError('setup_required');
  if (connection.status !== 'active') throw new CampaignDetailError('reconnect_required');
  let refreshToken: string;
  try {
    refreshToken = await open(config.tokenKey, { ciphertext: connection.ciphertext, keyId: connection.keyId },
      grantContext(workspaceId, connection.id));
  } catch {
    await setConnectionStatus(db, workspaceId, connection.id, connection.ciphertext, 'error', ctx.now());
    throw new CampaignDetailError('reconnect_required');
  }
  try {
    const detail = await fetchGoogleCampaignDetail({
      clientId: config.clientId, clientSecret: config.clientSecret, refreshToken, version: config.version,
      developerToken: config.developerToken,
      account: {
        customerId: account.customerId, loginCustomerId: account.loginCustomerId, name: account.name,
        currencyCode: account.currencyCode, timeZone: account.timeZone,
      },
    }, campaignId, window, ctx.fetcher);
    return { detail, account };
  } catch (error) {
    if (error instanceof CampaignDetailError && error.kind === 'reconnect_required') {
      await setConnectionStatus(db, workspaceId, connection.id, connection.ciphertext, 'revoked', ctx.now());
    }
    throw error;
  }
}
