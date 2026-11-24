// Google Ads setup wizard for self-hosted instances: the operator's own Google
// Cloud project and OAuth client, entered in the app by an instance admin
// (OPENADS_ADMIN_EMAILS). The client secret is sealed with TOKEN_ENCRYPTION_KEY
// and never returned; only its last four characters are shown.
import { asciiLower } from '../access.ts';
import {
  apiError, iso, json, objectBody, readBody, requireInstanceAdmin, setupWriteGuard as writeGuard, type AppContext,
} from '../api.ts';
import {
  adminEmails, CLIENT_SECRET_CONTEXT, googleConfig, instanceStatus, OAUTH_CALLBACK_PATH,
  validClientId, validClientSecret, validProjectId,
} from '../config.ts';
import { seal } from '../crypto.ts';
import {
  deleteGoogleClient, getConnection, getGoogleSetup, listAccounts, resolveDefaultMembership, saveGoogleClient,
  saveGoogleSetupProgress, type SetupStep,
} from '../store.ts';
import { GOOGLE_ADS_SCOPE } from './oauth.ts';

export const APP_NAME = 'OpenADS';
const STEPS: readonly SetupStep[] = ['api', 'explorer', 'consent', 'client'];

/**
 * The Branding page's "Authorized domain" is the registrable domain of the
 * redirect URI host. Without a public-suffix list this is a best-effort
 * suggestion (last two labels, three for common second-level suffixes).
 */
export function authorizedDomain(origin: string | null): string | null {
  if (!origin) return null;
  const host = new URL(origin).hostname;
  if (host === 'localhost' || host === '127.0.0.1') return null;
  const labels = host.split('.');
  const take = labels.length >= 3 && /^(?:co|com|org|net|gov|ac|edu)$/.test(labels.at(-2)!) ? 3 : 2;
  return labels.slice(-take).join('.');
}

async function setupView(ctx: AppContext) {
  const status = await instanceStatus(ctx.env);
  const db = ctx.env.DB;
  const stored = db ? await getGoogleSetup(db) : null;
  const config = await googleConfig(ctx.env);
  let connection = null;
  if (db) {
    const admins = adminEmails(ctx.env) ?? new Set<string>();
    const membership = await resolveDefaultMembership(db, ctx.identity.email, admins, ctx.now());
    const row = membership ? await getConnection(db, membership.workspaceId, 'google_ads') : null;
    if (row && membership) {
      const accounts = await listAccounts(db, membership.workspaceId, row.id);
      connection = {
        status: row.status, googleEmail: row.email, accountsDiscoveredAt: iso(row.accountsDiscoveredAt),
        eligibleAccounts: accounts.filter(item => item.eligible).length,
        selectedAccounts: accounts.filter(item => item.eligible && item.selected).length,
      };
    }
  }
  const deployment = status.deploymentClient;
  return {
    prerequisites: {
      publicOrigin: status.originState,
      encryptionKey: status.keyState,
      database: status.database,
      apiVersion: status.version ? 'ok' : 'invalid',
      deploymentClient: deployment,
      developerToken: status.developerTokenState,
    },
    values: {
      origin: status.origin,
      redirectUri: status.origin ? `${status.origin}${OAUTH_CALLBACK_PATH}` : null,
      appName: APP_NAME,
      scope: GOOGLE_ADS_SCOPE,
      adminEmail: asciiLower(ctx.identity.email),
      authorizedDomain: authorizedDomain(status.origin),
    },
    projectId: stored?.projectId ?? null,
    steps: Object.fromEntries(STEPS.map(step => [step, iso(stored?.steps[step])])) as Record<SetupStep, string | null>,
    client: deployment !== 'none' ? {
      source: 'deployment' as const,
      clientId: deployment === 'ok' ? ctx.env.GOOGLE_OAUTH_CLIENT_ID! : null,
      secretLast4: null, updatedAt: null, valid: deployment === 'ok',
    } : stored?.client ? {
      source: 'instance' as const, clientId: stored.client.clientId, secretLast4: stored.client.secretLast4,
      updatedAt: iso(stored.client.updatedAt), valid: config !== null,
    } : null,
    ready: config !== null,
    connection,
  };
}

/** GET /api/sources/google/setup — instance admins only. */
export async function googleSetup(ctx: AppContext): Promise<Response> {
  return requireInstanceAdmin(ctx) ?? json(await setupView(ctx));
}

/** POST /api/sources/google/setup — `{ projectId?: string | null, steps?: { api|explorer|consent|client: boolean } }`. */
export async function saveGoogleSetup(request: Request, ctx: AppContext): Promise<Response> {
  const db = writeGuard(request, ctx);
  if (db instanceof Response) return db;
  const body = objectBody(await readBody(request));
  if (!body || Object.keys(body).some(key => key !== 'projectId' && key !== 'steps')) return apiError('Invalid setup change.', 400);
  const { projectId, steps } = body;
  if (projectId !== undefined && projectId !== null && !validProjectId(projectId)) {
    return apiError('Enter a Google Cloud project ID: 6–30 lowercase letters, digits or hyphens, starting with a letter.', 400);
  }
  const change: Partial<Record<SetupStep, boolean>> = {};
  if (steps !== undefined) {
    const value = objectBody(steps);
    if (!value) return apiError('Invalid setup change.', 400);
    for (const [step, done] of Object.entries(value)) {
      if (!STEPS.includes(step as SetupStep) || typeof done !== 'boolean') return apiError('Invalid setup change.', 400);
      change[step as SetupStep] = done;
    }
  }
  await saveGoogleSetupProgress(db, { ...(projectId !== undefined ? { projectId: projectId as string | null } : {}), steps: change }, ctx.now());
  return json(await setupView(ctx));
}

/** POST /api/sources/google/credentials — `{ clientId, clientSecret }`, trimmed and validated. */
export async function saveGoogleCredentials(request: Request, ctx: AppContext): Promise<Response> {
  const db = writeGuard(request, ctx);
  if (db instanceof Response) return db;
  const status = await instanceStatus(ctx.env);
  if (status.deploymentClient !== 'none') {
    return apiError('This instance’s Google OAuth client is managed by the deployment (GOOGLE_OAUTH_CLIENT_ID).', 409);
  }
  if (!status.tokenKey) return apiError('TOKEN_ENCRYPTION_KEY is not set on this instance.', 503, { prerequisite: 'encryptionKey' });
  const body = objectBody(await readBody(request));
  const clientId = typeof body?.clientId === 'string' ? body.clientId.trim() : null;
  const clientSecret = typeof body?.clientSecret === 'string' ? body.clientSecret.trim() : null;
  if (!body || Object.keys(body).some(key => key !== 'clientId' && key !== 'clientSecret')) {
    return apiError('Invalid credentials.', 400);
  }
  if (!validClientId(clientId)) return apiError('The Client ID ends with .apps.googleusercontent.com.', 400, { field: 'clientId' });
  if (!validClientSecret(clientSecret)) return apiError('Paste the client secret shown when the client was created.', 400, { field: 'clientSecret' });
  const sealed = await seal(status.tokenKey, clientSecret, CLIENT_SECRET_CONTEXT);
  const previous = (await getGoogleSetup(db))?.client?.clientId ?? null;
  await saveGoogleClient(db, {
    clientId, secretCiphertext: sealed.ciphertext, secretKeyId: sealed.keyId, secretLast4: clientSecret.slice(-4),
    updatedBy: asciiLower(ctx.identity.email),
  }, previous, ctx.now());
  await saveGoogleSetupProgress(db, { steps: { client: true } }, ctx.now());
  return json(await setupView(ctx));
}

/** POST /api/sources/google/credentials/delete — removes the stored client (grants stay; they need it to work). */
export async function deleteGoogleCredentials(request: Request, ctx: AppContext): Promise<Response> {
  const db = writeGuard(request, ctx);
  if (db instanceof Response) return db;
  if ((await instanceStatus(ctx.env)).deploymentClient !== 'none') {
    return apiError('This instance’s Google OAuth client is managed by the deployment (GOOGLE_OAUTH_CLIENT_ID).', 409);
  }
  await deleteGoogleClient(db, ctx.now());
  return json(await setupView(ctx));
}
