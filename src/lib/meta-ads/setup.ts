// Meta Ads setup wizard for self-hosted instances: the operator's own Meta app,
// entered in the app by an instance admin (OPENADS_ADMIN_EMAILS). The App
// Secret is sealed with TOKEN_ENCRYPTION_KEY and never returned; only its last
// four characters are shown. Also the instance's conversion action type.
import { asciiLower } from '../access.ts';
import {
  ADMIN_ONLY, apiError, iso, json, objectBody, readBody, rejectCrossOrigin, requireInstanceAdmin, session,
  setupWriteGuard, type AppContext,
} from '../api.ts';
import { adminEmails } from '../config.ts';
import { seal } from '../crypto.ts';
import { authorizedDomain } from '../google-ads/setup.ts';
import {
  deleteMetaSecret, getConnection, getMetaSetup, listAccounts, resolveDefaultMembership, saveMetaApp,
  saveMetaConversionActionType, saveMetaSetupProgress, type MetaSetupStep,
} from '../store.ts';
import {
  APP_SECRET_CONTEXT, conversionActionType, DEFAULT_CONVERSION_ACTION_TYPE, META_OAUTH_CALLBACK_PATH, META_SCOPE,
  metaConfig, metaStatus, validActionType, validMetaAppId, validMetaAppSecret,
} from './config.ts';
import { metaConnectionView } from './service.ts';

export const META_APP_NAME = 'OpenADS';
const STEPS: readonly MetaSetupStep[] = ['app', 'login', 'access'];

async function setupView(ctx: AppContext) {
  const status = await metaStatus(ctx.env);
  const db = ctx.env.DB;
  const stored = db ? await getMetaSetup(db) : null;
  const config = await metaConfig(ctx.env);
  let connection = null;
  if (db) {
    const membership = await resolveDefaultMembership(db, ctx.identity.email, adminEmails(ctx.env) ?? new Set<string>(), ctx.now());
    const row = membership ? await getConnection(db, membership.workspaceId, 'meta_ads') : null;
    if (row && membership) connection = metaConnectionView(row, await listAccounts(db, membership.workspaceId, row.id), ctx.now());
  }
  const deployment = status.deploymentApp;
  const host = status.origin ? new URL(status.origin).hostname : null;
  return {
    prerequisites: {
      publicOrigin: status.originState,
      encryptionKey: status.keyState,
      database: status.database,
      apiVersion: status.version ? 'ok' as const : 'invalid' as const,
      deploymentApp: deployment,
      conversionActionType: status.deploymentActionType,
    },
    values: {
      origin: status.origin,
      redirectUri: status.origin ? `${status.origin}${META_OAUTH_CALLBACK_PATH}` : null,
      appDomain: host,
      /** Registrable domain, for the optional App Domains list (best effort). */
      authorizedDomain: authorizedDomain(status.origin),
      appName: META_APP_NAME,
      scope: META_SCOPE,
      adminEmail: asciiLower(ctx.identity.email),
      apiVersion: status.version,
      localhost: status.origin ? /^http:\/\/(?:localhost|127\.0\.0\.1):/.test(status.origin) : false,
    },
    // Links use the deployment's App ID when it manages the app.
    appId: deployment === 'ok' ? ctx.env.META_APP_ID! : stored?.appId ?? null,
    steps: Object.fromEntries(STEPS.map(step => [step, iso(stored?.steps[step])])) as Record<MetaSetupStep, string | null>,
    app: deployment !== 'none' ? {
      source: 'deployment' as const,
      appId: deployment === 'ok' ? ctx.env.META_APP_ID! : null,
      secretLast4: null, updatedAt: null, valid: deployment === 'ok',
    } : stored?.secret && stored.appId ? {
      source: 'instance' as const, appId: stored.appId, secretLast4: stored.secret.last4,
      updatedAt: iso(stored.secret.updatedAt), valid: config !== null,
    } : null,
    ready: config !== null,
    connection,
  };
}

/** GET /api/sources/meta/setup — instance admins only. */
export async function metaSetup(ctx: AppContext): Promise<Response> {
  return requireInstanceAdmin(ctx) ?? json(await setupView(ctx));
}

const DEPLOYMENT_MANAGED = 'This instance’s Meta app is managed by the deployment (META_APP_ID).';

/** POST /api/sources/meta/setup — `{ appId?: string, steps?: { app|login|access: boolean } }`. */
export async function saveMetaSetup(request: Request, ctx: AppContext): Promise<Response> {
  const db = setupWriteGuard(request, ctx);
  if (db instanceof Response) return db;
  const body = objectBody(await readBody(request));
  if (!body || Object.keys(body).some(key => key !== 'appId' && key !== 'steps')) return apiError('Invalid setup change.', 400);
  const appId = typeof body.appId === 'string' ? body.appId.trim() : body.appId;
  if (appId !== undefined) {
    if (!validMetaAppId(appId)) return apiError('Enter the App ID: the number shown at the top of the App Dashboard.', 400, { field: 'appId' });
    if ((await metaStatus(ctx.env)).deploymentApp !== 'none') return apiError(DEPLOYMENT_MANAGED, 409);
  }
  const change: Partial<Record<MetaSetupStep, boolean>> = {};
  if (body.steps !== undefined) {
    const value = objectBody(body.steps);
    if (!value) return apiError('Invalid setup change.', 400);
    for (const [step, done] of Object.entries(value)) {
      if (!STEPS.includes(step as MetaSetupStep) || typeof done !== 'boolean') return apiError('Invalid setup change.', 400);
      change[step as MetaSetupStep] = done;
    }
  }
  await saveMetaSetupProgress(db, { ...(appId !== undefined ? { appId: appId as string } : {}), steps: change }, ctx.now());
  return json(await setupView(ctx));
}

/** POST /api/sources/meta/credentials — `{ appId, appSecret }`, trimmed and validated. */
export async function saveMetaCredentials(request: Request, ctx: AppContext): Promise<Response> {
  const db = setupWriteGuard(request, ctx);
  if (db instanceof Response) return db;
  const status = await metaStatus(ctx.env);
  if (status.deploymentApp !== 'none') return apiError(DEPLOYMENT_MANAGED, 409);
  if (!status.tokenKey) return apiError('TOKEN_ENCRYPTION_KEY is not set on this instance.', 503, { prerequisite: 'encryptionKey' });
  const body = objectBody(await readBody(request));
  if (!body || Object.keys(body).some(key => key !== 'appId' && key !== 'appSecret')) return apiError('Invalid credentials.', 400);
  const appId = typeof body.appId === 'string' ? body.appId.trim() : null;
  const appSecret = typeof body.appSecret === 'string' ? body.appSecret.trim() : null;
  if (!validMetaAppId(appId)) return apiError('The App ID is a number, shown at the top of the App Dashboard.', 400, { field: 'appId' });
  if (!validMetaAppSecret(appSecret)) {
    return apiError('The App Secret is 32 characters (letters a–f and digits): App settings → Basic → App secret → Show.', 400, { field: 'appSecret' });
  }
  const sealed = await seal(status.tokenKey, appSecret, APP_SECRET_CONTEXT);
  await saveMetaApp(db, {
    appId, secretCiphertext: sealed.ciphertext, secretKeyId: sealed.keyId, secretLast4: appSecret.slice(-4),
    updatedBy: asciiLower(ctx.identity.email),
  }, ctx.now());
  return json(await setupView(ctx));
}

/** POST /api/sources/meta/credentials/delete — removes the stored App Secret (grants stay; they need it to work). */
export async function deleteMetaCredentials(request: Request, ctx: AppContext): Promise<Response> {
  const db = setupWriteGuard(request, ctx);
  if (db instanceof Response) return db;
  if ((await metaStatus(ctx.env)).deploymentApp !== 'none') return apiError(DEPLOYMENT_MANAGED, 409);
  await deleteMetaSecret(db, ctx.now());
  return json(await setupView(ctx));
}

/**
 * POST /api/sources/meta/conversion (workspace admin, same origin) —
 * `{ actionType: string | null }`; null restores the default (purchase).
 * 409 when META_CONVERSION_ACTION_TYPE manages it.
 */
export async function saveConversionSetting(request: Request, ctx: AppContext): Promise<Response> {
  const rejected = rejectCrossOrigin(request, ctx.env);
  if (rejected) return rejected;
  const current = await session(ctx);
  if (current instanceof Response) return current;
  if (current.membership?.role !== 'admin') return apiError(ADMIN_ONLY, 403);
  if (ctx.env.META_CONVERSION_ACTION_TYPE) {
    return apiError('The conversion action type is managed by the deployment (META_CONVERSION_ACTION_TYPE).', 409);
  }
  const body = objectBody(await readBody(request));
  const raw = body?.actionType;
  if (!body || Object.keys(body).some(key => key !== 'actionType') || (raw !== null && typeof raw !== 'string')) {
    return apiError('Invalid conversion setting.', 400);
  }
  const value = typeof raw === 'string' ? raw.trim() : null;
  if (value !== null && !validActionType(value)) {
    return apiError('Use an exact Meta action type such as purchase or offsite_conversion.fb_pixel_lead.', 400, { field: 'actionType' });
  }
  await saveMetaConversionActionType(current.db, value === DEFAULT_CONVERSION_ACTION_TYPE ? null : value, ctx.now());
  return json({ conversion: await conversionActionType(ctx.env) });
}
