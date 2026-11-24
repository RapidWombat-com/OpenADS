// GET /api/sources.json: every provider's instance availability and this
// workspace's connections, readable by every member. Never returns tokens,
// ciphertext or secrets.
import { asciiLower } from './access.ts';
import {
  ADMIN_ONLY, apiError, json, objectBody, readBody, rejectCrossOrigin, session, type AppContext,
} from './api.ts';
import { adminEmails, googleConfig } from './config.ts';
import { connectionView } from './google-ads/service.ts';
import { conversionActionType, metaConfig } from './meta-ads/config.ts';
import { metaConnectionView } from './meta-ads/service.ts';
import { pendingSwitchView } from './connection-switch.ts';
import { getConnection, listAccounts, removeStaleAccount, type Provider } from './store.ts';

export async function sourcesSummary(ctx: AppContext): Promise<Response> {
  // `canSetUp`: the viewer is an instance admin (OPENADS_ADMIN_EMAILS) and may open the setup wizards.
  const canSetUp = adminEmails(ctx.env)?.has(asciiLower(ctx.identity.email)) ?? false;
  const google = await googleConfig(ctx.env);
  const meta = await metaConfig(ctx.env);
  // `available`: this instance has a usable OAuth client / Meta app (deployment env or wizard).
  const googleBase = { available: Boolean(google), clientSource: google?.clientSource ?? null, canSetUp };
  const metaBase = {
    available: Boolean(meta), appSource: meta?.appSource ?? null, canSetUp,
    conversion: await conversionActionType(ctx.env),
  };
  const current = await session(ctx);
  const membership = current instanceof Response ? null : current.membership;
  if (current instanceof Response || !membership) {
    return json({ workspace: null, google: { ...googleBase, connection: null }, meta: { ...metaBase, connection: null } });
  }
  const { db } = current;
  const view = async (provider: 'google_ads' | 'meta_ads') => {
    const row = await getConnection(db, membership.workspaceId, provider);
    if (!row) return null;
    const accounts = await listAccounts(db, membership.workspaceId, row.id);
    return provider === 'google_ads' ? connectionView(row, accounts) : metaConnectionView(row, accounts, ctx.now());
  };
  // A reconnect as another provider identity awaiting confirmation: admins only (they confirm it).
  const pending = (provider: 'google_ads' | 'meta_ads') => (membership.role === 'admin'
    ? pendingSwitchView(db, membership.workspaceId, provider, ctx.now()) : Promise.resolve(null));
  return json({
    workspace: { name: membership.workspaceName, role: membership.role },
    google: { ...googleBase, connection: await view('google_ads'), pendingSwitch: await pending('google_ads') },
    meta: { ...metaBase, connection: await view('meta_ads'), pendingSwitch: await pending('meta_ads') },
  });
}

/**
 * POST /api/sources/{google,meta}/remove-account (admin, same origin):
 * `{ customerId }`. The explicit admin action that removes an account the last
 * discoveries could not confirm (stale), with its selection and project
 * assignment. Automatic rediscovery never deletes a selected or assigned account
 * (see replaceAccounts); this is how an admin lets one go. Accounts that are
 * still listed cannot be removed. `view` renders the provider's account list.
 */
export async function removeStaleAccountRequest(
  request: Request, ctx: AppContext, provider: Provider, view: (ctx: AppContext) => Promise<Response>,
): Promise<Response> {
  const rejected = rejectCrossOrigin(request, ctx.env);
  if (rejected) return rejected;
  const current = await session(ctx);
  if (current instanceof Response) return current;
  if (current.membership?.role !== 'admin') return apiError(ADMIN_ONLY, 403);
  const body = objectBody(await readBody(request));
  const customerId = body?.customerId;
  if (!body || Object.keys(body).length !== 1 || typeof customerId !== 'string' || !/^\d{1,20}$/.test(customerId)) {
    return apiError('Invalid request.', 400);
  }
  const workspaceId = current.membership.workspaceId;
  const connection = await getConnection(current.db, workspaceId, provider);
  if (!connection || !await removeStaleAccount(current.db, workspaceId, connection.id, customerId)) {
    return apiError('Only accounts that the last refresh could not confirm can be removed.', 409);
  }
  return view(ctx);
}
