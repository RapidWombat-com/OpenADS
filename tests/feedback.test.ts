import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyMessage, assignMessage, createdMessage, deletedMessage, renamedMessage, safeMessage, selectionMessage,
} from '../src/client/lib/feedback.ts';
import { moveAccount, type ProjectsSummary } from '../src/client/lib/projects.ts';
import { SourcesError } from '../src/client/lib/sources.ts';

test('assignment and project messages', () => {
  assert.equal(assignMessage('Northwind Ad Account', 'Contoso'), 'Northwind Ad Account → Contoso');
  assert.equal(assignMessage('Northwind Ad Account', null), 'Northwind Ad Account moved to Unassigned');
  assert.equal(createdMessage('Acme'), 'Created Acme');
  assert.equal(renamedMessage('Acme', 'Acme Co'), 'Renamed Acme → Acme Co');
  assert.equal(deletedMessage('Acme'), 'Deleted Acme');
  assert.equal(selectionMessage('Meta Ads', 1), 'Meta Ads: 1 ad account selected');
  assert.equal(selectionMessage('Meta Ads', 0), 'Meta Ads: no ad accounts selected');
});

test('accepting suggestions says what was created', () => {
  const group = (name: string, count: number, existing = false) => ({ name, accountIds: Array(count).fill('x'), existing });
  assert.equal(applyMessage([group('Contoso', 2)]), 'Created Contoso with 2 accounts');
  assert.equal(applyMessage([group('Contoso', 1)]), 'Created Contoso with 1 account');
  assert.equal(applyMessage([group('Northwind', 2, true)]), 'Added 2 accounts to Northwind');
  assert.equal(applyMessage([group('A', 2), group('B', 1)]), 'Created 2 projects with 3 accounts');
  assert.equal(applyMessage([group('A', 2), group('B', 1, true)]), 'Created 1 project, updated 1 project with 3 accounts');
});

test('toast errors carry only application-authored text, on one short line', () => {
  assert.equal(safeMessage(new SourcesError('A project named “X” exists.', 409), 'fallback'), 'A project named “X” exists.');
  assert.equal(safeMessage(new Error('SELECT * FROM secrets at /srv/x.js:1'), 'Try again.'), 'Try again.');
  assert.equal(safeMessage('boom', 'Try again.'), 'Try again.');
  const long = safeMessage(new SourcesError('word '.repeat(80), 400), 'x');
  assert.ok(long.length <= 140 && long.endsWith('…'));
});

const summary = (): ProjectsSummary => ({
  role: 'admin',
  projects: [
    { id: 'p1', name: 'One', createdAt: null, accountIds: ['a1'] },
    { id: 'p2', name: 'Two', createdAt: null, accountIds: [] },
  ],
  accounts: [
    { id: 'a1', platform: 'meta', customerId: '1', name: 'A1', currency: null, projectId: 'p1' },
    { id: 'a2', platform: 'google', customerId: '2', name: 'A2', currency: null, projectId: null },
  ],
});

test('optimistic move and rollback touch only the moved account', () => {
  const before = summary();
  const moved = moveAccount(before, 'a1', 'p2');
  assert.equal(moved.accounts[0].projectId, 'p2');
  assert.deepEqual(moved.projects.map(p => p.accountIds), [[], ['a1']]);
  // Another row saved in the meantime.
  const both = moveAccount(moved, 'a2', 'p1');
  // The first one fails: rolled back to its previous project; a2 keeps its own change.
  const rolledBack = moveAccount(both, 'a1', 'p1');
  assert.equal(rolledBack.accounts[0].projectId, 'p1');
  assert.equal(rolledBack.accounts[1].projectId, 'p1');
  assert.deepEqual(rolledBack.projects.map(p => [...p.accountIds].sort()), [['a1', 'a2'], []]);
  assert.deepEqual(before, summary(), 'input is not mutated');
  assert.equal(moveAccount(before, 'a1', null).projects[0].accountIds.length, 0);
});
