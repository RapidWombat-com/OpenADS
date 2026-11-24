import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  completedMetaSteps, initialMetaStep, isActionType, isMetaAppId, isMetaAppSecret, META_SETUP_ERROR_STEP, metaAppUrl, type MetaSetup,
} from '../src/client/lib/meta.ts';
import { importTokenKey, open } from '../src/lib/crypto.ts';
import {
  APP_SECRET_CONTEXT, META_GRAPH_API_VERSION, metaApiVersion, metaConfig, validActionType, validMetaAppId, validMetaAppSecret,
} from '../src/lib/meta-ads/config.ts';
import { metaReportSource, startMetaConnect } from '../src/lib/meta-ads/service.ts';
import { deleteMetaCredentials, metaSetup, saveMetaCredentials, saveMetaSetup } from '../src/lib/meta-ads/setup.ts';
import { sourcesSummary } from '../src/lib/sources.ts';
import { FIXTURE_TOKEN_KEY } from './fixtures/google.ts';
import { FIXTURE_META_APP_ID, FIXTURE_META_APP_SECRET, fakeMeta } from './fixtures/meta.ts';
import { createTestD1 } from './helpers/d1.ts';
import { ADMIN, connectMeta, context, location, MEMBER, ORIGIN, post, testEnv } from './helpers/app.ts';

// Test-only: JSON bodies are asserted field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = async (response: Response | Promise<Response>): Promise<any> => (await response).json();

/** A self-hosted instance before Meta setup: no Meta app in the deployment. */
function instance(overrides: Partial<Record<string, string>> = {}) {
  const d1 = createTestD1();
  const meta = fakeMeta();
  const env = testEnv(d1.db, { META_APP_ID: '', META_APP_SECRET: '', ...overrides });
  return { d1, meta, env, admin: context(env, ADMIN, meta.fetch), member: context(env, MEMBER, meta.fetch) };
}
const saveApp = (ctx: ReturnType<typeof instance>['admin'], appId = FIXTURE_META_APP_ID, appSecret = FIXTURE_META_APP_SECRET) =>
  saveMetaCredentials(post('/api/sources/meta/credentials', { body: { appId, appSecret } }), ctx);

test('validation: App ID, App Secret, action type and API version (pinned default, override, malformed fails closed)', () => {
  assert.equal(META_GRAPH_API_VERSION, 'v27.0');
  assert.equal(metaApiVersion(undefined), 'v27.0');
  assert.equal(metaApiVersion('v28.0'), 'v28.0');
  for (const value of ['27.0', 'v27', 'v27.0/x', 'v']) assert.equal(metaApiVersion(value), null, value);
  assert.ok(validMetaAppId('1234567890123456') && isMetaAppId('1234567890123456'));
  for (const value of ['', '0123456', '1234', 'abc123456', '12345678901234567890123']) assert.equal(validMetaAppId(value), false, value);
  assert.ok(validMetaAppSecret(FIXTURE_META_APP_SECRET) && isMetaAppSecret(FIXTURE_META_APP_SECRET));
  for (const value of ['', 'g'.repeat(32), 'a'.repeat(31), 'a'.repeat(33)]) assert.equal(validMetaAppSecret(value), false, value);
  for (const value of ['purchase', 'offsite_conversion.fb_pixel_purchase', 'offsite_conversion.custom.123']) {
    assert.ok(validActionType(value) && isActionType(value), value);
  }
  for (const value of ['Purchase', 'purchase lead', '.purchase', 'purchase.', '1purchase', '']) assert.equal(validActionType(value), false, value);
});

test('not set up: Sources says so, start is refused, reports are "not connected", no provider call', async () => {
  const { admin, member, meta } = instance();
  assert.equal(await metaConfig(admin.env), null);
  const summary = await read(sourcesSummary(admin));
  assert.deepEqual(summary.meta, {
    available: false, appSource: null, canSetUp: true, conversion: { value: 'purchase', source: 'default' }, connection: null, pendingSwitch: null,
  });
  assert.equal((await read(sourcesSummary(member))).meta.canSetUp, false);
  const start = await startMetaConnect(post('/api/oauth/meta/start'), admin);
  assert.equal(start.status, 503);
  assert.deepEqual(await start.json(), { error: 'Meta Ads connection is not configured.' });
  // Not set up on the instance: not configured, without a "connect" nudge on the dashboard.
  assert.deepEqual(await metaReportSource(admin, { start: '2026-11-01', end: '2026-11-07' }),
    { platform: 'meta', status: 'not_configured', campaigns: null });
  assert.equal(meta.calls.length, 0);
});

test('setup view: admins only; exact redirect URI, app domain and copy values; never a secret', async () => {
  const { admin, member } = instance();
  assert.equal((await metaSetup(member)).status, 403);
  const view = await read(metaSetup(admin));
  assert.deepEqual(view.prerequisites, {
    publicOrigin: 'ok', encryptionKey: 'ok', database: true, apiVersion: 'ok', deploymentApp: 'none', conversionActionType: 'none',
  });
  assert.deepEqual(view.values, {
    origin: ORIGIN, redirectUri: `${ORIGIN}/api/oauth/meta/callback`, appDomain: 'openads.example.test',
    authorizedDomain: 'example.test', appName: 'OpenADS', scope: 'ads_read', adminEmail: ADMIN, apiVersion: 'v27.0', localhost: false,
  });
  assert.equal(view.appId, null);
  assert.deepEqual(view.steps, { app: null, login: null, access: null });
  assert.equal(view.app, null);
  assert.equal(view.ready, false);
});

test('wizard progress: App ID and manual steps saved server-side; admin, same origin, validated', async () => {
  const { d1, admin, member } = instance();
  assert.equal((await saveMetaSetup(post('/api/sources/meta/setup', { body: { steps: { app: true } } }), member)).status, 403);
  assert.equal((await saveMetaSetup(post('/api/sources/meta/setup', { body: { steps: { app: true } }, origin: 'https://evil.example' }), admin)).status, 403);
  for (const body of [{ appId: 'abc' }, { appId: 123 }, { steps: { connect: true } }, { steps: { app: 'yes' } }, { other: 1 }, []]) {
    assert.equal((await saveMetaSetup(post('/api/sources/meta/setup', { body }), admin)).status, 400, JSON.stringify(body));
  }
  const saved = await read(saveMetaSetup(post('/api/sources/meta/setup', { body: { appId: ` ${FIXTURE_META_APP_ID} `, steps: { app: true, login: true } } }), admin));
  assert.equal(saved.appId, FIXTURE_META_APP_ID);
  assert.ok(saved.steps.app && saved.steps.login);
  assert.equal(saved.steps.access, null);
  const cleared = await read(saveMetaSetup(post('/api/sources/meta/setup', { body: { steps: { login: false } } }), admin));
  assert.equal(cleared.steps.login, null);
  assert.equal(d1.rows('meta_setup').length, 1);
});

test('credentials: validated, secret sealed (AAD-bound), shown only as last four; enables connecting', async () => {
  const { d1, admin, meta } = instance();
  for (const [appId, appSecret, field] of [['nope', FIXTURE_META_APP_SECRET, 'appId'], [FIXTURE_META_APP_ID, 'short', 'appSecret'],
    [FIXTURE_META_APP_ID, 'z'.repeat(32), 'appSecret']] as const) {
    const response = await saveApp(admin, appId, appSecret);
    assert.equal(response.status, 400);
    assert.equal((await read(response)).field, field);
  }
  const response = await saveApp(admin, ` ${FIXTURE_META_APP_ID}`, `${FIXTURE_META_APP_SECRET} `);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes(FIXTURE_META_APP_SECRET), false, 'the secret never comes back');
  const view = JSON.parse(text);
  assert.deepEqual({ ...view.app, updatedAt: null }, {
    source: 'instance', appId: FIXTURE_META_APP_ID, secretLast4: 'cdef', updatedAt: null, valid: true,
  });
  assert.equal(view.ready, true);
  const [row] = d1.rows('meta_setup');
  assert.equal(String(row!.app_secret_ciphertext).includes(FIXTURE_META_APP_SECRET), false);
  const key = (await importTokenKey(FIXTURE_TOKEN_KEY))!;
  assert.equal(await open(key, { ciphertext: String(row!.app_secret_ciphertext), keyId: String(row!.app_secret_key_id) }, APP_SECRET_CONTEXT),
    FIXTURE_META_APP_SECRET);
  await assert.rejects(open(key, { ciphertext: String(row!.app_secret_ciphertext), keyId: String(row!.app_secret_key_id) }, 'openads:other'));
  assert.equal((await read(sourcesSummary(admin))).meta.appSource, 'instance');
  // Connect with the instance app.
  assert.equal(location(await connectMeta(admin, meta)), `${ORIGIN}/sources/meta/accounts`);
});

test('another App ID removes the saved secret and marks Meta connections error; removing the secret keeps grants', async () => {
  const { d1, admin, meta } = instance();
  await saveApp(admin);
  await connectMeta(admin, meta);
  assert.equal(d1.rows('connection')[0]!.status, 'active');
  // Same App ID, rotated secret: grants stay.
  await saveApp(admin, FIXTURE_META_APP_ID, 'b'.repeat(32));
  assert.equal(d1.rows('connection')[0]!.status, 'active');
  await saveApp(admin);
  const changed = await read(saveMetaSetup(post('/api/sources/meta/setup', { body: { appId: '9999999999999999' } }), admin));
  assert.equal(changed.appId, '9999999999999999');
  assert.equal(changed.app, null, 'the old secret belonged to the old app');
  assert.equal(changed.ready, false);
  assert.equal(d1.rows('connection')[0]!.status, 'error');
  await saveApp(admin);
  await connectMeta(admin, meta);
  const removed = await read(deleteMetaCredentials(post('/api/sources/meta/credentials/delete'), admin));
  assert.equal(removed.app, null);
  assert.equal(removed.appId, FIXTURE_META_APP_ID, 'the App ID stays for the links');
  assert.equal(d1.rows('connection').length, 1);
  const report = await metaReportSource(admin, { start: '2026-11-01', end: '2026-11-07' });
  assert.deepEqual(report, { platform: 'meta', status: 'unavailable', campaigns: null, detail: 'setup_required', setupIssue: 'client_missing' });
});

test('deployment META_APP_ID/META_APP_SECRET take precedence (409 on wizard writes); incomplete ones fail closed', async () => {
  const { admin, env, meta } = instance();
  const managed = context({ ...env, META_APP_ID: FIXTURE_META_APP_ID, META_APP_SECRET: FIXTURE_META_APP_SECRET }, ADMIN, meta.fetch);
  const view = await read(metaSetup(managed));
  assert.deepEqual(view.app, { source: 'deployment', appId: FIXTURE_META_APP_ID, secretLast4: null, updatedAt: null, valid: true });
  assert.equal(view.appId, FIXTURE_META_APP_ID);
  assert.equal(view.ready, true);
  assert.equal((await saveApp(managed)).status, 409);
  assert.equal((await deleteMetaCredentials(post('/api/sources/meta/credentials/delete'), managed)).status, 409);
  assert.equal((await saveMetaSetup(post('/api/sources/meta/setup', { body: { appId: FIXTURE_META_APP_ID } }), managed)).status, 409);
  assert.equal((await saveMetaSetup(post('/api/sources/meta/setup', { body: { steps: { access: true } } }), managed)).status, 200);
  // Stored instance app is ignored while the deployment's is incomplete.
  await saveApp(admin);
  const broken = { ...env, META_APP_ID: FIXTURE_META_APP_ID, META_APP_SECRET: '' };
  assert.equal(await metaConfig(broken), null);
  assert.equal((await read(metaSetup(context(broken, ADMIN, meta.fetch)))).prerequisites.deploymentApp, 'invalid');
});

test('missing TOKEN_ENCRYPTION_KEY: credentials refused with the prerequisite named', async () => {
  const { admin } = instance({ TOKEN_ENCRYPTION_KEY: '' });
  const response = await saveApp(admin);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'TOKEN_ENCRYPTION_KEY is not set on this instance.', prerequisite: 'encryptionKey' });
});

test('client wizard: each error opens the step that fixes it; links carry the App ID', () => {
  assert.deepEqual(META_SETUP_ERROR_STEP, {
    invalid_app: 'credentials', client_missing: 'credentials', redirect_mismatch: 'login', access_denied: 'access', permission_declined: 'connect',
  });
  const base: MetaSetup = {
    prerequisites: { publicOrigin: 'ok', encryptionKey: 'ok', database: true, apiVersion: 'ok', deploymentApp: 'none', conversionActionType: 'none' },
    values: { origin: ORIGIN, redirectUri: `${ORIGIN}/api/oauth/meta/callback`, appDomain: 'x', authorizedDomain: null, appName: 'OpenADS', scope: 'ads_read', adminEmail: ADMIN, apiVersion: 'v27.0', localhost: false },
    appId: null, steps: { app: null, login: null, access: null }, app: null, ready: false, connection: null,
  };
  assert.equal(initialMetaStep(base, undefined), 'app');
  assert.equal(initialMetaStep({ ...base, appId: '1234567890' }, undefined), 'login');
  assert.equal(initialMetaStep({ ...base, appId: '1234567890', steps: { app: 'x', login: 'x', access: 'x' } }, undefined), 'credentials');
  assert.equal(initialMetaStep({ ...base, ready: true, appId: '1', steps: { app: 'x', login: 'x', access: 'x' } }, 'redirect_mismatch'), 'login');
  assert.equal(completedMetaSteps({ ...base, ready: true }).credentials, true);
  assert.equal(metaAppUrl('1234567890', 'settings/basic/'), 'https://developers.facebook.com/apps/1234567890/settings/basic/');
  assert.equal(metaAppUrl(null, 'settings/basic/'), 'https://developers.facebook.com/apps/');
  assert.equal(metaAppUrl('12/../x', 'roles/roles/'), 'https://developers.facebook.com/apps/');
});

test('migration 0003 keeps every Google row from 0001/0002 and allows Meta rows', () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const dir = new URL('../migrations/', import.meta.url);
  const files = readdirSync(dir).filter(name => name.endsWith('.sql')).sort();
  assert.deepEqual(files.slice(0, 3), ['0001_connections.sql', '0002_google_setup.sql', '0003_meta_ads.sql']);
  for (const file of files.slice(0, 2)) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  sqlite.exec(`INSERT INTO workspace VALUES ('w', 'W', 1, 1);
    INSERT INTO membership VALUES ('w', 'a@example.test', 'admin', 1, 1);
    INSERT INTO connection VALUES ('c', 'w', 'google_ads', 'sub', 'g@example.test', 'v1.iv.ct', 'k1-x', 'active', 'a@example.test', 5, 1, 2);
    INSERT INTO connected_account VALUES ('a1', 'w', 'c', '4445556666', 'Shop', 'EUR', 'Europe/Berlin', 0, 'ENABLED', '1112223333', '1112223333', 1, 1, 3);
    INSERT INTO connected_account VALUES ('a2', 'w', 'c', '1231231234', 'Old', 'USD', 'UTC', 0, 'CANCELED', '1231231234', NULL, 0, 0, 3);
    INSERT INTO oauth_state VALUES ('h', 'w', 'a@example.test', 'google_ads', '${'v'.repeat(64)}', 1, 2);
    INSERT INTO google_setup (id, project_id, client_id, client_secret_ciphertext, client_secret_key_id, client_secret_last4, updated_at)
      VALUES (1, 'openads-123', '${'x'.repeat(20)}.apps.googleusercontent.com', 'v1.a.b', 'k1-x', 'abcd', 1);`);
  const before = {
    connection: sqlite.prepare('SELECT * FROM connection').all(),
    accounts: sqlite.prepare('SELECT * FROM connected_account ORDER BY id').all(),
    states: sqlite.prepare('SELECT * FROM oauth_state').all(),
    google: sqlite.prepare('SELECT * FROM google_setup').all(),
  };
  sqlite.exec(readFileSync(new URL(files[2]!, dir), 'utf8'));
  const after = sqlite.prepare('SELECT * FROM connection').all().map(row => ({ ...row }));
  assert.deepEqual(after.map(({ provider_name, token_expires_at, ...rest }) => (assert.equal(provider_name, null), assert.equal(token_expires_at, null), rest)),
    before.connection.map(row => ({ ...row })));
  assert.deepEqual(sqlite.prepare('SELECT * FROM connected_account ORDER BY id').all().map(({ business_id, business_name, ...rest }) =>
    (assert.equal(business_id, null), assert.equal(business_name, null), { ...rest })), before.accounts.map(row => ({ ...row })));
  assert.deepEqual(sqlite.prepare('SELECT * FROM oauth_state').all(), before.states);
  assert.deepEqual(sqlite.prepare('SELECT * FROM google_setup').all(), before.google);
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  // The composite foreign key still points at connection (cascade works) and Meta rows are accepted.
  sqlite.exec(`INSERT INTO connection (id, workspace_id, provider, provider_subject, provider_name, refresh_token_ciphertext, token_key_id,
      token_expires_at, status, created_by_email, created_at, updated_at)
    VALUES ('m', 'w', 'meta_ads', '700', 'Name', 'v1.x.y', 'k1-x', 9, 'expired', 'a@example.test', 1, 1)`);
  sqlite.exec(`INSERT INTO connected_account (id, workspace_id, connection_id, customer_id, is_manager, account_status, login_customer_id,
      business_id, business_name, eligible, selected, discovered_at) VALUES ('m1', 'w', 'm', '101', 0, 'DISABLED', '101', '900', 'B', 0, 0, 1)`);
  sqlite.exec(`INSERT INTO oauth_state VALUES ('hm', 'w', 'a@example.test', 'meta_ads', NULL, 1, 2)`);
  assert.throws(() => sqlite.exec("INSERT INTO connection (id, workspace_id, provider, provider_subject, refresh_token_ciphertext, token_key_id, status, created_by_email, created_at, updated_at) VALUES ('z', 'w', 'tiktok_ads', 's', 'c', 'k', 'active', 'a', 1, 1)"));
  assert.throws(() => sqlite.exec("INSERT INTO connection (id, workspace_id, provider, provider_subject, refresh_token_ciphertext, token_key_id, status, created_by_email, created_at, updated_at) VALUES ('z', 'w', 'meta_ads', 's', 'c', 'k', 'active', 'a', 1, 1)"),
    'one Meta grant per workspace');
  sqlite.exec("DELETE FROM connection WHERE id = 'c'");
  assert.deepEqual(sqlite.prepare('SELECT id FROM connected_account').all().map(row => row.id), ['m1']);
  assert.throws(() => sqlite.exec("INSERT INTO meta_setup (id, app_secret_ciphertext, app_secret_key_id, app_secret_last4, updated_at) VALUES (1, 'c', 'k', 'abcd', 1)"),
    'a secret needs its App ID');
});
