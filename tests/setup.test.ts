import assert from 'node:assert/strict';
import test from 'node:test';
import {
  completedSteps, consoleUrl, CONSOLE, initialStep, isClientId, isProjectId, SETUP_ERROR_STEP, type GoogleSetup,
} from '../src/client/lib/sources.ts';
import { GOOGLE_ADS_API_VERSION, googleApiVersion, googleConfig, publicOrigin } from '../src/lib/config.ts';
import {
  googleCallback, googleReportSource, rediscoverGoogle, startGoogleConnect,
} from '../src/lib/google-ads/service.ts';
import {
  authorizedDomain, deleteGoogleCredentials, googleSetup, saveGoogleCredentials, saveGoogleSetup,
} from '../src/lib/google-ads/setup.ts';
import { adsErrorIssue } from '../src/lib/providers/google.ts';
import { sourcesSummary } from '../src/lib/sources.ts';
import { FIXTURE_CLIENT_ID, FIXTURE_CLIENT_SECRET, fakeGoogle } from './fixtures/google.ts';
import { createTestD1 } from './helpers/d1.ts';
import { ADMIN, connectGoogle, context, location, MEMBER, ORIGIN, post, startUrl, testEnv } from './helpers/app.ts';

// Test-only: JSON bodies are asserted field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = async (response: Response | Promise<Response>): Promise<any> => (await response).json();
const window = { start: '2026-11-13', end: '2026-11-19' };

/** A self-hosted instance before setup: no OAuth client in the deployment. */
function instance(overrides: Partial<Record<string, string>> = {}, options: Parameters<typeof fakeGoogle>[0] = {}) {
  const d1 = createTestD1();
  const google = fakeGoogle(options);
  const env = testEnv(d1.db, { GOOGLE_OAUTH_CLIENT_ID: '', GOOGLE_OAUTH_CLIENT_SECRET: '', ...overrides });
  return { d1, google, env, admin: context(env, ADMIN, google.fetch), member: context(env, MEMBER, google.fetch) };
}

const saveClient = (ctx: ReturnType<typeof instance>['admin'], clientId = FIXTURE_CLIENT_ID, clientSecret = FIXTURE_CLIENT_SECRET) =>
  saveGoogleCredentials(post('/api/sources/google/credentials', { body: { clientId, clientSecret } }), ctx);

test('PUBLIC_ORIGIN: https with a host name, or http only for localhost/127.0.0.1 with a port', () => {
  for (const value of ['https://openads.example.com', 'https://openads.example.com:8443', 'https://localhost:8443',
    'http://localhost:8788', 'http://127.0.0.1:8788']) {
    assert.equal(publicOrigin(value), value, value);
  }
  for (const value of [undefined, '', 'openads.example.com', 'https://openads.example.com/', 'https://openads.example.com/app',
    'https://OPENADS.example.com', 'https://user:pw@openads.example.com', 'https://openads.example.com?x=1',
    'http://openads.example.com', 'http://localhost', 'http://127.0.0.1', 'http://localhost:8788/', 'http://[::1]:8788',
    'https://203.0.113.7', 'https://intranet', 'ftp://localhost:21', `https://${'a'.repeat(250)}.com`]) {
    assert.equal(publicOrigin(value), null, String(value));
  }
});

test('Google Ads API version: pinned default, explicit override, malformed fails closed', () => {
  assert.equal(GOOGLE_ADS_API_VERSION, 'v26');
  assert.equal(googleApiVersion(undefined), 'v26');
  assert.equal(googleApiVersion(''), 'v26');
  assert.equal(googleApiVersion('v27'), 'v27');
  for (const value of ['26', 'v26.1', 'v', 'v26/../x']) assert.equal(googleApiVersion(value), null, value);
});

test('not set up: Sources says so (no usable Connect), start is refused, reports are "not connected"', async () => {
  const { admin, member, google } = instance();
  assert.equal(await googleConfig(admin.env), null);
  const summary = await read(sourcesSummary(admin));
  assert.deepEqual(summary.google, { available: false, clientSource: null, canSetUp: true, connection: null, pendingSwitch: null });
  assert.equal((await read(sourcesSummary(member))).google.canSetUp, false);
  const start = await startGoogleConnect(post('/api/oauth/google/start'), admin);
  assert.equal(start.status, 503);
  assert.deepEqual(await start.json(), { error: 'Google Ads connection is not configured.' });
  const source = await googleReportSource(admin, window);
  assert.deepEqual(source, { platform: 'google', status: 'not_configured', campaigns: null, detail: 'not_connected' });
  assert.equal(google.calls.length, 0);
});

test('setup view: admins only, exact redirect URI and copy values, prerequisites without secrets', async () => {
  const { admin, member } = instance();
  assert.equal((await googleSetup(member)).status, 403);
  const view = await read(googleSetup(admin));
  assert.deepEqual(view.prerequisites, {
    publicOrigin: 'ok', encryptionKey: 'ok', database: true, apiVersion: 'ok', deploymentClient: 'none', developerToken: 'none',
  });
  assert.deepEqual(view.values, {
    origin: ORIGIN, redirectUri: `${ORIGIN}/api/oauth/google/callback`, appName: 'OpenADS',
    scope: 'https://www.googleapis.com/auth/adwords', adminEmail: ADMIN, authorizedDomain: 'example.test',
  });
  assert.equal(view.client, null);
  assert.equal(view.ready, false);
  assert.deepEqual(view.steps, { api: null, explorer: null, consent: null, client: null });
  // Missing deploy-time settings are reported, not thrown.
  const bare = instance({ TOKEN_ENCRYPTION_KEY: '', PUBLIC_ORIGIN: 'http://openads.example.test' });
  const prerequisites = (await read(googleSetup(bare.admin))).prerequisites;
  assert.equal(prerequisites.encryptionKey, 'missing');
  assert.equal(prerequisites.publicOrigin, 'invalid');
  const noDb = context({ ...testEnv(undefined as unknown as D1Database), GOOGLE_OAUTH_CLIENT_ID: '', GOOGLE_OAUTH_CLIENT_SECRET: '' }, ADMIN, fetch);
  assert.equal((await read(googleSetup(noDb))).prerequisites.database, false);
});

test('progress is saved server-side: project ID validated, steps keep their first completion time', async () => {
  const { admin, member, d1 } = instance();
  let now = 1_000;
  const ctx = { ...admin, now: () => now };
  for (const projectId of ['My Project', 'abc', '1openads', 'openads-', 'x'.repeat(31), 42]) {
    const response = await saveGoogleSetup(post('/api/sources/google/setup', { body: { projectId } }), ctx);
    assert.equal(response.status, 400, String(projectId));
  }
  for (const body of [{ steps: { connect: true } }, { steps: { api: 'yes' } }, { other: 1 }, { steps: [] }]) {
    assert.equal((await saveGoogleSetup(post('/api/sources/google/setup', { body }), ctx)).status, 400, JSON.stringify(body));
  }
  assert.equal((await saveGoogleSetup(post('/api/sources/google/setup', { body: { projectId: 'openads-123456' } }), member)).status, 403);
  assert.equal((await saveGoogleSetup(post('/api/sources/google/setup', { body: { projectId: 'openads-123456' }, origin: 'https://evil.example' }), ctx)).status, 403);
  let view = await read(saveGoogleSetup(post('/api/sources/google/setup', { body: { projectId: 'openads-123456', steps: { api: true } } }), ctx));
  assert.equal(view.projectId, 'openads-123456');
  assert.equal(view.steps.api, new Date(1_000).toISOString());
  now = 5_000;
  view = await read(saveGoogleSetup(post('/api/sources/google/setup', { body: { steps: { api: true, explorer: true } } }), ctx));
  assert.equal(view.steps.api, new Date(1_000).toISOString(), 'first completion kept');
  assert.equal(view.steps.explorer, new Date(5_000).toISOString());
  view = await read(saveGoogleSetup(post('/api/sources/google/setup', { body: { steps: { api: false } } }), ctx));
  assert.equal(view.steps.api, null);
  // Leaving and returning resumes from the stored row.
  assert.equal((await read(googleSetup(admin))).projectId, 'openads-123456');
  assert.equal(d1.rows('google_setup').length, 1);
});

test('credentials: validated and trimmed, secret sealed and never returned, then Connect works', async () => {
  const { admin, member, google, d1 } = instance();
  for (const [clientId, clientSecret, field] of [
    ['not-a-client-id', FIXTURE_CLIENT_SECRET, 'clientId'],
    ['123.apps.example.com', FIXTURE_CLIENT_SECRET, 'clientId'],
    [FIXTURE_CLIENT_ID, '   ', 'clientSecret'],
    [FIXTURE_CLIENT_ID, 'has space inside', 'clientSecret'],
  ] as const) {
    const response = await saveClient(admin, clientId, clientSecret);
    assert.equal(response.status, 400, `${clientId} ${clientSecret}`);
    assert.equal((await response.json() as { field: string }).field, field);
  }
  assert.equal((await saveClient(member)).status, 403);
  const view = await read(saveClient(admin, `  ${FIXTURE_CLIENT_ID}\n`, ` ${FIXTURE_CLIENT_SECRET} `));
  assert.deepEqual(view.client, {
    source: 'instance', clientId: FIXTURE_CLIENT_ID, secretLast4: FIXTURE_CLIENT_SECRET.slice(-4),
    updatedAt: view.client.updatedAt, valid: true,
  });
  assert.equal(view.ready, true);
  assert.ok(view.steps.client, 'saving a client marks "create client" done');
  assert.equal(JSON.stringify(view).includes(FIXTURE_CLIENT_SECRET), false);
  assert.equal(JSON.stringify(d1.rows('google_setup')).includes(FIXTURE_CLIENT_SECRET), false);
  const config = await googleConfig(admin.env);
  assert.equal(config?.clientSource, 'instance');
  assert.equal(config?.clientSecret, FIXTURE_CLIENT_SECRET);
  assert.equal((await read(sourcesSummary(admin))).google.available, true);
  // No redeploy: the stored client drives the whole flow.
  assert.equal(location(await connectGoogle(admin, google)), `${ORIGIN}/sources/google/accounts`);
});

test('a missing TOKEN_ENCRYPTION_KEY blocks storing a secret with an exact reason', async () => {
  const { admin } = instance({ TOKEN_ENCRYPTION_KEY: '' });
  const response = await saveClient(admin);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'TOKEN_ENCRYPTION_KEY is not set on this instance.', prerequisite: 'encryptionKey' });
});

test('deployment env client takes precedence and is not editable in the wizard', async () => {
  const { admin, d1 } = instance();
  await saveClient(admin);
  const deployed = context(testEnv(d1.db, { GOOGLE_OAUTH_CLIENT_ID: '999-deployed.apps.googleusercontent.com', GOOGLE_OAUTH_CLIENT_SECRET: 'deployed-secret' }), ADMIN, fetch);
  const config = await googleConfig(deployed.env);
  assert.equal(config?.clientSource, 'deployment');
  assert.equal(config?.clientId, '999-deployed.apps.googleusercontent.com');
  const view = await read(googleSetup(deployed));
  assert.deepEqual(view.client, { source: 'deployment', clientId: '999-deployed.apps.googleusercontent.com', secretLast4: null, updatedAt: null, valid: true });
  assert.equal((await saveClient(deployed)).status, 409);
  assert.equal((await deleteGoogleCredentials(post('/api/sources/google/credentials/delete'), deployed)).status, 409);
  // Half-configured deployment env never falls back silently.
  const half = context(testEnv(d1.db, { GOOGLE_OAUTH_CLIENT_ID: '999-deployed.apps.googleusercontent.com', GOOGLE_OAUTH_CLIENT_SECRET: '' }), ADMIN, fetch);
  assert.equal(await googleConfig(half.env), null);
  assert.equal((await read(googleSetup(half))).prerequisites.deploymentClient, 'invalid');
});

test('replacing the client with another ID asks to reconnect; removing it shows setup required', async () => {
  const { admin, google, d1 } = instance();
  await saveClient(admin);
  await connectGoogle(admin, google);
  // Same client ID (rotated secret): the grant stays usable.
  await saveClient(admin, FIXTURE_CLIENT_ID, `${FIXTURE_CLIENT_SECRET}`);
  assert.equal(d1.rows('connection')[0]!.status, 'active');
  await saveClient(admin, '555-other.apps.googleusercontent.com', 'other-secret-value');
  assert.equal(d1.rows('connection')[0]!.status, 'error');
  await saveClient(admin);
  d1.sqlite.exec("UPDATE connection SET status = 'active'");
  const removed = await read(deleteGoogleCredentials(post('/api/sources/google/credentials/delete'), admin));
  assert.equal(removed.client, null);
  assert.equal(removed.ready, false);
  assert.equal(d1.rows('connection').length, 1, 'the grant is kept');
  const source = await googleReportSource(admin, window);
  assert.deepEqual(source, { platform: 'google', status: 'unavailable', campaigns: null, detail: 'setup_required', setupIssue: 'client_missing' });
});

test('error-aware return: wrong secret, API disabled and Test access go to the step that fixes them', async () => {
  // Wrong secret pasted: Google rejects the code exchange with invalid_client.
  const wrong = instance();
  await saveClient(wrong.admin, FIXTURE_CLIENT_ID, 'wrong-secret-value');
  assert.equal(location(await connectGoogle(wrong.admin, wrong.google)), `${ORIGIN}/sources/google/setup?error=invalid_client`);
  assert.equal(wrong.d1.rows('connection').length, 0);

  for (const [adsError, issue] of [['service_disabled', 'api_disabled'], ['not_approved', 'access_level']] as const) {
    const { admin, google, d1 } = instance({}, { adsError });
    await saveClient(admin);
    assert.equal(location(await connectGoogle(admin, google)), `${ORIGIN}/sources/google/setup?error=${issue}`);
    // The grant is stored, so after the fix only the accounts need loading.
    assert.equal(d1.rows('connection')[0]!.status, 'active');
    assert.equal(d1.rows('connection')[0]!.accounts_discovered_at, null);
    const retry = await rediscoverGoogle(post('/api/sources/google/discover'), admin);
    assert.equal(retry.status, 409);
    const body = await retry.json() as { setupIssue: string; error: string };
    assert.equal(body.setupIssue, issue);
    assert.equal(body.error.includes('fixture-secret-detail'), false);
    google.settings.adsError = undefined;
    assert.equal((await rediscoverGoogle(post('/api/sources/google/discover'), admin)).status, 200);
  }
});

test('reports surface setup problems as setup_required, never zeros', async () => {
  const { admin, google } = instance();
  await saveClient(admin);
  await connectGoogle(admin, google);
  const { selectGoogleAccounts } = await import('../src/lib/google-ads/service.ts');
  await selectGoogleAccounts(post('/api/sources/google/accounts', { body: { customerIds: ['4445556666'] } }), admin);
  google.settings.adsError = 'not_approved';
  const source = await googleReportSource(admin, window);
  assert.equal(source.status, 'unavailable');
  assert.equal(source.campaigns, null);
  assert.equal('detail' in source && source.detail, 'setup_required');
  assert.equal('setupIssue' in source && source.setupIssue, 'access_level');
});

test('Ads API error bodies yield only fixed setup codes', () => {
  assert.equal(adsErrorIssue({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED' }] } }), 'api_disabled');
  assert.equal(adsErrorIssue({ error: { errors: [{ reason: 'accessNotConfigured', message: 'x' }] } }), 'api_disabled');
  for (const code of ['CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION', 'ACTION_NOT_PERMITTED', 'DEVELOPER_TOKEN_NOT_APPROVED']) {
    assert.equal(adsErrorIssue({ error: { details: [{ errors: [{ errorCode: { authorizationError: code } }] }] } }), 'access_level', code);
  }
  for (const body of [null, {}, { error: 'x' }, { error: { message: 'SERVICE_DISABLED CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION' } },
    { error: { details: [{ errors: [{ errorCode: { authorizationError: 'USER_PERMISSION_DENIED' } }] }] } }]) {
    assert.equal(adsErrorIssue(body), null, JSON.stringify(body));
  }
});

test('wizard helpers: console links carry the project, errors open the fixing step', () => {
  assert.equal(consoleUrl(CONSOLE.enableApi, 'openads-123456'),
    'https://console.cloud.google.com/flows/enableapi?apiid=googleads.googleapis.com&project=openads-123456');
  assert.equal(consoleUrl(CONSOLE.clients, 'openads-123456'), 'https://console.cloud.google.com/auth/clients?project=openads-123456');
  assert.equal(consoleUrl(CONSOLE.adsApiOverview, null), 'https://console.cloud.google.com/google/ads-apis/overview');
  assert.deepEqual(SETUP_ERROR_STEP, {
    access_denied: 'consent', scope_denied: 'consent', invalid_client: 'credentials', client_missing: 'credentials',
    api_disabled: 'api', access_level: 'explorer',
  });
  const base: GoogleSetup = {
    prerequisites: { publicOrigin: 'ok', encryptionKey: 'ok', database: true, apiVersion: 'ok', deploymentClient: 'none', developerToken: 'none' },
    values: { origin: ORIGIN, redirectUri: `${ORIGIN}/api/oauth/google/callback`, appName: 'OpenADS', scope: 's', adminEmail: ADMIN, authorizedDomain: null },
    projectId: null, steps: { api: null, explorer: null, consent: null, client: null }, client: null, ready: false, connection: null,
  };
  assert.equal(initialStep(base, undefined), 'project');
  assert.equal(initialStep({ ...base, projectId: 'openads-123456', steps: { ...base.steps, api: 'x' } }, undefined), 'explorer');
  assert.equal(initialStep(base, 'invalid_client'), 'credentials');
  const connected = { ...base, ready: true, connection: { status: 'active' as const, googleEmail: null, accountsDiscoveredAt: 'x', eligibleAccounts: 1, selectedAccounts: 1 } };
  assert.equal(completedSteps(connected).connect, true);
  assert.equal(completedSteps({ ...connected, connection: { ...connected.connection, accountsDiscoveredAt: null } }).connect, false);
  assert.ok(isProjectId('openads-123456') && !isProjectId('OpenADS'));
  assert.ok(isClientId(FIXTURE_CLIENT_ID) && !isClientId('abc.apps.googleusercontent.com.evil'));
  assert.equal(authorizedDomain('https://openads.example.com'), 'example.com');
  assert.equal(authorizedDomain('https://ads.example.co.uk'), 'example.co.uk');
  assert.equal(authorizedDomain('http://localhost:8788'), null);
});

test('callback for an instance without a client never leaves the app', async () => {
  const { admin, google } = instance();
  await saveClient(admin);
  const url = await startUrl(admin);
  await deleteGoogleCredentials(post('/api/sources/google/credentials/delete'), admin);
  const response = await googleCallback(new Request(google.approve(url)), admin);
  assert.equal(location(response), `${ORIGIN}/sources?google=unavailable`);
});
