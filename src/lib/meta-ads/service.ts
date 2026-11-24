// Meta Ads connection lifecycle: Sources → Facebook Login → long-lived token →
// account discovery → selection → report → expiry/reconnect/disconnect. Mirrors
// the Google Ads service: every handler resolves the Access identity's workspace
// membership server-side; account IDs from the browser are only ever matched
// against that workspace's own discovered accounts.
import {
  ADMIN_ONLY, apiError, iso, json, objectBody, readBody, redirect, rejectCrossOrigin, session, type AppContext,
} from '../api.ts';
import { publicOrigin } from '../config.ts';
import { grantContext, open, randomToken, seal, sha256 } from '../crypto.ts';
import { fetchMeta, MAX_META_ACCOUNTS } from '../providers/meta.ts';
import { fetchMetaCampaignDetail } from '../providers/meta-detail.ts';
import type { ReportScope } from '../reporting.ts';
import { CampaignDetailError, type CampaignDetail, type DateWindow, type SourceResult } from '../providers/types.ts';
import {
  asDiscovery, consumeOAuthState, createOAuthState, deleteConnection, deletePendingConnection, getConnection,
  listAccounts, listSelectedAccounts, replaceAccounts, saveConnection, setConnectionStatus, setSelectedAccounts,
  type AccountRow, type ConnectionRow, type Discovery,
} from '../store.ts';
import { pendingSwitchRequest, revocationUnsafe, stagePendingSwitch } from '../connection-switch.ts';
import { conversionActionType, expiryState, metaConfig, type MetaConfig } from './config.ts';
import { discoverAdAccounts } from './discovery.ts';
import { MetaGraphError } from './graph.ts';
import { authorizationUrl, completeLogin, MetaOAuthError, revokePermissions } from './oauth.ts';

const PROVIDER = 'meta_ads';

/**
 * Callback outcomes shown on the Sources page (`/sources?meta=…`); `confirm_switch`
 * and `switch_failed` as for Google (another Facebook user signed in).
 */
export type MetaConnectResult = 'connected' | 'expired' | 'invalid' | 'error' | 'unavailable' | 'disconnected'
  | 'confirm_switch' | 'switch_failed';

/**
 * Outcomes the setup wizard fixes (`/sources/meta/setup?error=…`): wrong App ID
 * or Secret → credentials step; redirect URI mismatch → Facebook Login step;
 * cancelled / not allowed → app roles step; `ads_read` declined → connect step
 * (asks again with auth_type=rerequest); no usable app → credentials step.
 */
export type MetaSetupError = 'invalid_app' | 'redirect_mismatch' | 'access_denied' | 'permission_declined' | 'client_missing';

export function metaAccountView(row: AccountRow) {
  return {
    accountId: row.customerId, name: row.name, currency: row.currencyCode, timeZone: row.timeZone,
    status: row.status, businessId: row.businessId, businessName: row.businessName,
    eligible: row.eligible, selected: row.selected,
    // Not listed by the last refresh but kept (selected or in a project): an admin may remove it.
    stale: row.staleSince !== null,
  };
}

export function metaConnectionView(row: ConnectionRow, accounts: readonly AccountRow[], now: number) {
  const expiry = row.status === 'active' ? expiryState(row.tokenExpiresAt, now) : 'none';
  return {
    // A token past its expiry is shown as expired even before a report notices.
    status: expiry === 'past' ? 'expired' as const : row.status,
    name: row.name,
    connectedAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    accountsDiscoveredAt: iso(row.accountsDiscoveredAt),
    eligibleAccounts: accounts.filter(account => account.eligible).length,
    selectedAccounts: accounts.filter(account => account.selected && account.eligible).length,
    expiresAt: iso(row.tokenExpiresAt),
    /** The grant expires within 7 days: reconnect before `expiresAt`. */
    expiresSoon: expiry === 'soon',
  };
}

async function adminContext(request: Request, ctx: AppContext) {
  const rejected = rejectCrossOrigin(request, ctx.env);
  if (rejected) return rejected;
  const current = await session(ctx);
  if (current instanceof Response) return current;
  if (current.membership?.role !== 'admin') return apiError(ADMIN_ONLY, 403);
  const config = await metaConfig(ctx.env);
  if (!config) return apiError('Meta Ads connection is not configured.', 503);
  return { db: current.db, membership: current.membership, config };
}

/**
 * POST /api/oauth/meta/start (admin, same origin), optional JSON `{ "rerequest": true }`.
 * Creates a one-time state (stored hashed, 10-minute TTL, bound to workspace +
 * Access email + provider) and returns Facebook's Login dialog URL.
 */
export async function startMetaConnect(request: Request, ctx: AppContext): Promise<Response> {
  const admin = await adminContext(request, ctx);
  if (admin instanceof Response) return admin;
  let rerequest = false;
  if (request.headers.get('Content-Type')) {
    const body = objectBody(await readBody(request));
    if (!body || Object.keys(body).some(key => key !== 'rerequest') || (body.rerequest !== undefined && typeof body.rerequest !== 'boolean')) {
      return apiError('Invalid request.', 400);
    }
    rerequest = body.rerequest === true;
  }
  const state = randomToken(32);
  await createOAuthState(admin.db, {
    stateHash: await sha256(state), workspaceId: admin.membership.workspaceId,
    email: admin.membership.email, provider: PROVIDER, codeVerifier: null,
  }, ctx.now());
  return json({
    authorizationUrl: authorizationUrl({
      appId: admin.config.appId, redirectUri: admin.config.redirectUri, state, version: admin.config.version, rerequest,
    }),
  });
}

async function openToken(config: MetaConfig, row: ConnectionRow): Promise<string | null> {
  try {
    return await open(config.tokenKey, { ciphertext: row.ciphertext, keyId: row.keyId }, grantContext(row.workspaceId, row.id));
  } catch {
    return null;
  }
}

async function revokeStored(config: MetaConfig, row: ConnectionRow, ctx: AppContext): Promise<boolean> {
  const token = await openToken(config, row);
  return token ? revokePermissions({ appSecret: config.appSecret, token, version: config.version }, ctx.fetcher) : false;
}

/**
 * GET /api/oauth/meta/callback. Consumes the state first (so it can never be
 * replayed), then checks expiry, provider, Access email, workspace and admin
 * role before looking at Facebook's response. Always answers with a redirect.
 */
export async function metaCallback(request: Request, ctx: AppContext): Promise<Response> {
  const origin = publicOrigin(ctx.env.PUBLIC_ORIGIN);
  const to = (path: string) => redirect(`${origin ?? ''}${path}`);
  const result = (value: MetaConnectResult) => to(`/sources?meta=${value}`);
  const setup = (value: MetaSetupError) => to(`/sources/meta/setup?error=${value}`);
  const config = await metaConfig(ctx.env);
  const current = await session(ctx);
  if (!config || current instanceof Response) return result('unavailable');
  const params = new URL(request.url).searchParams;
  if (['state', 'code', 'error'].some(key => params.getAll(key).length > 1)) return result('invalid');
  const state = params.get('state');
  if (!state || state.length > 512) return result('invalid');
  const pending = await consumeOAuthState(current.db, await sha256(state));
  if (!pending || pending.expiresAt <= ctx.now() || pending.provider !== PROVIDER) return result('expired');
  const membership = current.membership;
  if (pending.email !== ctx.identity.email || !membership || membership.email !== pending.email
    || membership.workspaceId !== pending.workspaceId || membership.role !== 'admin') {
    return result('invalid');
  }
  const error = params.get('error');
  // access_denied (error_reason=user_denied): the person cancelled Facebook's dialog.
  if (error !== null) return error === 'access_denied' ? setup('access_denied') : result('error');
  const code = params.get('code');
  if (!code || code.length > 4096 || !/^[\x21-\x7e]+$/.test(code)) return result('invalid');

  let grant;
  try {
    grant = await completeLogin({
      appId: config.appId, appSecret: config.appSecret, redirectUri: config.redirectUri, code, version: config.version,
    }, ctx.fetcher, ctx.now());
  } catch (failure) {
    const reason = failure instanceof MetaOAuthError ? failure.code : 'upstream';
    if (reason === 'invalid_app') return setup('invalid_app');
    if (reason === 'redirect_mismatch') return setup('redirect_mismatch');
    if (reason === 'invalid_code') return result('expired');
    return result('error');
  }
  const workspaceId = membership.workspaceId;
  // Drops a new login that is not stored. DELETE /me/permissions removes the app's
  // whole login for that Facebook user, so it is skipped when the connection (or a
  // pending change) is the same user: the new token is then just not kept.
  const discard = async () => {
    if (await revocationUnsafe(current.db, workspaceId, PROVIDER, grant.userId, ctx.now())) return false;
    return revokePermissions({ appSecret: config.appSecret, token: grant.token, version: config.version }, ctx.fetcher)
      .catch(() => false);
  };
  if (!grant.adsRead) {
    // Nothing is stored without ads_read; the wizard asks again with auth_type=rerequest.
    await discard();
    return setup('permission_declined');
  }
  const existing = await getConnection(current.db, workspaceId, PROVIDER);
  if (existing && existing.subject !== grant.userId) {
    // Another Facebook user: replacing the connection would drop ad accounts,
    // selections and projects. Stage it; Sources shows what changes and asks to confirm.
    let found: Discovery;
    try {
      found = asDiscovery(await discoverAdAccounts({ accessToken: grant.token, appSecret: config.appSecret, version: config.version }, ctx.fetcher));
    } catch {
      // Nothing was stored: discard the new login (another Facebook user, so the current one is unaffected).
      await discard();
      return result('switch_failed');
    }
    try {
      await stagePendingSwitch(current.db, config.tokenKey, {
        existing, subject: grant.userId, email: null, name: grant.name, token: grant.token,
        tokenExpiresAt: grant.expiresAt, discovery: found, createdByEmail: membership.email,
      }, ctx.now());
    } catch {
      await discard();
      return result('switch_failed');
    }
    return result('confirm_switch');
  }
  // Same Facebook user (or none yet): keep the connection (and its selections). The
  // new token replaces the old one; DELETE /me/permissions would remove the new
  // login too. A change to another user awaiting confirmation is dropped.
  await deletePendingConnection(current.db, workspaceId, PROVIDER);
  const id = existing ? existing.id : crypto.randomUUID();
  const sealed = await seal(config.tokenKey, grant.token, grantContext(workspaceId, id));
  await saveConnection(current.db, {
    id, workspaceId, provider: PROVIDER, subject: grant.userId, email: null, name: grant.name,
    ciphertext: sealed.ciphertext, keyId: sealed.keyId, tokenExpiresAt: grant.expiresAt, createdByEmail: membership.email,
  }, ctx.now());

  let accounts: AccountRow[];
  try {
    const found = await discoverAdAccounts({ accessToken: grant.token, appSecret: config.appSecret, version: config.version }, ctx.fetcher);
    accounts = await replaceAccounts(current.db, workspaceId, id, found, ctx.now());
  } catch {
    return to('/sources/meta/accounts?discovery=failed');
  }
  const eligible = accounts.filter(account => account.eligible);
  if (eligible.length === 1) return to('/');
  if (eligible.some(account => account.selected)) return result('connected');
  return to('/sources/meta/accounts');
}

/**
 * POST /api/sources/meta/switch (admin, same origin): confirm or cancel a
 * reconnect as another Facebook user (see connection-switch.ts).
 */
export function resolveMetaSwitch(request: Request, ctx: AppContext): Promise<Response> {
  return pendingSwitchRequest(request, ctx, {
    provider: PROVIDER,
    config: context => metaConfig(context.env),
    revoke: (config, token, context) => revokePermissions({ appSecret: config.appSecret, token, version: config.version }, context.fetcher),
  });
}

/** GET /api/sources/meta/accounts — readable by every member. */
export async function metaAccounts(ctx: AppContext): Promise<Response> {
  const current = await session(ctx);
  if (current instanceof Response) return current;
  const { db, membership } = current;
  if (!membership) return json({ role: null, connection: null, accounts: [], maxSelected: MAX_META_ACCOUNTS });
  const connection = await getConnection(db, membership.workspaceId, PROVIDER);
  const accounts = connection ? await listAccounts(db, membership.workspaceId, connection.id) : [];
  return json({
    role: membership.role,
    connection: connection ? metaConnectionView(connection, accounts, ctx.now()) : null,
    accounts: accounts.map(metaAccountView),
    maxSelected: MAX_META_ACCOUNTS,
  });
}

const EXPIRED = () => apiError('Meta Ads access expired. Reconnect to continue.', 409, { reconnect: true });

/** The active grant of the admin's workspace, or the response to send (marks a past-expiry grant expired). */
async function activeConnection(admin: { db: D1Database; membership: { workspaceId: string } }, now: number) {
  const connection = await getConnection(admin.db, admin.membership.workspaceId, PROVIDER);
  if (!connection) return apiError('Meta Ads is not connected.', 404);
  if (connection.status === 'active' && expiryState(connection.tokenExpiresAt, now) === 'past') {
    await setConnectionStatus(admin.db, connection.workspaceId, connection.id, connection.ciphertext, 'expired', now);
    return EXPIRED();
  }
  if (connection.status !== 'active') return EXPIRED();
  return connection;
}

/** POST /api/sources/meta/discover (admin, same origin): reload the ad account list. */
export async function rediscoverMeta(request: Request, ctx: AppContext): Promise<Response> {
  const admin = await adminContext(request, ctx);
  if (admin instanceof Response) return admin;
  const connection = await activeConnection(admin, ctx.now());
  if (connection instanceof Response) return connection;
  const workspaceId = admin.membership.workspaceId;
  const token = await openToken(admin.config, connection);
  if (!token) {
    await setConnectionStatus(admin.db, workspaceId, connection.id, connection.ciphertext, 'error', ctx.now());
    return EXPIRED();
  }
  try {
    const found = await discoverAdAccounts({ accessToken: token, appSecret: admin.config.appSecret, version: admin.config.version }, ctx.fetcher);
    await replaceAccounts(admin.db, workspaceId, connection.id, found, ctx.now());
  } catch (failure) {
    if (failure instanceof MetaGraphError && failure.kind === 'token') {
      await setConnectionStatus(admin.db, workspaceId, connection.id, connection.ciphertext, 'expired', ctx.now());
      return EXPIRED();
    }
    return apiError('Meta ad accounts could not be loaded. Try again.', 502);
  }
  return metaAccounts(ctx);
}

/** POST /api/sources/meta/accounts (admin, same origin): `{ accountIds: string[] }`. */
export async function selectMetaAccounts(request: Request, ctx: AppContext): Promise<Response> {
  const admin = await adminContext(request, ctx);
  if (admin instanceof Response) return admin;
  const ids = objectBody(await readBody(request))?.accountIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_META_ACCOUNTS
    || !ids.every(id => typeof id === 'string' && /^\d{1,20}$/.test(id)) || new Set(ids).size !== ids.length) {
    return apiError(`Select between 1 and ${MAX_META_ACCOUNTS} ad accounts.`, 400);
  }
  const connection = await activeConnection(admin, ctx.now());
  if (connection instanceof Response) return connection;
  const workspaceId = admin.membership.workspaceId;
  const eligible = new Set((await listAccounts(admin.db, workspaceId, connection.id))
    .filter(account => account.eligible).map(account => account.customerId));
  if (!ids.every(id => eligible.has(id))) return apiError('Select only ad accounts listed for this connection.', 400);
  await setSelectedAccounts(admin.db, workspaceId, connection.id, ids as string[]);
  return metaAccounts(ctx);
}

/**
 * POST /api/sources/meta/disconnect (admin, same origin). Asks Meta to remove
 * the app's login for that person (DELETE /me/permissions, best effort), then
 * deletes the connection, its ciphertext and accounts.
 */
export async function disconnectMeta(request: Request, ctx: AppContext): Promise<Response> {
  const rejected = rejectCrossOrigin(request, ctx.env);
  if (rejected) return rejected;
  const current = await session(ctx);
  if (current instanceof Response) return current;
  if (current.membership?.role !== 'admin') return apiError(ADMIN_ONLY, 403);
  const workspaceId = current.membership.workspaceId;
  const connection = await getConnection(current.db, workspaceId, PROVIDER);
  if (!connection) return json({ disconnected: false, revoked: false });
  const config = await metaConfig(ctx.env);
  const revoked = config ? await revokeStored(config, connection, ctx) : false;
  await deleteConnection(current.db, workspaceId, connection.id);
  return json({ disconnected: true, revoked });
}

const NOT_CONNECTED: SourceResult = { platform: 'meta', status: 'not_configured', campaigns: null, detail: 'not_connected' };

/** The Meta source of /api/campaigns.json for the requester's workspace. Never throws; never zeros. */
export async function metaReportSource(ctx: AppContext, window: DateWindow, scope: ReportScope | null = null): Promise<SourceResult> {
  try {
    const current = await session(ctx);
    if (current instanceof Response || !current.membership) return NOT_CONNECTED;
    return await metaReportForWorkspace(ctx, current.db, current.membership.workspaceId, window, scope);
  } catch {
    return { platform: 'meta', status: 'unavailable', campaigns: null };
  }
}

/** The Meta source for one workspace: its own grant and its own selected ad accounts only. */
export async function metaReportForWorkspace(
  ctx: AppContext, db: D1Database, workspaceId: string, window: DateWindow, scope: ReportScope | null = null,
): Promise<SourceResult> {
  const connection = await getConnection(db, workspaceId, PROVIDER);
  const config = await metaConfig(ctx.env);
  // Not set up on this instance (an operator choice, offered on Sources): no dashboard nudge.
  if (!connection) return config ? NOT_CONNECTED : { platform: 'meta', status: 'not_configured', campaigns: null };
  const actionType = await conversionActionType(ctx.env);
  if (!config || !actionType) {
    return { platform: 'meta', status: 'unavailable', campaigns: null, detail: 'setup_required', setupIssue: 'client_missing' };
  }
  // A scoped report (project/account filter) queries only the scope's accounts.
  const selected = (await listSelectedAccounts(db, workspaceId, connection.id))
    .filter(account => !scope || scope.accountIds.has(account.id));
  const targets = selected.map(account => ({
    accountId: account.customerId, name: account.name, currencyCode: account.currencyCode, timeZone: account.timeZone,
  }));
  const reconnect = (): SourceResult => ({
    platform: 'meta', status: 'unavailable', campaigns: null, detail: 'reconnect_required',
    accounts: targets.map(target => ({
      id: target.accountId, name: target.name, currency: target.currencyCode, timeZone: target.timeZone, status: 'unavailable',
    })),
  });
  const expiry = expiryState(connection.tokenExpiresAt, ctx.now());
  if (connection.status === 'active' && expiry === 'past') {
    await setConnectionStatus(db, workspaceId, connection.id, connection.ciphertext, 'expired', ctx.now());
    return reconnect();
  }
  if (connection.status !== 'active') return reconnect();
  if (!targets.length) return { platform: 'meta', status: 'not_configured', campaigns: null, detail: 'no_accounts_selected' };
  const token = await openToken(config, connection);
  if (!token) {
    // Wrong/rotated key or tampered row: fail closed and ask for a new grant.
    await setConnectionStatus(db, workspaceId, connection.id, connection.ciphertext, 'error', ctx.now());
    return reconnect();
  }
  const result = await fetchMeta({
    accessToken: token, appSecret: config.appSecret, version: config.version, actionType: actionType.value, accounts: targets,
  }, window, ctx.fetcher);
  if (result.status !== 'available' && result.detail === 'reconnect_required') {
    await setConnectionStatus(db, workspaceId, connection.id, connection.ciphertext, 'expired', ctx.now());
    return result;
  }
  // Rows name their connected account, which the campaign detail endpoint takes.
  const ids = new Map(selected.map(account => [account.customerId, account.id]));
  const named: SourceResult = result.status === 'available' ? {
    ...result,
    campaigns: result.campaigns.map(row => {
      const connectedAccountId = row.accountId === undefined ? undefined : ids.get(row.accountId);
      return connectedAccountId ? { ...row, connectedAccountId } : row;
    }),
  } : result;
  return expiry === 'soon' ? { ...named, reconnectBy: new Date(connection.tokenExpiresAt!).toISOString() } : named;
}

/**
 * One campaign of one selected Meta ad account of this workspace (the
 * connected_account id was already checked against the workspace and project).
 * Throws CampaignDetailError; marks the grant expired when Graph says so.
 */
export async function metaCampaignDetail(
  ctx: AppContext, db: D1Database, workspaceId: string, connectedAccountId: string, campaignId: string, window: DateWindow,
): Promise<{ detail: CampaignDetail; account: AccountRow }> {
  const connection = await getConnection(db, workspaceId, PROVIDER);
  if (!connection) throw new CampaignDetailError('not_found');
  const account = (await listSelectedAccounts(db, workspaceId, connection.id)).find(item => item.id === connectedAccountId);
  if (!account) throw new CampaignDetailError('not_found');
  const config = await metaConfig(ctx.env);
  const actionType = await conversionActionType(ctx.env);
  if (!config || !actionType) throw new CampaignDetailError('setup_required');
  if (connection.status === 'active' && expiryState(connection.tokenExpiresAt, ctx.now()) === 'past') {
    await setConnectionStatus(db, workspaceId, connection.id, connection.ciphertext, 'expired', ctx.now());
    throw new CampaignDetailError('reconnect_required');
  }
  if (connection.status !== 'active') throw new CampaignDetailError('reconnect_required');
  const token = await openToken(config, connection);
  if (!token) {
    await setConnectionStatus(db, workspaceId, connection.id, connection.ciphertext, 'error', ctx.now());
    throw new CampaignDetailError('reconnect_required');
  }
  try {
    const detail = await fetchMetaCampaignDetail({
      accessToken: token, appSecret: config.appSecret, version: config.version, actionType: actionType.value,
      account: { accountId: account.customerId, name: account.name, currencyCode: account.currencyCode, timeZone: account.timeZone },
    }, campaignId, window, ctx.fetcher);
    return { detail, account };
  } catch (error) {
    if (error instanceof CampaignDetailError && error.kind === 'reconnect_required') {
      await setConnectionStatus(db, workspaceId, connection.id, connection.ciphertext, 'expired', ctx.now());
    }
    throw error;
  }
}
