// Reconnecting as a different provider identity (another Google account or
// Facebook user) than the stored connection. The OAuth callback does not
// replace the connection: it stages the new grant (pending_connection,
// encrypted, 10 minutes, same workspace) together with what the new login
// discovered, and Sources asks an admin to confirm. Confirm (admin, POST, same
// origin) switches the connection in place, keeping the row, selection and
// project of every account the new login also lists (matched on the provider
// account id) and removing the others; cancel discards the new grant. The same
// identity reconnecting never comes here.
import {
  ADMIN_ONLY, apiError, iso, json, objectBody, readBody, rejectCrossOrigin, session, type AppContext,
} from './api.ts';
import { grantContext, open, pendingGrantContext, seal, type TokenKey } from './crypto.ts';
import {
  getConnection, getPendingConnection, listAccounts, replaceAccounts, savePendingConnection,
  switchConnectionIdentity, takePendingConnection, type ConnectionRow, type Discovery, type Provider,
} from './store.ts';

const LABEL: Record<Provider, string> = { google_ads: 'Google Ads', meta_ads: 'Meta Ads' };
const GONE = 'This sign-in change expired or was already handled. Reconnect to try again.';
/** Accounts named in the confirmation (the counts are always complete). */
const MAX_LISTED = 20;

/**
 * Whether revoking a grant of provider identity `subject` could also end a grant
 * this workspace still relies on: Meta's DELETE /me/permissions removes the
 * app's whole login for that Facebook user, and Google refresh tokens of one
 * client and account can share a grant. True when the stored connection or a
 * pending change belongs to `subject`, or when that cannot be read. The caller
 * then only drops the new token instead of revoking it.
 */
export async function revocationUnsafe(
  db: D1Database, workspaceId: string, provider: Provider, subject: string, now: number,
): Promise<boolean> {
  try {
    const [connection, pending] = await Promise.all([
      getConnection(db, workspaceId, provider), getPendingConnection(db, workspaceId, provider, now),
    ]);
    return connection?.subject === subject || pending?.subject === subject;
  } catch {
    return true;
  }
}

/** Stores the new identity's grant (sealed for the pending row only) and discovery; replaces nothing. */
export async function stagePendingSwitch(db: D1Database, tokenKey: TokenKey, value: {
  existing: ConnectionRow; subject: string; email: string | null; name: string | null; token: string;
  tokenExpiresAt: number | null; discovery: Discovery; createdByEmail: string;
}, now: number): Promise<void> {
  const id = crypto.randomUUID();
  const { workspaceId, provider } = value.existing;
  const sealed = await seal(tokenKey, value.token, pendingGrantContext(workspaceId, id));
  await savePendingConnection(db, {
    id, workspaceId, provider, replacesConnectionId: value.existing.id, replacesSubject: value.existing.subject,
    subject: value.subject, email: value.email, name: value.name, ciphertext: sealed.ciphertext, keyId: sealed.keyId,
    tokenExpiresAt: value.tokenExpiresAt, discovery: value.discovery, createdByEmail: value.createdByEmail,
  }, now);
}

/**
 * What Sources shows an admin about a pending change: both identities and what
 * confirming keeps and removes. Never tokens or ciphertext. Null when there is
 * none, it expired, or the connection it would replace has changed since.
 */
export async function pendingSwitchView(db: D1Database, workspaceId: string, provider: Provider, now: number) {
  const pending = await getPendingConnection(db, workspaceId, provider, now);
  if (!pending?.discovery) return null;
  const current = await getConnection(db, workspaceId, provider);
  if (!current || current.id !== pending.replacesConnectionId || current.subject !== pending.replacesSubject) return null;
  const stored = await listAccounts(db, workspaceId, current.id);
  const listed = new Set(pending.discovery.accounts.map(account => account.customerId));
  const storedIds = new Set(stored.map(account => account.customerId));
  const removed = stored.filter(account => !listed.has(account.customerId));
  return {
    id: pending.id,
    /** Google: email; Meta: the Facebook user's name. */
    next: { email: pending.email, name: pending.name },
    current: { email: current.email, name: current.name },
    /** Stored accounts the new login also lists: they keep their selection and project. */
    keptAccounts: stored.length - removed.length,
    /** Stored accounts the new login does not list: confirming removes them (selection and project included). */
    removedAccounts: removed.length,
    removed: removed.slice(0, MAX_LISTED).map(account => ({
      customerId: account.customerId, name: account.name, selected: account.selected,
    })),
    /** Accounts only the new login lists (added unselected). */
    newAccounts: pending.discovery.accounts.filter(account => !storedIds.has(account.customerId) && account.eligible).length,
    expiresAt: iso(pending.expiresAt),
  };
}

export type PendingSwitchView = NonNullable<Awaited<ReturnType<typeof pendingSwitchView>>>;

/** Provider specifics of the confirm/cancel endpoint. */
export interface SwitchProvider<Config extends { readonly tokenKey: TokenKey }> {
  readonly provider: Provider;
  readonly config: (ctx: AppContext) => Promise<Config | null>;
  /** Best-effort revocation of a plaintext grant at the provider; never throws. */
  readonly revoke: (config: Config, token: string, ctx: AppContext) => Promise<boolean>;
}

const safely = async (work: () => Promise<boolean>) => {
  try {
    return await work();
  } catch {
    return false;
  }
};

/**
 * POST /api/sources/{google,meta}/switch (admin, same origin):
 * `{ "id": <pending id>, "action": "confirm" | "cancel" }`. The id is the one
 * shown on the confirmation screen, so a newer pending change (another sign-in
 * meanwhile) is never confirmed by an older screen. The pending row is taken
 * atomically first: a second confirm or cancel, or one after expiry, gets 409.
 */
export async function pendingSwitchRequest<Config extends { readonly tokenKey: TokenKey }>(
  request: Request, ctx: AppContext, adapter: SwitchProvider<Config>,
): Promise<Response> {
  const rejected = rejectCrossOrigin(request, ctx.env);
  if (rejected) return rejected;
  const current = await session(ctx);
  if (current instanceof Response) return current;
  if (current.membership?.role !== 'admin') return apiError(ADMIN_ONLY, 403);
  const body = objectBody(await readBody(request));
  const action = body?.action;
  const id = body?.id;
  if (!body || Object.keys(body).length !== 2 || (action !== 'confirm' && action !== 'cancel')
    || typeof id !== 'string' || !/^[0-9a-f-]{36}$/.test(id)) {
    return apiError('Invalid request.', 400);
  }
  const config = await adapter.config(ctx);
  if (!config) return apiError(`${LABEL[adapter.provider]} connection is not configured.`, 503);
  const { db } = current;
  const workspaceId = current.membership.workspaceId;
  const pending = await takePendingConnection(db, workspaceId, adapter.provider, id, ctx.now());
  if (!pending) return apiError(GONE, 409);
  let token: string | null = null;
  try {
    token = await open(config.tokenKey, { ciphertext: pending.ciphertext, keyId: pending.keyId },
      pendingGrantContext(workspaceId, pending.id));
  } catch {
    token = null;
  }
  // Never revoke the new grant while the connection belongs to the same identity
  // (it changed since staging): that could end the connection's grant too.
  const discard = async () => (token && !(await revocationUnsafe(db, workspaceId, adapter.provider, pending.subject, ctx.now()))
    ? safely(() => adapter.revoke(config, token!, ctx)) : false);
  if (action === 'cancel') return json({ cancelled: true, revoked: await discard() });

  const existing = await getConnection(db, workspaceId, adapter.provider);
  if (!token || !pending.discovery || !existing || existing.id !== pending.replacesConnectionId
    || existing.subject !== pending.replacesSubject) {
    await discard();
    return apiError(GONE, 409);
  }
  const sealed = await seal(config.tokenKey, token, grantContext(workspaceId, existing.id));
  const applied = await switchConnectionIdentity(db, {
    workspaceId, provider: adapter.provider, connectionId: existing.id, previousSubject: existing.subject,
    subject: pending.subject, email: pending.email, name: pending.name, ciphertext: sealed.ciphertext,
    keyId: sealed.keyId, tokenExpiresAt: pending.tokenExpiresAt, createdByEmail: current.membership.email,
    keepCustomerIds: pending.discovery.accounts.map(account => account.customerId),
  }, ctx.now());
  if (!applied) {
    await discard();
    return apiError(GONE, 409);
  }
  const accounts = await replaceAccounts(db, workspaceId, existing.id, pending.discovery, ctx.now());
  // The previous identity's grant is no longer used. It belongs to another
  // provider user, so revoking it never affects the new grant (checked anyway).
  const previous = await safely(async () => {
    if (await revocationUnsafe(db, workspaceId, adapter.provider, existing.subject, ctx.now())) return false;
    const old = await open(config.tokenKey, { ciphertext: existing.ciphertext, keyId: existing.keyId },
      grantContext(workspaceId, existing.id));
    return adapter.revoke(config, old, ctx);
  });
  return json({
    switched: true,
    revoked: previous,
    eligibleAccounts: accounts.filter(account => account.eligible).length,
    selectedAccounts: accounts.filter(account => account.selected && account.eligible).length,
  });
}
