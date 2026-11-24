import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accountsInScope, nameTokens, projectKey, scopeLabel, suggestProjects, type ProjectAccount, type ProjectsSummary,
} from '../src/client/lib/projects.ts';
import { accountFilter, apiQuery, resolveWindow, validateDashboardSearch } from '../src/client/lib/search.ts';

let next = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`;
const account = (name: string | null, platform: 'google' | 'meta' = 'meta', projectId: string | null = null, currency = 'AUD'): ProjectAccount => ({
  id: uuid(), platform, customerId: String(1_000_000 + next), name, currency, projectId,
});

test('suggestions group accounts by normalized name and ignore "Ad Account"-style words', () => {
  const wombatMeta = account('RapidWombat Ad Account');
  const wombatGoogle = account('RapidWombat', 'google');
  const northwind = account('Northwind Ad Account');
  const suggestions = suggestProjects([wombatMeta, northwind, wombatGoogle], []);
  assert.deepEqual(suggestions, [
    { key: 'rapidwombat', name: 'RapidWombat', projectId: null, accountIds: [wombatMeta.id, wombatGoogle.id], confident: true },
    { key: 'northwind', name: 'Northwind', projectId: null, accountIds: [northwind.id], confident: false },
  ]);
});

test('case, accents, punctuation, currency and long IDs do not split a group', () => {
  assert.equal(projectKey('Café Roma – Ads (AUD)', 'AUD'), 'caferoma');
  assert.equal(projectKey('CAFE ROMA', 'USD'), 'caferoma');
  assert.equal(projectKey('cafe-roma 1234567890'), 'caferoma');
  assert.deepEqual(nameTokens('The Meta Ads Account of Rapid Wombat'), ['of', 'Rapid', 'Wombat']);
  const a = account('Café Roma – Ads (AUD)');
  const b = account('CAFE ROMA', 'google');
  const [group] = suggestProjects([a, b], []);
  assert.deepEqual(group?.accountIds, [a.id, b.id]);
  assert.equal(group?.name, 'Café Roma', 'the shortest spelling (first on a tie)');
});

test('a name that extends another joins it; noise-only and nameless accounts get no suggestion', () => {
  const base = account('Northwind', 'google');
  const search = account('Northwind Search', 'google');
  const meta = account('Northwind Ad Account');
  const noise = account('Ad Account');
  const nameless = account(null);
  // "My" is too short to absorb "My Shop".
  const my = account('My');
  const myShop = account('My Shop');
  const suggestions = suggestProjects([base, search, meta, noise, nameless, my, myShop], []);
  const northwind = suggestions.find(item => item.key === 'northwind');
  assert.deepEqual(northwind?.accountIds.sort(), [base.id, search.id, meta.id].sort());
  assert.ok(!suggestions.some(item => item.accountIds.includes(noise.id) || item.accountIds.includes(nameless.id)));
  assert.ok(suggestions.some(item => item.key === 'myshop'));
});

test('assigned accounts are never moved; existing projects receive matching unassigned accounts', () => {
  const projects = [{ id: uuid(), name: 'Rapid Wombat' }, { id: uuid(), name: 'Empty' }];
  const assigned = account('RapidWombat Ad Account', 'meta', projects[0]!.id);
  const loose = account('RAPIDWOMBAT AU');
  const looseGoogle = account('rapidwombat', 'google');
  const suggestions = suggestProjects([assigned, loose, looseGoogle], projects);
  assert.deepEqual(suggestions, [{
    key: 'rapidwombat', name: 'Rapid Wombat', projectId: projects[0]!.id, accountIds: [looseGoogle.id, loose.id], confident: true,
  }]);
  assert.deepEqual(suggestProjects([assigned], projects), [], 'nothing to propose');
});

test('scope helpers: accounts and labels for all, unassigned and one project', () => {
  const project = { id: uuid(), name: 'RapidWombat', createdAt: null, accountIds: [] as string[] };
  const inside = account('A', 'google', project.id);
  const outside = account('B');
  const summary: ProjectsSummary = { role: 'member', projects: [project], accounts: [inside, outside] };
  assert.deepEqual(accountsInScope(summary, undefined), [inside, outside]);
  assert.deepEqual(accountsInScope(summary, 'unassigned'), [outside]);
  assert.deepEqual(accountsInScope(summary, project.id), [inside]);
  assert.equal(scopeLabel(summary, undefined), 'All projects');
  assert.equal(scopeLabel(summary, 'unassigned'), 'Unassigned');
  assert.equal(scopeLabel(summary, project.id), 'RapidWombat');
  assert.equal(scopeLabel(summary, uuid()), null, 'deleted project');
});

test('dashboard URL keeps only valid project and account filters and maps them to the API query', () => {
  const now = new Date('2026-11-20T12:00:00Z');
  const project = uuid();
  const [a, b] = [uuid(), uuid()];
  const valid = validateDashboardSearch({ project, accounts: `${a},${b}` }, now);
  assert.equal(valid.project, project);
  assert.equal(valid.accounts, `${a},${b}`);
  assert.equal(validateDashboardSearch({ project: 'unassigned' }, now).project, 'unassigned');
  for (const raw of [{ project: 'all' }, { project: '0000000A-0000-4000-8000-000000000001' }, { project: 5 }]) {
    assert.equal(validateDashboardSearch(raw, now).project, undefined, JSON.stringify(raw));
  }
  for (const accounts of ['', `${a},${a}`, `${a},x`, `${a},`, [a]]) {
    assert.equal(validateDashboardSearch({ accounts }, now).accounts, undefined, JSON.stringify(accounts));
  }
  assert.deepEqual(accountFilter(valid), [a, b]);
  assert.deepEqual(accountFilter({}), []);
  assert.equal(apiQuery(resolveWindow({ range: '7d' }, now), 'meta', { project, accounts: [a, b] }),
    `platform=meta&days=7&project=${project}&account=${a}&account=${b}`);
});
