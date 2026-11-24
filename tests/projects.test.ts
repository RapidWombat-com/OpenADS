import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { AppContext } from '../src/lib/api.ts';
import { googleAccounts, googleReportSource, selectGoogleAccounts, disconnectGoogle, rediscoverGoogle } from '../src/lib/google-ads/service.ts';
import { removeStaleAccountRequest } from '../src/lib/sources.ts';
import { metaReportSource, selectMetaAccounts } from '../src/lib/meta-ads/service.ts';
import {
  applyProjectGroups, assignAccounts, createProject, deleteProjectRequest, projectName, projectsSummary,
  renameProjectRequest, resolveReportScope,
} from '../src/lib/projects.ts';
import { campaignsResponse, reportCampaigns, type ReportSources } from '../src/lib/reporting.ts';
import { fakeGoogle } from './fixtures/google.ts';
import { fakeMeta, META_ACCOUNTS } from './fixtures/meta.ts';
import { createTestD1 } from './helpers/d1.ts';
import {
  ADMIN, connectGoogle, connectMeta, context, MEMBER, ORIGIN, post, providerFetch, testEnv,
} from './helpers/app.ts';

// Test-only: JSON bodies are asserted field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = async (response: Response | Promise<Response>): Promise<any> => (await response).json();
const STORE = META_ACCOUNTS.store!.id;
const BRAND = META_ACCOUNTS.brand!.id;
const PERSONAL = META_ACCOUNTS.personal!.id;
const SHOP_EU = '4445556666';
const BRAND_US = '7778889999';
const now = new Date();
const yesterday = new Date(now.getTime() - 86_400_000).toISOString().slice(0, 10);
const QUERY = `start=${yesterday}&end=${yesterday}`;

interface Account { id: string; platform: 'google' | 'meta'; customerId: string; name: string | null; projectId: string | null }

/** A workspace with Google (Shop EU + Brand US) and Meta (Store, Brand, Personal) selected. */
async function workspace() {
  const d1 = createTestD1();
  const google = fakeGoogle({ accounts: 'multi' });
  const meta = fakeMeta({ accounts: 'multi' });
  const fetcher = providerFetch(google, meta);
  const env = testEnv(d1.db);
  const admin = context(env, ADMIN, fetcher);
  const member = context(env, MEMBER, fetcher);
  await connectGoogle(admin, google);
  assert.equal((await selectGoogleAccounts(post('/api/sources/google/accounts', { body: { customerIds: [SHOP_EU, BRAND_US] } }), admin)).status, 200);
  await connectMeta(admin, meta);
  assert.equal((await selectMetaAccounts(post('/api/sources/meta/accounts', { body: { accountIds: [STORE, BRAND, PERSONAL] } }), admin)).status, 200);
  await projectsSummary(member); // the member joins the workspace
  google.calls.length = 0;
  meta.calls.length = 0;
  const summary = await read(projectsSummary(admin));
  const byCustomer = new Map<string, Account>(summary.accounts.map((account: Account) => [account.customerId, account]));
  const id = (customerId: string) => byCustomer.get(customerId)!.id;
  return { d1, google, meta, env, admin, member, id };
}

async function create(ctx: AppContext, name: string): Promise<string> {
  const response = await createProject(post('/api/projects/create', { body: { name } }), ctx);
  assert.equal(response.status, 200);
  return (await response.json() as { project: { id: string } }).project.id;
}

const loaders = (ctx: AppContext): ReportSources => ({
  google: (window, scope) => googleReportSource(ctx, window, scope),
  meta: (window, scope) => metaReportSource(ctx, window, scope),
  scope: filter => resolveReportScope(ctx, filter),
});
const report = (ctx: AppContext, query: string) =>
  campaignsResponse(new URL(`${ORIGIN}/api/campaigns.json?${query}`), loaders(ctx));

test('migration 0004 adds projects over existing rows and enforces workspace isolation in D1', () => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const dir = new URL('../migrations/', import.meta.url);
  const files = readdirSync(dir).filter(name => name.endsWith('.sql')).sort();
  assert.equal(files[3], '0004_projects.sql');
  for (const file of files.slice(0, 3)) sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
  sqlite.exec(`INSERT INTO workspace VALUES ('w1', 'One', 1, 1), ('w2', 'Two', 0, 1);
    INSERT INTO connection (id, workspace_id, provider, provider_subject, refresh_token_ciphertext, token_key_id, status, created_by_email, created_at, updated_at)
      VALUES ('c1', 'w1', 'google_ads', 's', 'v1.a.b', 'k', 'active', 'a', 1, 1), ('c2', 'w2', 'google_ads', 's', 'v1.a.b', 'k', 'active', 'a', 1, 1);
    INSERT INTO connected_account (id, workspace_id, connection_id, customer_id, is_manager, account_status, login_customer_id, eligible, selected, discovered_at)
      VALUES ('a1', 'w1', 'c1', '1', 0, 'ENABLED', '1', 1, 1, 1), ('a2', 'w2', 'c2', '2', 0, 'ENABLED', '2', 1, 1, 1);`);
  const before = sqlite.prepare('SELECT * FROM connected_account ORDER BY id').all();
  sqlite.exec(readFileSync(new URL(files[3]!, dir), 'utf8'));
  assert.deepEqual(sqlite.prepare('SELECT * FROM connected_account ORDER BY id').all(), before);
  sqlite.exec(`INSERT INTO project VALUES ('p1', 'w1', 'Northwind', 1), ('p2', 'w2', 'Other', 1);
    INSERT INTO project_account VALUES ('a1', 'w1', 'p1', 1);`);
  // Names are unique per workspace (ignoring case) but may repeat across workspaces.
  assert.throws(() => sqlite.exec("INSERT INTO project VALUES ('p3', 'w1', 'northwind', 1)"), /UNIQUE/);
  sqlite.exec("INSERT INTO project VALUES ('p4', 'w2', 'Northwind', 1)");
  // An account of w2 cannot join a w1 project, nor a w1 account a w2 project (composite foreign keys).
  assert.throws(() => sqlite.exec("INSERT INTO project_account VALUES ('a2', 'w1', 'p1', 1)"), /FOREIGN KEY/);
  assert.throws(() => sqlite.exec("INSERT INTO project_account VALUES ('a2', 'w2', 'p1', 1)"), /FOREIGN KEY/);
  // At most one project per account.
  assert.throws(() => sqlite.exec("INSERT INTO project_account VALUES ('a1', 'w1', 'p1', 2)"), /UNIQUE|PRIMARY/);
  assert.throws(() => sqlite.exec("INSERT INTO project VALUES ('p5', 'w1', '', 1)"), /CHECK/);
  // Deleting the project unassigns; deleting the connection cascades through the account.
  sqlite.exec("DELETE FROM project WHERE id = 'p1'");
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM project_account').get()!.n, 0);
  sqlite.exec("INSERT INTO project VALUES ('p1', 'w1', 'Northwind', 1); INSERT INTO project_account VALUES ('a1', 'w1', 'p1', 1);");
  sqlite.exec("DELETE FROM connection WHERE id = 'c1'");
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM project_account').get()!.n, 0);
  assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(), []);
});

test('projects: admin creates, renames, assigns and deletes; members read the same view', async () => {
  const { admin, member, id, d1 } = await workspace();
  assert.deepEqual((await read(projectsSummary(member))).projects, []);
  const northwind = await create(admin, '  North   Wind ');
  assert.equal((await read(projectsSummary(admin))).projects[0].name, 'North Wind');
  const duplicate = await createProject(post('/api/projects/create', { body: { name: 'north wind' } }), admin);
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), { error: 'A project with this name already exists.', field: 'name' });
  for (const name of ['', '   ', 'x'.repeat(81), 'a\u200bb', 42, null]) {
    const response = await createProject(post('/api/projects/create', { body: { name } }), admin);
    assert.equal(response.status, 400, String(name));
  }
  const assigned = await assignAccounts(post('/api/projects/assign', { body: { assignments: [
    { accountId: id(STORE), projectId: northwind }, { accountId: id(SHOP_EU), projectId: northwind },
  ] } }), admin);
  assert.equal(assigned.status, 200);
  const view = await read(assigned);
  assert.deepEqual(view.projects[0].accountIds.sort(), [id(STORE), id(SHOP_EU)].sort());
  assert.equal(view.accounts.find((a: Account) => a.customerId === BRAND).projectId, null);
  assert.deepEqual(Object.keys(view.accounts[0]).sort(), ['currency', 'customerId', 'id', 'name', 'platform', 'projectId']);
  // Moving an account replaces its project (one project per account).
  const other = await create(admin, 'Contoso');
  await assignAccounts(post('/api/projects/assign', { body: { assignments: [{ accountId: id(STORE), projectId: other }] } }), admin);
  assert.equal(d1.rows('project_account').length, 2);
  const renamed = await renameProjectRequest(post('/api/projects/rename', { body: { projectId: northwind, name: 'Northwind' } }), admin);
  assert.equal(renamed.status, 200);
  assert.equal((await renameProjectRequest(post('/api/projects/rename', { body: { projectId: northwind, name: 'contoso' } }), admin)).status, 409);
  assert.deepEqual((await read(projectsSummary(member))).projects.map((p: { name: string }) => p.name), ['Contoso', 'Northwind']);
  // Unassign, then delete: the remaining account becomes unassigned.
  await assignAccounts(post('/api/projects/assign', { body: { assignments: [{ accountId: id(STORE), projectId: null }] } }), admin);
  const deleted = await deleteProjectRequest(post('/api/projects/delete', { body: { projectId: northwind } }), admin);
  assert.equal(deleted.status, 200);
  assert.ok((await read(deleted)).accounts.every((account: Account) => account.projectId === null));
  assert.equal(d1.rows('project_account').length, 0);
  assert.equal((await deleteProjectRequest(post('/api/projects/delete', { body: { projectId: northwind } }), admin)).status, 404);
});

test('projects: members cannot mutate and cross-origin POSTs are rejected before anything is read', async () => {
  const { admin, member, id, d1 } = await workspace();
  const project = await create(admin, 'Northwind');
  const calls: [string, (request: Request, ctx: AppContext) => Promise<Response>, unknown][] = [
    ['/api/projects/create', createProject, { name: 'Member project' }],
    ['/api/projects/rename', renameProjectRequest, { projectId: project, name: 'Renamed' }],
    ['/api/projects/delete', deleteProjectRequest, { projectId: project }],
    ['/api/projects/assign', assignAccounts, { assignments: [{ accountId: id(STORE), projectId: project }] }],
    ['/api/projects/apply', applyProjectGroups, { groups: [{ name: 'X', accountIds: [id(STORE)] }] }],
  ];
  const snapshot = () => JSON.stringify([d1.rows('project'), d1.rows('project_account')]);
  const before = snapshot();
  for (const [path, handler, body] of calls) {
    const forbidden = await handler(post(path, { body }), member);
    assert.equal(forbidden.status, 403, path);
    assert.deepEqual(await forbidden.json(), { error: 'Only workspace admins can change projects.' });
    for (const request of [
      post(path, { body, origin: 'https://evil.example' }),
      post(path, { body, origin: null }),
      post(path, { body, headers: { 'Sec-Fetch-Site': 'cross-site' } }),
      new Request(`${ORIGIN}${path}`, { method: 'PUT', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    ]) {
      const response = await handler(request, admin);
      assert.equal(response.status, 403, path);
      assert.deepEqual(await response.json(), { error: 'Cross-origin request rejected.' });
    }
    const notJson = await handler(new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { Origin: ORIGIN }, body: 'x' }), admin);
    assert.equal(notJson.status, 400, path);
  }
  assert.equal(snapshot(), before);
});

test('projects: ids of another workspace are rejected (400) and never listed', async () => {
  const { admin, id, d1 } = await workspace();
  const mine = await create(admin, 'Mine');
  // A second workspace with its own connection, account and project, written directly.
  d1.sqlite.exec(`INSERT INTO workspace VALUES ('w-other', 'Other', 0, 1);
    INSERT INTO connection (id, workspace_id, provider, provider_subject, refresh_token_ciphertext, token_key_id, status, created_by_email, created_at, updated_at)
      VALUES ('c-other', 'w-other', 'google_ads', 's', 'v1.a.b', 'k', 'active', 'x@example.test', 1, 1);
    INSERT INTO connected_account (id, workspace_id, connection_id, customer_id, descriptive_name, is_manager, account_status, login_customer_id, eligible, selected, discovered_at)
      VALUES ('00000000-0000-4000-8000-000000000001', 'w-other', 'c-other', '1', 'Other account', 0, 'ENABLED', '1', 1, 1, 1);
    INSERT INTO project VALUES ('00000000-0000-4000-8000-000000000002', 'w-other', 'Other project', 1);
    INSERT INTO project_account VALUES ('00000000-0000-4000-8000-000000000001', 'w-other', '00000000-0000-4000-8000-000000000002', 1);`);
  const foreignAccount = '00000000-0000-4000-8000-000000000001';
  const foreignProject = '00000000-0000-4000-8000-000000000002';
  const view = await read(projectsSummary(admin));
  assert.deepEqual(view.projects.map((p: { id: string }) => p.id), [mine]);
  assert.ok(!view.accounts.some((a: Account) => a.id === foreignAccount));
  const reject = async (path: string, handler: (r: Request, c: AppContext) => Promise<Response>, body: unknown) => {
    const response = await handler(post(path, { body }), admin);
    assert.equal(response.status === 400 || response.status === 404, true, `${path} ${response.status}`);
  };
  await reject('/api/projects/assign', assignAccounts, { assignments: [{ accountId: foreignAccount, projectId: mine }] });
  await reject('/api/projects/assign', assignAccounts, { assignments: [{ accountId: id(STORE), projectId: foreignProject }] });
  await reject('/api/projects/assign', assignAccounts, { assignments: [{ accountId: foreignAccount, projectId: null }] });
  await reject('/api/projects/apply', applyProjectGroups, { groups: [{ name: 'Mine', accountIds: [foreignAccount] }] });
  await reject('/api/projects/rename', renameProjectRequest, { projectId: foreignProject, name: 'Taken over' });
  await reject('/api/projects/delete', deleteProjectRequest, { projectId: foreignProject });
  assert.deepEqual(d1.sqlite.prepare("SELECT name FROM project WHERE workspace_id = 'w-other'").all().map(row => row.name), ['Other project']);
  assert.equal(d1.sqlite.prepare("SELECT count(*) AS n FROM project_account WHERE workspace_id = 'w-other'").get()!.n, 1);
  // The report filter rejects them too, before any provider request.
  for (const query of [`project=${foreignProject}`, `account=${foreignAccount}`]) {
    const response = await report(admin, `${QUERY}&${query}`);
    assert.equal(response.status, 400, query);
  }
});

test('projects: accepted suggestions create or reuse projects in one transaction', async () => {
  const { admin, id, d1 } = await workspace();
  const existing = await create(admin, 'Fixture Brand US');
  const response = await applyProjectGroups(post('/api/projects/apply', { body: { groups: [
    { name: 'fixture brand us', accountIds: [id(BRAND), id(BRAND_US)] },
    { name: 'Fixture Store', accountIds: [id(STORE), id(SHOP_EU)] },
  ] } }), admin);
  assert.equal(response.status, 200);
  const body = await read(response);
  assert.deepEqual(body.applied, { created: 1, assigned: 4 });
  assert.deepEqual(body.projects.map((p: { name: string }) => p.name), ['Fixture Brand US', 'Fixture Store']);
  assert.deepEqual(body.projects[0].id, existing);
  assert.deepEqual(body.projects[0].accountIds.sort(), [id(BRAND), id(BRAND_US)].sort());
  // Invalid batches change nothing.
  const before = JSON.stringify([d1.rows('project'), d1.rows('project_account')]);
  for (const groups of [
    [{ name: 'A', accountIds: [id(PERSONAL)] }, { name: 'a', accountIds: [id(STORE)] }],
    [{ name: 'A', accountIds: [id(PERSONAL)] }, { name: 'B', accountIds: [id(PERSONAL)] }],
    [{ name: 'A', accountIds: [] }],
    [{ name: '', accountIds: [id(PERSONAL)] }],
    [],
  ]) {
    assert.equal((await applyProjectGroups(post('/api/projects/apply', { body: { groups } }), admin)).status, 400, JSON.stringify(groups));
  }
  assert.equal(JSON.stringify([d1.rows('project'), d1.rows('project_account')]), before);
});

test('projects: rediscovery keeps account ids and assignments (even of unlisted accounts); explicit removal and disconnect remove them', async () => {
  const { admin, id, d1, google } = await workspace();
  const project = await create(admin, 'Fixture');
  await assignAccounts(post('/api/projects/assign', { body: { assignments: [
    { accountId: id(SHOP_EU), projectId: project }, { accountId: id(STORE), projectId: project },
  ] } }), admin);
  const ids = d1.rows('connected_account').map(row => row.id).sort();
  assert.equal((await rediscoverGoogle(post('/api/sources/google/discover'), admin)).status, 200);
  assert.deepEqual(d1.rows('connected_account').map(row => row.id).sort(), ids, 'rediscovery keeps ids');
  assert.equal(d1.rows('project_account').length, 2);
  // Google no longer lists Shop EU: it is assigned, so its row and assignment stay (stale) until an admin removes it.
  google.settings.accounts = 'none';
  assert.equal((await rediscoverGoogle(post('/api/sources/google/discover'), admin)).status, 200);
  assert.equal(d1.rows('project_account').length, 2);
  assert.notEqual(d1.rows('connected_account').find(row => row.customer_id === SHOP_EU)!.stale_since, null);
  assert.equal((await removeStaleAccountRequest(post('/api/sources/google/remove-account', { body: { customerId: SHOP_EU } }),
    admin, 'google_ads', googleAccounts)).status, 200);
  assert.equal(d1.rows('project_account').length, 1);
  assert.equal((await disconnectGoogle(post('/api/sources/google/disconnect'), admin)).status, 200);
  assert.equal(d1.rows('project_account').length, 1, 'Meta assignment stays');
  assert.equal(d1.rows('project').length, 1);
});

test('report filter: format errors and unknown ids are 400 before any provider request', async () => {
  const { admin, google, meta } = await workspace();
  const project = await create(admin, 'Fixture');
  const unknown = '11111111-1111-4111-8111-111111111111';
  for (const query of [
    'project=', 'project=all', 'project=Unassigned', `project=${unknown.toUpperCase()}`, `project=${project}&project=${project}`,
    'account=', 'account=4445556666', `account=${unknown}&account=${unknown}`,
    Array.from({ length: 51 }, (_, index) => `account=11111111-1111-4111-8111-${String(index).padStart(12, '0')}`).join('&'),
    `project=${unknown}`, `account=${unknown}`,
  ]) {
    const response = await report(admin, `${QUERY}&${query}`);
    assert.equal(response.status, 400, query);
    const body = await read(response);
    assert.equal(typeof body.error, 'string');
    assert.equal('campaigns' in body, false);
  }
  assert.equal(google.calls.length + meta.calls.length, 0);
  // Without a scope resolver (other callers of reportCampaigns), project filters are refused.
  await assert.rejects(reportCampaigns(new URLSearchParams(`project=${project}`), {
    google: async () => ({ platform: 'google', status: 'not_configured', campaigns: null }),
    meta: async () => ({ platform: 'meta', status: 'not_configured', campaigns: null }),
  }), /not available/);
});

test('report filter: only accounts in the project (and account filter) are queried', async () => {
  const { admin, member, id, google, meta } = await workspace();
  const project = await create(admin, 'Fixture Store');
  await assignAccounts(post('/api/projects/assign', { body: { assignments: [
    { accountId: id(STORE), projectId: project }, { accountId: id(SHOP_EU), projectId: project },
  ] } }), admin);
  const insights = () => [...new Set(meta.calls.filter(call => call.url.includes('/insights')).map(call => /act_(\d+)/.exec(call.url)![1]))].sort();
  const googleCustomers = () => google.calls.filter(call => call.url.includes('googleads.googleapis.com'))
    .map(call => /customers\/(\d+)/.exec(call.url)![1]);

  // The project: both platforms, only its two accounts.
  const scoped = await read(report(member, `${QUERY}&project=${project}`));
  assert.equal(scoped.status, 'available');
  assert.deepEqual(scoped.filters, { platform: null, start: yesterday, end: yesterday, project, accounts: [] });
  assert.deepEqual(insights(), [STORE]);
  assert.deepEqual([...new Set(googleCustomers())], [SHOP_EU]);
  assert.deepEqual([...new Set(scoped.campaigns.map((row: { accountId: string }) => row.accountId))].sort(), [SHOP_EU, STORE].sort());
  assert.deepEqual(scoped.sources.map((source: { accounts: { id: string }[] }) => source.accounts.map(account => account.id)), [[SHOP_EU], [STORE]]);

  // An account filter inside the project: Google is not contacted at all.
  google.calls.length = 0;
  meta.calls.length = 0;
  const one = await read(report(admin, `${QUERY}&project=${project}&account=${id(STORE)}`));
  assert.deepEqual(one.sources.map((source: { platform: string }) => source.platform), ['meta']);
  assert.equal(google.calls.length, 0);
  assert.deepEqual(insights(), [STORE]);
  // An account outside the project is a contradiction, not an empty report.
  assert.equal((await report(admin, `${QUERY}&project=${project}&account=${id(BRAND)}`)).status, 400);

  // Unassigned: everything else.
  google.calls.length = 0;
  meta.calls.length = 0;
  const rest = await read(report(admin, `${QUERY}&project=unassigned`));
  assert.deepEqual(insights(), [BRAND, PERSONAL].sort());
  assert.deepEqual([...new Set(googleCustomers())], [BRAND_US]);
  assert.equal(rest.filters.project, 'unassigned');

  // Platform + account filters (no project) across the workspace.
  google.calls.length = 0;
  meta.calls.length = 0;
  const filtered = await read(report(admin, `${QUERY}&platform=meta&account=${id(BRAND)}&account=${id(PERSONAL)}`));
  assert.equal(google.calls.length, 0);
  assert.deepEqual(insights(), [BRAND, PERSONAL].sort());
  assert.deepEqual(filtered.filters.accounts, [id(BRAND), id(PERSONAL)]);
  assert.equal(filtered.filters.project, null);

  // A project without selected accounts: nothing is contacted, no sources.
  const empty = await create(admin, 'Empty');
  google.calls.length = 0;
  meta.calls.length = 0;
  const response = await report(admin, `${QUERY}&project=${empty}`);
  const body = await read(response);
  assert.equal(body.status, 'not_configured');
  assert.deepEqual(body.sources, []);
  assert.equal(google.calls.length + meta.calls.length, 0);

  // Without a filter the response is unchanged: every selected account, no project keys.
  const all = await read(report(admin, QUERY));
  assert.deepEqual(Object.keys(all.filters), ['platform', 'start', 'end']);
});

test('projectName normalizes and rejects names the server would not store', () => {
  assert.equal(projectName(' North\tWind  AU '), 'North Wind AU');
  assert.equal(projectName('Cafe\u0301'), 'Café');
  for (const value of ['', ' ', 'x'.repeat(81), 'a\u0000b', 'a\u200eb', 1, null, undefined, ['x']]) {
    assert.equal(projectName(value), null, JSON.stringify(value));
  }
});
