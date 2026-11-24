import assert from 'node:assert/strict';
import test from 'node:test';
import type { Platform, Source } from '../src/client/lib/report.ts';
import { planSource, type Viewer } from '../src/client/lib/sourceAction.ts';

const admin: Viewer = { admin: true, canSetUp: true };
const member: Viewer = { admin: false, canSetUp: false };
const workspaceAdminOnly: Viewer = { admin: true, canSetUp: false };
const src = (platform: Platform, extra: Partial<Source>): Source => ({ platform, status: 'not_configured', totals: null, ...extra });
const summary = (plan: ReturnType<typeof planSource>) => ({ primary: plan.primary, secondary: plan.secondary?.label ?? null });

test('not set up on the instance: admin gets the setup wizard, member is pointed to Sources', () => {
  const meta = src('meta', {});
  const plan = planSource(meta, admin);
  assert.deepEqual(plan.primary, { kind: 'setup', label: 'Set up Meta Ads', platform: 'meta' });
  assert.equal(plan.secondary, null);
  assert.equal(planSource(src('google', {}), admin).primary?.label, 'Set up Google Ads');
  const asMember = planSource(meta, member);
  assert.equal(asMember.primary, null);
  assert.equal(asMember.secondary?.label, 'View Sources');
  assert.match(asMember.message, /Ask an admin to set up Meta Ads/);
  // A workspace admin who is not an instance admin cannot open the wizard.
  assert.equal(planSource(meta, workspaceAdminOnly).primary, null);
  // Role not loaded yet: no button.
  assert.deepEqual(summary(planSource(meta, null)), { primary: null, secondary: 'View Sources' });
});

test('not connected: admin connects with the POST flow, member asks an admin', () => {
  const source = src('meta', { detail: 'not_connected' });
  assert.deepEqual(planSource(source, admin).primary, { kind: 'connect', label: 'Connect Meta Ads', platform: 'meta' });
  assert.deepEqual(planSource(source, workspaceAdminOnly).primary, { kind: 'connect', label: 'Connect Meta Ads', platform: 'meta' });
  const plan = planSource(source, member);
  assert.equal(plan.primary, null);
  assert.match(plan.message, /Ask an admin to connect Meta Ads/);
  assert.equal(plan.secondary?.label, 'View Sources');
});

test('no accounts selected: admin chooses accounts', () => {
  const source = src('google', { detail: 'no_accounts_selected' });
  assert.deepEqual(planSource(source, admin).primary, { kind: 'accounts', label: 'Choose accounts', platform: 'google' });
  assert.equal(planSource(source, member).primary, null);
});

test('revoked or expired: admin reconnects, member asks', () => {
  const source = src('google', { status: 'unavailable', detail: 'reconnect_required' });
  assert.deepEqual(planSource(source, admin).primary, { kind: 'connect', label: 'Reconnect Google Ads', platform: 'google' });
  const plan = planSource(source, member);
  assert.equal(plan.primary, null);
  assert.equal(plan.secondary?.label, 'View Sources');
});

test('setup issue: Fix setup targets the wizard step; only instance admins get it', () => {
  const source = src('google', { status: 'unavailable', detail: 'setup_required', setupIssue: 'api_disabled' });
  assert.deepEqual(planSource(source, admin).primary, { kind: 'setup', label: 'Fix setup', platform: 'google', issue: 'api_disabled' });
  assert.deepEqual(planSource(src('meta', { detail: 'setup_required' }), admin).primary, { kind: 'setup', label: 'Fix setup', platform: 'meta' });
  assert.equal(planSource(source, workspaceAdminOnly).primary, null);
  assert.equal(planSource(source, member).secondary?.label, 'View Sources');
});

test('expiring soon: admin reconnects before the date; member only manages', () => {
  const source = src('meta', { status: 'available', reconnectBy: '2026-12-01T00:00:00Z' });
  const plan = planSource(source, admin);
  assert.deepEqual(plan.primary, { kind: 'connect', label: 'Reconnect before 2026-12-01', platform: 'meta', expiresAt: '2026-12-01T00:00:00Z' });
  const asMember = planSource(source, member);
  assert.equal(asMember.primary, null);
  assert.equal(asMember.secondary?.label, 'Manage in Sources');
});

test('transient unavailable: Retry for everyone; live: only Manage in Sources', () => {
  for (const viewer of [admin, member, null]) {
    assert.deepEqual(summary(planSource(src('meta', { status: 'unavailable' }), viewer)), { primary: null, secondary: 'Retry' });
    assert.deepEqual(summary(planSource(src('meta', { status: 'available' }), viewer)), { primary: null, secondary: 'Manage in Sources' });
  }
});

test('copy is one plain sentence without the old phrasing', () => {
  const details = [undefined, 'not_connected', 'no_accounts_selected', 'reconnect_required', 'setup_required'] as const;
  for (const detail of details) for (const status of ['available', 'not_configured', 'unavailable'] as const) {
    for (const viewer of [admin, member, null]) {
      const { message } = planSource(src('meta', { status, ...(detail ? { detail } : {}) }), viewer);
      assert.doesNotMatch(message, /rather than zero/);
    }
  }
  assert.equal(planSource(src('meta', { detail: 'not_connected' }), admin).message, "Meta Ads isn't connected yet, so its figures show —.");
});
