import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  acquireDeployLock, BUILT_CONFIG, childEnvironment, classifyProbe, CONFIG_DIR, CONFIG_PATH, envFileModeWarning, LOCK_PATH, LOCK_STALE_MS, D1_ID_PLACEHOLDER, deployConfig, DeployError, ENCRYPTED_DATA_QUERY, extractJson,
  KEY_CLAIM_QUERY, keyBackupPath, keyClaimSql, parseEnvFile, parseJsonc, renderConfig, RESET_ENCRYPTED_DATA_SQL, runDeploy, validateEnv, wranglerSafetyEnv,
  type DeployDeps, type DeploySettings, type RunOptions,
} from '../scripts/lib/cloudflare-deploy.ts';
import { importTokenKey } from '../src/lib/crypto.ts';
import { createTestD1 } from './helpers/d1.ts';

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const AUD = '4f2c9a1b7e3d5f60812a9b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e';
const D1_ID = '11111111-2222-3333-4444-555555555555';
const base = {
  CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
  OPENADS_HOSTNAME: 'ads.acme-example.org',
  ACCESS_TEAM_HOSTNAME: 'acme.cloudflareaccess.com',
  ACCESS_AUDIENCE: AUD,
  ACCESS_ALLOWED_EMAILS: 'owner@acme-example.org, @acme-example.org',
  OPENADS_ADMIN_EMAILS: 'Owner@acme-example.org',
};
const template = parseJsonc(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')) as Record<string, unknown>;

function settings(extra: Record<string, string> = {}): DeploySettings {
  const result = validateEnv({ ...base, ...extra });
  assert.ok(result.ok, JSON.stringify(result));
  return result.settings;
}

function errorsOf(raw: Record<string, string>): string[] {
  const result = validateEnv(raw);
  assert.equal(result.ok, false, JSON.stringify(raw));
  return result.ok ? [] : result.errors;
}

test('env file: dotenv syntax, defaults, PUBLIC_ORIGIN derived, vars and secrets separated', () => {
  const raw = parseEnvFile(`# comment\nCLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\nOPENADS_HOSTNAME="ads.acme-example.org"\n\nACCESS_TEAM_HOSTNAME='acme.cloudflareaccess.com'\nACCESS_AUDIENCE=${AUD}\nACCESS_ALLOWED_EMAILS=owner@acme-example.org,@acme-example.org\nOPENADS_ADMIN_EMAILS=owner@acme-example.org\nMETA_APP_ID=1234567890123456\nMETA_APP_SECRET=fedcba9876543210fedcba9876543210\nMETA_API_VERSION=v27.0\nMETA_CONVERSION_ACTION_TYPE=purchase\n`);
  const result = validateEnv(raw);
  assert.ok(result.ok);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.settings, {
    accountId: ACCOUNT, hostname: 'ads.acme-example.org', origin: 'https://ads.acme-example.org',
    workerName: 'openads', d1Name: 'openads', admins: ['owner@acme-example.org'],
    vars: {
      PUBLIC_ORIGIN: 'https://ads.acme-example.org', OPENADS_ADMIN_EMAILS: 'owner@acme-example.org',
      ACCESS_TEAM_HOSTNAME: 'acme.cloudflareaccess.com', ACCESS_AUDIENCE: AUD,
      ACCESS_ALLOWED_EMAILS: 'owner@acme-example.org,@acme-example.org',
      META_APP_ID: '1234567890123456', META_API_VERSION: 'v27.0', META_CONVERSION_ACTION_TYPE: 'purchase',
    },
    secrets: { META_APP_SECRET: 'fedcba9876543210fedcba9876543210' },
  });
  assert.equal(settings({ OPENADS_WORKER_NAME: 'ads-prod', OPENADS_D1_NAME: 'ads_db' }).workerName, 'ads-prod');
  assert.equal(settings({ GOOGLE_API_VERSION: 'v27' }).vars.GOOGLE_API_VERSION, 'v27');
  // Admin addresses are normalized like the app does.
  assert.deepEqual(settings().admins, ['owner@acme-example.org']);
});

test('env validation refuses anything the Worker would refuse, with actionable messages', () => {
  const cases: [Record<string, string>, RegExp][] = [
    [{ ...base, CLOUDFLARE_ACCOUNT_ID: '' }, /CLOUDFLARE_ACCOUNT_ID is required/],
    [{ ...base, CLOUDFLARE_ACCOUNT_ID: 'my-account' }, /32-character account ID/],
    [{ ...base, OPENADS_HOSTNAME: 'https://ads.acme-example.org' }, /bare host name/],
    [{ ...base, OPENADS_HOSTNAME: 'ads.acme-example.org/app' }, /bare host name/],
    [{ ...base, OPENADS_HOSTNAME: 'ADS.acme-example.org' }, /lowercase DNS name/],
    [{ ...base, OPENADS_HOSTNAME: 'localhost' }, /lowercase DNS name/],
    [{ ...base, OPENADS_HOSTNAME: '203.0.113.9' }, /lowercase DNS name/],
    [{ ...base, OPENADS_HOSTNAME: 'openads.acme.workers.dev' }, /not workers\.dev/],
    [{ ...base, ACCESS_TEAM_HOSTNAME: 'https://acme.cloudflareaccess.com' }, /without https/],
    [{ ...base, ACCESS_TEAM_HOSTNAME: 'acme.example.org' }, /bare team hostname/],
    [{ ...base, ACCESS_AUDIENCE: 'two words' }, /Audience \(AUD\) tag/],
    [{ ...base, ACCESS_ALLOWED_EMAILS: 'owner@acme-example.org,' }, /one entry is malformed/],
    [{ ...base, ACCESS_ALLOWED_EMAILS: '@acme-example.org', OPENADS_ADMIN_EMAILS: 'someone@other.org' }, /not allowed by ACCESS_ALLOWED_EMAILS/],
    [{ ...base, OPENADS_ADMIN_EMAILS: '@acme-example.org' }, /no @domain entries/],
    [{ ...base, GOOGLE_API_VERSION: '26' }, /GOOGLE_API_VERSION/],
    [{ ...base, META_ACCOUNT_ID: '123' }, /META_ACCOUNT_ID is no longer used: Meta Ads is connected in the app/],
    [{ ...base, META_ACCESS_TOKEN: 'token' }, /META_ACCESS_TOKEN is no longer used/],
    [{ ...base, META_APP_ID: 'my-app' }, /META_APP_ID is the numeric App ID/],
    [{ ...base, META_APP_ID: '1234567890123456', META_APP_SECRET: 'not-a-secret' }, /META_APP_SECRET is the 32-character App Secret/],
    [{ ...base, META_APP_SECRET: 'fedcba9876543210fedcba9876543210' }, /META_APP_SECRET needs META_APP_ID/],
    [{ ...base, META_API_VERSION: 'v27' }, /META_API_VERSION looks like v27\.0/],
    [{ ...base, META_CONVERSION_ACTION_TYPE: 'Purchases' }, /META_CONVERSION_ACTION_TYPE is one exact Meta action type/],
    [{ ...base, OPENADS_WORKER_NAME: 'OpenADS' }, /OPENADS_WORKER_NAME/],
    [{ ...base, OPENADS_D1_NAME: 'open ads' }, /OPENADS_D1_NAME/],
    [{ ...base, ACESS_AUDIENCE: AUD }, /Unknown setting ACESS_AUDIENCE/],
    [{ ...base, TOKEN_ENCRYPTION_KEY: 'x' }, /only for restoring a lost key/],
    [{ ...base, TOKEN_ENCRYPTION_KEY: 'A'.repeat(43) }, /only for restoring a lost key/],
    [{ ...base, OPENADS_HOSTNAME: 'openads.example.com' }, /example value/],
    [{ ...base, ACCESS_TEAM_HOSTNAME: 'your-team.cloudflareaccess.com' }, /example value/],
    [{ ...base, ACCESS_ALLOWED_EMAILS: 'you@example.com', OPENADS_ADMIN_EMAILS: 'you@example.com' }, /example value/],
  ];
  for (const [raw, pattern] of cases) {
    const errors = errorsOf(raw);
    assert.ok(errors.some(error => pattern.test(error)), `${JSON.stringify(raw)} → ${errors.join(' | ')}`);
  }
  // The committed example only needs the operator's values.
  const example = parseEnvFile(readFileSync(new URL('../deploy/.env.cloudflare.example', import.meta.url), 'utf8'));
  assert.ok(errorsOf(example).length > 0);
  for (const key of Object.keys(example)) assert.ok(!/SECRET|KEY$/.test(key), key);
  const exampleText = readFileSync(new URL('../deploy/.env.cloudflare.example', import.meta.url), 'utf8');
  assert.match(exampleText, /^# META_APP_ID=$/m);
  assert.match(exampleText, /^# META_APP_SECRET=$/m);
  assert.doesNotMatch(exampleText, /META_ACCOUNT_ID|META_ACCESS_TOKEN/);
  const warned = validateEnv({ ...base, ACCESS_AUDIENCE: 'not-hex-but-one-token' });
  assert.ok(warned.ok && warned.warnings.some(warning => /AUD tag/.test(warning)));
  const appIdOnly = validateEnv({ ...base, META_APP_ID: '1234567890123456' });
  assert.ok(appIdOnly.ok && appIdOnly.warnings.some(warning => /META_APP_SECRET is not in the env file/.test(warning)));
  assert.deepEqual(appIdOnly.ok && appIdOnly.settings.secrets, {});
});

test('generated config keeps the Access-protecting defaults and points at the real D1', () => {
  const config = deployConfig(template, settings({ OPENADS_D1_NAME: 'ads_db' }), D1_ID);
  assert.deepEqual(config, {
    $schema: '../node_modules/wrangler/config-schema.json',
    name: 'openads',
    account_id: ACCOUNT,
    main: '../src/worker.ts',
    compatibility_date: template.compatibility_date,
    compatibility_flags: template.compatibility_flags,
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: 'ads.acme-example.org', custom_domain: true }],
    assets: { binding: 'ASSETS', run_worker_first: true },
    observability: { enabled: false },
    d1_databases: [{ binding: 'DB', database_name: 'ads_db', database_id: D1_ID, migrations_dir: '../migrations' }],
    vars: settings().vars,
  });
  // Rendered with a header comment, still valid JSONC; no secret ever in it.
  const text = renderConfig(deployConfig(template, settings({ META_APP_ID: '1234567890123456', META_APP_SECRET: 'fedcba9876543210fedcba9876543210' }), D1_ID));
  assert.match(text, /^\/\/ Generated by/);
  assert.equal((parseJsonc(text) as { name: string }).name, 'openads');
  assert.equal((parseJsonc(text) as { vars: Record<string, string> }).vars.META_APP_ID, '1234567890123456');
  assert.equal(text.includes('fedcba9876543210fedcba9876543210'), false);
  assert.equal(text.includes('TOKEN_ENCRYPTION_KEY'), false);
});

test('JSONC and wrangler output parsing', () => {
  assert.deepEqual(parseJsonc('{ "a": "x//y", /* c */ "b": [1, 2,], // d\n }'), { a: 'x//y', b: [1, 2] });
  assert.deepEqual(extractJson('⛅️ wrangler\n[{"uuid":"u","name":"n"}]\n', '['), [{ uuid: 'u', name: 'n' }]);
  assert.throws(() => extractJson('nothing', '{'));
});

test('probe classification: Access redirect passes, 200 fails, Worker-only gate is a warning', () => {
  assert.equal(classifyProbe(302, 'https://acme.cloudflareaccess.com/cdn-cgi/access/login/ads.acme-example.org', ''), 'access');
  assert.equal(classifyProbe(302, 'https://evil.example/login', ''), 'other');
  assert.equal(classifyProbe(200, null, ''), 'open');
  assert.equal(classifyProbe(401, null, '{"error":"Unauthorized."}'), 'worker_gate');
  assert.equal(classifyProbe(403, null, '{"error":"Forbidden."}'), 'worker_gate');
  assert.equal(classifyProbe(403, null, '<html>Cloudflare Access</html>'), 'access');
  assert.equal(classifyProbe(503, null, '{"error":"Access is not configured."}'), 'access_not_configured');
  assert.equal(classifyProbe(522, null, ''), 'other');
});

// ── Orchestration with fakes ───────────────────────────────────────────────

interface Call { command: string; args: string[]; options: RunOptions }
/** A valid generated key (32 bytes, base64), as the CLI's randomKey makes. */
const GENERATED_KEY = Buffer.alloc(32, 3).toString('base64');
interface Encrypted { source: string; key_id: string; n: number }
const NOW = Date.UTC(2026, 0, 2, 3, 4, 5, 678);

function harness(responses: {
  whoami?: object | null; d1?: object[][]; secrets?: 'missing' | 'error' | string[]; probe?: [number, string | null];
  /** What `d1 execute` finds encrypted in D1 (until a reset deletes it); 'error' fails the query. */
  encrypted?: Encrypted[] | 'error'; confirm?: boolean;
  /** Secret lists returned by later `secret list` calls (the re-check before uploading a key). */
  laterSecrets?: ('missing' | string[])[];
  /** Key id already claimed in D1 (instance_meta) by another deploy. */
  claimed?: string;
} = {}) {
  let claimed = responses.claimed ?? null;
  const madePrivate: string[] = [];
  const locks: string[] = [];
  const calls: Call[] = [];
  const written: Record<string, string> = {};
  const privateFiles: Record<string, string> = {};
  const questions: string[] = [];
  let encrypted = responses.encrypted ?? [];
  const secretFiles: { json: string; removed: boolean }[] = [];
  const fetched: string[] = [];
  const logs: string[] = [];
  const d1Lists = [...(responses.d1 ?? [[{ uuid: D1_ID, name: 'openads' }]])];
  const deps: DeployDeps = {
    run: (command, args, options) => {
      calls.push({ command, args: [...args], options });
      const [a, b, c] = args.slice(2);
      if (a === 'whoami') {
        const user = responses.whoami === undefined ? { loggedIn: true, email: 'ops@acme-example.org', accounts: [{ id: ACCOUNT, name: 'Acme' }] } : responses.whoami;
        return user ? { status: 0, stdout: JSON.stringify(user), stderr: '' } : { status: 1, stdout: '{"loggedIn":false}', stderr: '' };
      }
      if (a === 'd1' && b === 'list') return { status: 0, stdout: `banner\n${JSON.stringify(d1Lists.length > 1 ? d1Lists.shift() : d1Lists[0])}`, stderr: '' };
      if (a === 'secret' && b === 'list') {
        const listCalls = calls.filter(call => call.args[2] === 'secret').length;
        const secrets = (listCalls > 1 ? responses.laterSecrets?.[listCalls - 2] : undefined) ?? responses.secrets ?? ['TOKEN_ENCRYPTION_KEY'];
        if (secrets === 'missing') return { status: 1, stdout: '', stderr: '✘ [ERROR] Worker "openads" not found.\n\nIf this is a new Worker, run `wrangler deploy` first to create it.' };
        if (secrets === 'error') return { status: 1, stdout: '', stderr: '✘ [ERROR] Authentication error [code: 10000]' };
        return { status: 0, stdout: JSON.stringify(secrets.map(name => ({ name, type: 'secret_text' }))), stderr: '' };
      }
      if (a === 'd1' && b === 'execute') {
        const sql = args[args.indexOf('--command') + 1];
        if (sql === RESET_ENCRYPTED_DATA_SQL) {
          encrypted = [];
          claimed = null;
          return { status: 0, stdout: '', stderr: '' };
        }
        if (sql?.startsWith('INSERT INTO instance_meta')) {
          claimed ??= /'(k1-[0-9a-f]{16})'/.exec(sql)![1]!; // First writer wins.
          return { status: 0, stdout: '', stderr: '' };
        }
        if (sql === KEY_CLAIM_QUERY) {
          return { status: 0, stdout: JSON.stringify([{ results: claimed ? [{ value: claimed }] : [], success: true, meta: {} }]), stderr: '' };
        }
        assert.equal(sql, ENCRYPTED_DATA_QUERY);
        if (encrypted === 'error') return { status: 1, stdout: '', stderr: '✘ [ERROR] Authentication error [code: 10000]' };
        return { status: 0, stdout: JSON.stringify([{ results: encrypted, success: true, meta: {} }]), stderr: '' };
      }
      void c;
      return { status: 0, stdout: '', stderr: '' };
    },
    files: {
      readText: path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'),
      writePrivateText: (path, text) => { written[path] = text; },
      writeSecretFile: json => {
        const entry = { json, removed: false };
        secretFiles.push(entry);
        return { path: '/tmp/openads-deploy-x/secrets.json', cleanup: () => { entry.removed = true; } };
      },
      createPrivateText: (path, text) => {
        assert.equal(path in privateFiles, false, 'a backup is never overwritten');
        privateFiles[path] = text;
      },
      makePrivate: path => { madePrivate.push(path); },
      lock: path => {
        locks.push(`acquire ${path}`);
        return () => locks.push(`release ${path}`);
      },
    },
    now: () => NOW,
    fetch: (async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      const [status, location] = responses.probe ?? [302, 'https://acme.cloudflareaccess.com/cdn-cgi/access/login/x'];
      return new Response(status === 200 ? 'ok' : null, { status, headers: location ? { Location: location } : {} });
    }) as typeof fetch,
    log: line => logs.push(line),
    randomKey: () => GENERATED_KEY,
    sleep: async () => {},
    nodeVersion: '26.13.0',
    confirm: async question => {
      questions.push(question);
      return responses.confirm ?? false;
    },
  };
  const mutating = () => calls.filter(call => call.options.mutating);
  return { deps, calls, written, privateFiles, questions, secretFiles, fetched, logs, mutating, locks, madePrivate, claimed: () => claimed };
}

const options = (overrides: Partial<Parameters<typeof runDeploy>[0]> = {}) => ({
  settings: settings(), warnings: [], envFile: 'deploy/.env.cloudflare', plan: false, offline: false, probeAttempts: 1, ...overrides,
});

test('--plan --offline runs no command, writes nothing and fetches nothing', async () => {
  const h = harness();
  const report = await runDeploy(options({ plan: true, offline: true }), h.deps);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.written, {});
  assert.equal(h.secretFiles.length, 0);
  assert.equal(h.fetched.length, 0);
  assert.equal(report.keyCreated, false);
  assert.deepEqual(h.locks, [], 'plan mode takes no lock');
  const output = h.logs.join('\n');
  assert.match(output, /would run: npx --no-install wrangler d1 migrations apply DB --remote -c \.openads\/wrangler\.deploy\.jsonc/);
  assert.match(output, new RegExp(`database_id": "${D1_ID_PLACEHOLDER}`));
  assert.match(output, /would run: OPENADS_WRANGLER_CONFIG=\.openads\/wrangler\.deploy\.jsonc npx --no-install vite build/);
});

test('--plan with Cloudflare only reads: whoami, d1 list, secret list — never a mutating command', async () => {
  for (const secrets of [['TOKEN_ENCRYPTION_KEY'], 'missing'] as const) {
    const h = harness({ secrets: secrets as 'missing' | string[] });
    await runDeploy(options({ plan: true }), h.deps);
    assert.deepEqual(h.mutating(), []);
    assert.deepEqual(h.calls.map(call => call.args.slice(2, 4).join(' ')), ['whoami --json', 'd1 list', 'secret list']);
    assert.deepEqual(h.written, {});
    assert.equal(h.secretFiles.length, 0);
    assert.equal(h.fetched.length, 0);
    const output = h.logs.join('\n');
    assert.match(output, new RegExp(`Found "openads" \\(${D1_ID}\\)`));
    assert.match(output, new RegExp(`database_id": "${D1_ID}"`));
    assert.match(output, secrets === 'missing' ? /would generate TOKEN_ENCRYPTION_KEY \(32/ : /TOKEN_ENCRYPTION_KEY is set; left untouched/);
  }
});

test('first deploy: creates D1, builds with the private config, migrates, uploads a new key via a 0600 file, verifies', async () => {
  const h = harness({ d1: [[], [{ uuid: D1_ID, name: 'openads' }]], secrets: 'missing' });
  const report = await runDeploy(options(), h.deps);
  assert.deepEqual(report, {
    d1Id: D1_ID, d1Created: true, keyCreated: true,
    probes: [{ path: '/', result: 'access', status: 302 }, { path: '/api/campaigns.json', result: 'access', status: 302 }],
  });
  for (const call of h.calls) {
    assert.equal(call.command, 'npx');
    assert.equal(call.args[0], '--no-install');
    assert.equal(call.options.env?.CLOUDFLARE_ACCOUNT_ID, ACCOUNT);
  }
  assert.deepEqual(h.calls.map(call => call.args.slice(1).join(' ')), [
    'wrangler whoami --json',
    'wrangler d1 list --json',
    'wrangler d1 create openads',
    'wrangler d1 list --json',
    'vite build',
    `wrangler d1 migrations apply DB --remote -c ${CONFIG_PATH}`,
    'wrangler secret list --name openads --format json',
    // Checked again right before a new key is uploaded.
    'wrangler secret list --name openads --format json',
    // Cross-checkout guard: claim the key id in D1 (first writer wins), read it back.
    `wrangler d1 execute DB --remote --yes -c ${CONFIG_PATH} --command ${keyClaimSql((await importTokenKey(GENERATED_KEY))!.id, NOW)}`,
    `wrangler d1 execute DB --remote --json -c ${CONFIG_PATH} --command ${KEY_CLAIM_QUERY}`,
    `wrangler deploy -c ${BUILT_CONFIG} --secrets-file /tmp/openads-deploy-x/secrets.json`,
  ]);
  assert.deepEqual(h.locks, [`acquire ${LOCK_PATH}`, `release ${LOCK_PATH}`], 'one deploy at a time');
  assert.equal(h.calls[4]!.options.env?.OPENADS_WRANGLER_CONFIG, CONFIG_PATH);
  const config = parseJsonc(h.written[CONFIG_PATH]!) as { d1_databases: { database_id: string }[] };
  assert.equal(config.d1_databases[0]!.database_id, D1_ID);
  // The key goes only into the temp file, which is removed; never into args, env or logs.
  assert.deepEqual(h.secretFiles, [{ json: JSON.stringify({ TOKEN_ENCRYPTION_KEY: GENERATED_KEY }), removed: true }]);
  const deploy = h.calls.at(-1)!;
  assert.deepEqual(deploy.options.unsetEnv, ['TOKEN_ENCRYPTION_KEY']);
  const everything = JSON.stringify(h.calls) + h.logs.join('\n') + JSON.stringify(h.written);
  assert.equal(everything.includes(GENERATED_KEY), false);
  assert.match(h.logs.join('\n'), /Never change or delete it/);
  // The generated key is backed up to a private, git-ignored file (never to the log).
  assert.deepEqual(h.privateFiles, { [keyBackupPath('openads', NOW)]: `${GENERATED_KEY}\n` });
  // The built config and everything under .openads/ are made private after the build.
  assert.deepEqual(h.madePrivate, [BUILT_CONFIG, CONFIG_DIR]);
  assert.equal(h.claimed(), (await importTokenKey(GENERATED_KEY))!.id, 'the uploaded key is the claimed one');
  assert.equal(keyBackupPath('openads', NOW), '.openads/TOKEN_ENCRYPTION_KEY.openads.20260102T030405Z.backup');
  assert.match(h.logs.join('\n'), /move it to your password manager/);
  assert.match(h.logs.join('\n'), /Next {11}Open https:\/\/ads\.acme-example\.org → sign in → Sources → Set up Google Ads \/ Set up Meta Ads/);
  assert.match(h.logs.join('\n'), /https:\/\/ads\.acme-example\.org\/api\/oauth\/meta\/callback/);
});

test('re-running is idempotent: existing D1 and key are reused, nothing but code and vars change', async () => {
  const h = harness();
  const report = await runDeploy(options(), h.deps);
  assert.equal(report.d1Created, false);
  assert.equal(report.keyCreated, false);
  assert.equal(h.calls.some(call => call.args.includes('create')), false);
  assert.equal(h.secretFiles.length, 0);
  assert.deepEqual(h.calls.at(-1)!.args.slice(2), ['deploy', '-c', BUILT_CONFIG]);
  // Env-file secrets are uploaded the same way, key untouched.
  const withMeta = harness();
  await runDeploy(options({ settings: settings({ META_APP_ID: '1234567890123456', META_APP_SECRET: 'fedcba9876543210fedcba9876543210' }) }), withMeta.deps);
  assert.deepEqual(withMeta.secretFiles, [{ json: '{"META_APP_SECRET":"fedcba9876543210fedcba9876543210"}', removed: true }]);
  assert.deepEqual(withMeta.calls.at(-1)!.options.unsetEnv, ['TOKEN_ENCRYPTION_KEY', 'META_APP_SECRET']);
  assert.equal(withMeta.logs.join('\n').includes('fedcba9876543210fedcba9876543210'), false, 'never printed');
  assert.match(withMeta.logs.join('\n'), /Secrets {8}META_APP_SECRET \(from the env file, not printed\)/);
});

test('fails closed: not logged in, wrong account, unknown secret state, public app', async () => {
  const notLogged = harness({ whoami: null });
  await assert.rejects(runDeploy(options(), notLogged.deps), (error: unknown) => error instanceof DeployError && /not logged in/.test(error.message));
  assert.equal(notLogged.calls.length, 1);
  const otherAccount = harness({ whoami: { loggedIn: true, accounts: [{ id: 'f'.repeat(32), name: 'Other' }] } });
  await assert.rejects(runDeploy(options(), otherAccount.deps), /not one of the accounts/);
  assert.equal(otherAccount.mutating().length, 0);
  // Never generate a key when the current state is unknown: it would orphan stored grants.
  const unknown = harness({ secrets: 'error' });
  await assert.rejects(runDeploy(options(), unknown.deps), /Could not list the secrets/);
  assert.equal(unknown.secretFiles.length, 0);
  assert.equal(unknown.calls.some(call => call.args[2] === 'deploy'), false);
  const open = harness({ probe: [200, null] });
  await assert.rejects(runDeploy(options(), open.deps), /answered without signing in/);
  const old = harness();
  await assert.rejects(runDeploy(options(), { ...old.deps, nodeVersion: '22.11.0' }), /too old/);
  assert.equal(old.calls.length, 0);
  // A deploy without an Access application is reported, not hidden.
  const gate = harness({ probe: [401, null] });
  const fetchGate = (async () => new Response('{"error":"Unauthorized."}', { status: 401 })) as typeof fetch;
  const report = await runDeploy(options(), { ...gate.deps, fetch: fetchGate });
  assert.deepEqual(report.probes.map(probe => probe.result), ['worker_gate', 'worker_gate']);
  assert.match(gate.logs.join('\n'), /no Access application covers this hostname/);
});

test('CLI: --plan --offline with a filled env file prints the plan and exits 0; bad env exits 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openads-env-'));
  try {
    const good = join(dir, 'good.env');
    writeFileSync(good, Object.entries(base).map(([key, value]) => `${key}=${value}`).join('\n'));
    const cli = new URL('../scripts/deploy-cloudflare.mjs', import.meta.url).pathname;
    const ok = spawnSync(process.execPath, ['--', cli, '--plan', '--offline', '--env-file', good], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /deploy plan \(nothing will be changed, Cloudflare not contacted\)/);
    assert.match(ok.stdout, /Run without --plan to deploy\./);
    const bad = join(dir, 'bad.env');
    writeFileSync(bad, 'OPENADS_HOSTNAME=https://x.example.org\n');
    const failed = spawnSync(process.execPath, ['--', cli, '--plan', '--offline', '--env-file', bad], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /needs fixing/);
    assert.match(failed.stderr, /CLOUDFLARE_ACCOUNT_ID is required/);
    const missing = spawnSync(process.execPath, ['--', cli, '--env-file', join(dir, 'none.env')], { encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /cp deploy\/\.env\.cloudflare\.example deploy\/\.env\.cloudflare/);
    const offlineAlone = spawnSync(process.execPath, ['--', cli, '--offline', '--env-file', good], { encoding: 'utf8' });
    assert.equal(offlineAlone.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Wrangler logging and the encryption key ────────────────────────────────

test('every child process gets sanitized, file-less Wrangler logging at exactly "log", whatever the shell sets', async () => {
  assert.deepEqual(wranglerSafetyEnv(), { WRANGLER_LOG: 'log', WRANGLER_LOG_SANITIZE: 'true', WRANGLER_WRITE_LOGS: 'false' });
  const h = harness({ d1: [[], [{ uuid: D1_ID, name: 'openads' }]], secrets: 'missing' });
  await runDeploy(options(), h.deps);
  assert.ok(h.calls.some(call => call.args.includes('--secrets-file')));
  for (const inherited of ['debug', 'warn', 'info', 'error', 'none']) {
    const shell = { PATH: '/usr/bin', WRANGLER_LOG: inherited, WRANGLER_LOG_SANITIZE: 'false', WRANGLER_WRITE_LOGS: 'true', TOKEN_ENCRYPTION_KEY: 'x' };
    for (const call of h.calls) {
      // What the CLI runner hands to the child (childEnvironment is its only env source).
      const env = childEnvironment(shell, call.options.env, call.options.unsetEnv);
      assert.equal(env.WRANGLER_LOG, 'log', `${inherited}: ${call.args.join(' ')}`);
      assert.equal(env.WRANGLER_LOG_SANITIZE, 'true');
      assert.equal(env.WRANGLER_WRITE_LOGS, 'false');
      assert.equal(env.PATH, '/usr/bin');
    }
  }
  const deploy = h.calls.find(call => call.args[2] === 'deploy')!;
  assert.equal('TOKEN_ENCRYPTION_KEY' in childEnvironment({ TOKEN_ENCRYPTION_KEY: 'x' }, deploy.options.env, deploy.options.unsetEnv), false);
  const cli = readFileSync(new URL('../scripts/deploy-cloudflare.mjs', import.meta.url), 'utf8');
  assert.match(cli, /const childEnv = childEnvironment\(process\.env, env, unsetEnv\);/);
  assert.doesNotMatch(cli, /inheritedLogLevel/);
});

test('secret list output without JSON (e.g. a quiet log level) fails closed, never generates a key', async () => {
  const h = harness({ secrets: 'missing' });
  const run = h.deps.run;
  const quiet: DeployDeps = { ...h.deps, run: (command, args, runOptions) => args[2] === 'secret'
    ? (h.calls.push({ command, args: [...args], options: runOptions }), { status: 0, stdout: '', stderr: '' }) : run(command, args, runOptions) };
  await assert.rejects(runDeploy(options(), quiet), /Could not read the secret list of Worker "openads"/);
  assert.equal(h.secretFiles.length, 0);
  assert.equal(h.calls.some(call => call.args[2] === 'deploy'), false);
});

test('a key that appears while the deploy runs is never overwritten', async () => {
  const h = harness({ secrets: 'missing', laterSecrets: [['TOKEN_ENCRYPTION_KEY']] });
  await assert.rejects(runDeploy(options(), h.deps), (error: unknown) => {
    assert.ok(error instanceof DeployError);
    assert.match(error.lines.join('\n'), /got a TOKEN_ENCRYPTION_KEY while this deploy was running[\s\S]*not overwritten/);
    return true;
  });
  assert.equal(h.calls.some(call => call.args[2] === 'deploy'), false);
  assert.equal(h.secretFiles.length, 0);
  assert.deepEqual(h.privateFiles, {}, 'no backup of a key that was never uploaded');
  assert.deepEqual(h.locks, [`acquire ${LOCK_PATH}`, `release ${LOCK_PATH}`], 'released on failure');
});

test('deploy lock: O_EXCL, pid + time, 0600; a second deploy fails fast; a live holder is never stolen; stale locks are replaced', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openads-lock-'));
  try {
    const path = join(dir, 'deploy.lock');
    const t0 = 1_000_000_000_000;
    const release = acquireDeployLock(path, { now: t0, pid: 4242, host: 'h', alive: () => true });
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { pid: 4242, host: 'h', startedAt: t0 });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    // A concurrent deploy from the same checkout.
    assert.throws(() => acquireDeployLock(path, { now: t0 + 60_000, pid: 4343, host: 'h', alive: () => true }), (error: unknown) => {
      assert.ok(error instanceof DeployError);
      assert.match(error.lines.join('\n'), /Another deploy is running from this checkout \(pid 4242 on h[\s\S]*Do not run two deploys at once[\s\S]*still running on this host/);
      return true;
    });
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, 4242, 'the holder keeps its lock');
    // Over 30 minutes old but its process is still alive on this host: never stolen.
    assert.throws(() => acquireDeployLock(path, { now: t0 + 10 * LOCK_STALE_MS, pid: 4343, host: 'h', alive: pid => pid === 4242 }), (error: unknown) => {
      assert.ok(error instanceof DeployError);
      assert.match(error.lines.join('\n'), /still running on this host, so its lock is kept however old it is/);
      return true;
    });
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, 4242, 'a live holder keeps its lock');
    // Over 30 minutes old and from another host (its pid cannot be checked here): replaced, with a message.
    const logs: string[] = [];
    const takeover = acquireDeployLock(path, { now: t0 + LOCK_STALE_MS + 1, pid: 4343, host: 'other', alive: () => true, log: line => logs.push(line) });
    assert.match(logs.join('\n'), /Replacing a stale deploy lock \(pid 4242[^)]*over 30 minutes ago\)/);
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).pid, 4343);
    release(); // The old holder's release must not remove the new holder's lock.
    assert.ok(existsSync(path));
    // Within 30 minutes, a lock from another host is respected.
    assert.throws(() => acquireDeployLock(path, { now: t0 + LOCK_STALE_MS + 2, pid: 5, host: 'h', alive: () => false }), DeployError);
    takeover();
    assert.equal(existsSync(path), false);
    // A lock whose process on this host is gone (interrupted deploy) is stale too.
    acquireDeployLock(path, { now: t0, pid: 1, host: 'h', alive: () => true });
    const after = acquireDeployLock(path, { now: t0 + 1, pid: 2, host: 'h', alive: pid => pid !== 1, log: () => {} });
    after();
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('operator files: env-file mode warning, private config and exclusive key backups in the CLI', () => {
  assert.equal(envFileModeWarning(0o100600, 'deploy/.env.cloudflare'), null);
  assert.equal(envFileModeWarning(0o100400, 'deploy/.env.cloudflare'), null);
  assert.match(envFileModeWarning(0o100644, 'deploy/.env.cloudflare')!, /readable by other users \(mode 644\)\. Run: chmod 600 deploy\/\.env\.cloudflare/);
  assert.match(envFileModeWarning(0o100640, 'x')!, /mode 640/);
  const cli = readFileSync(new URL('../scripts/deploy-cloudflare.mjs', import.meta.url), 'utf8');
  assert.match(cli, /writeFileSync\(target, text, \{ mode: 0o600 \}\);\s*chmodSync\(target, 0o600\)/);
  assert.match(cli, /flag: 'wx'/);
  // The built config and .openads/ are chmod 0600 (directory 0700) after the build, never following links.
  assert.match(cli, /makePrivate: path => \{[\s\S]*isSymbolicLink\(\)\) return;[\s\S]*chmodSync\(target, 0o700\)[\s\S]*chmodSync\(join\(target, entry\.name\), 0o600\)[\s\S]*chmodSync\(target, 0o600\)/);
  assert.match(cli, /envFileModeWarning\(statSync\(envSource\)\.mode, envFile\)/);
});

test('CLI warns when the env file is group/world-readable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'openads-env-'));
  try {
    const env = join(dir, 'open.env');
    writeFileSync(env, Object.entries(base).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o644 });
    const cli = new URL('../scripts/deploy-cloudflare.mjs', import.meta.url).pathname;
    const result = spawnSync(process.execPath, ['--', cli, '--plan', '--offline', '--env-file', env], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /readable by other users \(mode 644\)\. Run: chmod 600/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const OLD_KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');
const keyId = async (key: string) => (await importTokenKey(key))!.id;

test('existing D1 without encrypted data and no key: checked read-only, then a key is generated', async () => {
  const h = harness({ secrets: 'missing', encrypted: [] });
  const report = await runDeploy(options(), h.deps);
  assert.equal(report.keyCreated, true);
  const check = h.calls.find(call => call.args.includes('execute'))!;
  assert.deepEqual(check.args.slice(2), ['d1', 'execute', 'DB', '--remote', '--json', '-c', CONFIG_PATH, '--command', ENCRYPTED_DATA_QUERY]);
  assert.equal(check.options.mutating, false);
  assert.deepEqual(h.secretFiles, [{ json: JSON.stringify({ TOKEN_ENCRYPTION_KEY: GENERATED_KEY }), removed: true }]);
});

test('Worker lost its key but D1 holds ciphertext: stops before deploying, explains restore and reset', async () => {
  const id = await keyId(OLD_KEY);
  const h = harness({ secrets: 'missing', encrypted: [
    { source: 'connection', key_id: id, n: 2 }, { source: 'google_setup', key_id: id, n: 1 },
  ] });
  await assert.rejects(runDeploy(options(), h.deps), (error: unknown) => {
    assert.ok(error instanceof DeployError);
    const text = error.lines.join('\n');
    assert.match(text, /has no TOKEN_ENCRYPTION_KEY, but D1 database "openads" holds data encrypted with one: 2 Google\/Meta connection\(s\) \(key id k1-[0-9a-f]{16}\), stored Google OAuth client secret/);
    assert.match(text, /add TOKEN_ENCRYPTION_KEY=<the old key> to deploy\/\.env\.cloudflare/);
    assert.match(text, /--reset-encrypted-data/);
    return true;
  });
  assert.equal(h.calls.some(call => call.args[2] === 'deploy'), false);
  assert.equal(h.secretFiles.length, 0);
  assert.deepEqual(h.privateFiles, {});
  assert.equal(h.questions.length, 0);
  // Unknown state fails closed too.
  const unknown = harness({ secrets: 'missing', encrypted: 'error' });
  await assert.rejects(runDeploy(options(), unknown.deps), /Could not check D1 database "openads" for encrypted data/);
  assert.equal(unknown.calls.some(call => call.args[2] === 'deploy'), false);
  // --plan only describes the check (the private config it needs is not written in plan mode).
  const plan = harness({ secrets: 'missing', encrypted: [{ source: 'connection', key_id: id, n: 1 }] });
  await runDeploy(options({ plan: true }), plan.deps);
  assert.equal(plan.calls.some(call => call.args.includes('execute')), false);
  assert.match(plan.logs.join('\n'), /first check D1 read-only for data encrypted with an earlier key/);
});

test('restoring the old key from the env file: uploaded only when it matches the stored key id', async () => {
  const id = await keyId(OLD_KEY);
  const encrypted = [{ source: 'connection', key_id: id, n: 1 }, { source: 'meta_setup', key_id: id, n: 1 }];
  const restore = harness({ secrets: 'missing', encrypted });
  const report = await runDeploy(options({ settings: settings({ TOKEN_ENCRYPTION_KEY: OLD_KEY }) }), restore.deps);
  assert.equal(report.keyCreated, false);
  assert.deepEqual(restore.secretFiles, [{ json: JSON.stringify({ TOKEN_ENCRYPTION_KEY: OLD_KEY }), removed: true }]);
  assert.deepEqual(restore.privateFiles, {});
  assert.match(restore.logs.join('\n'), /matches the encrypted data in D1/);
  assert.equal((JSON.stringify(restore.calls) + restore.logs.join('\n')).includes(OLD_KEY), false, 'never printed or in args');
  assert.deepEqual(restore.calls.at(-1)!.options.unsetEnv, ['TOKEN_ENCRYPTION_KEY']);

  const wrong = harness({ secrets: 'missing', encrypted });
  await assert.rejects(runDeploy(options({ settings: settings({ TOKEN_ENCRYPTION_KEY: OTHER_KEY }) }), wrong.deps),
    /is not the key that encrypted the data in D1/);
  assert.equal(wrong.secretFiles.length, 0);

  // A Worker that still has its key is never given another one.
  const present = harness({ encrypted });
  await runDeploy(options({ settings: settings({ TOKEN_ENCRYPTION_KEY: OTHER_KEY }) }), present.deps);
  assert.equal(present.secretFiles.length, 0);
  assert.equal(present.calls.some(call => call.args.includes('execute')), false);
  assert.match(present.logs.join('\n'), /from the env file is not uploaded: the Worker already has one/);
});

test('--reset-encrypted-data: asks first, deletes the encrypted data, then generates a new key', async () => {
  const encrypted = [{ source: 'connection', key_id: await keyId(OLD_KEY), n: 3 }];
  const declined = harness({ secrets: 'missing', encrypted, confirm: false });
  await assert.rejects(runDeploy(options({ resetEncryptedData: true }), declined.deps), /Not confirmed: nothing was deleted or deployed/);
  assert.equal(declined.questions.length, 1);
  assert.match(declined.questions[0]!, /Delete 3 Google\/Meta connection\(s\)/);
  assert.equal(declined.calls.some(call => call.args.includes(RESET_ENCRYPTED_DATA_SQL)), false);
  assert.equal(declined.calls.some(call => call.args[2] === 'deploy'), false);

  for (const [extra, confirm] of [[{}, true], [{ yes: true }, false]] as const) {
    const h = harness({ secrets: 'missing', encrypted, confirm });
    const report = await runDeploy(options({ resetEncryptedData: true, ...extra }), h.deps);
    assert.equal(h.questions.length, 'yes' in extra ? 0 : 1);
    const reset = h.calls.find(call => call.args.includes(RESET_ENCRYPTED_DATA_SQL))!;
    assert.deepEqual(reset.args.slice(2, 8), ['d1', 'execute', 'DB', '--remote', '--yes', '-c']);
    assert.equal(reset.options.mutating, true);
    // Checked again after the reset, before the deploy.
    const order = h.calls.map(call => call.args.includes(RESET_ENCRYPTED_DATA_SQL) ? 'reset'
      : call.args.some(arg => arg.includes('instance_meta')) ? 'claim' : call.args.includes('execute') ? 'check' : call.args[2]);
    assert.deepEqual(order.slice(-7), ['check', 'reset', 'check', 'secret', 'claim', 'claim', 'deploy']);
    assert.equal(report.keyCreated, true);
    assert.match(h.logs.join('\n'), /Encrypted data was reset/);
  }
});

test('cross-checkout race: a deploy whose key id lost the D1 claim stops before deploying and names the winner', async () => {
  const winner = await keyId(OTHER_KEY);
  const h = harness({ secrets: 'missing', claimed: winner });
  await assert.rejects(runDeploy(options(), h.deps), (error: unknown) => {
    assert.ok(error instanceof DeployError);
    const text = error.lines.join('\n');
    assert.match(text, new RegExp(`Another deploy already claimed a different TOKEN_ENCRYPTION_KEY[^\\n]*key id ${winner}`));
    assert.match(text, /Use the winning key: it is in the \.openads\/TOKEN_ENCRYPTION_KEY\.openads\.\*\.backup file of the checkout that claimed it/);
    assert.match(text, new RegExp(`Add TOKEN_ENCRYPTION_KEY=<that key> to deploy/\\.env\\.cloudflare and run the deploy again \\(its id must be ${winner}\\)`));
    assert.match(text, new RegExp(`${keyBackupPath('openads', NOW).replaceAll('.', '\\.')}\\) holds a key that was never used: delete it`));
    return true;
  });
  assert.equal(h.calls.some(call => call.args[2] === 'deploy'), false, 'no code deployed');
  assert.equal(h.secretFiles.length, 0, 'no key uploaded');
  assert.equal(h.claimed(), winner, 'the winner is untouched');
  assert.equal((JSON.stringify(h.calls) + h.logs.join('\n')).includes(GENERATED_KEY), false);
  // The operator follows the advice: the winning key from the env file claims nothing new and deploys.
  const retry = harness({ secrets: 'missing', claimed: winner });
  await runDeploy(options({ settings: settings({ TOKEN_ENCRYPTION_KEY: OTHER_KEY }) }), retry.deps);
  assert.deepEqual(retry.secretFiles, [{ json: JSON.stringify({ TOKEN_ENCRYPTION_KEY: OTHER_KEY }), removed: true }]);
  assert.equal(retry.claimed(), winner);
  // A wrong env-file key is refused the same way.
  const wrong = harness({ secrets: 'missing', claimed: winner });
  await assert.rejects(runDeploy(options({ settings: settings({ TOKEN_ENCRYPTION_KEY: OLD_KEY }) }), wrong.deps), /already claimed a different/);
  assert.equal(wrong.secretFiles.length, 0);
  // A Worker that already has its key claims nothing.
  const present = harness({ claimed: winner });
  await runDeploy(options(), present.deps);
  assert.equal(present.calls.some(call => call.args.some(arg => arg.includes('instance_meta'))), false);
  // Unknown claim state fails closed.
  const broken = harness({ secrets: 'missing' });
  const run = broken.deps.run;
  const failing: DeployDeps = { ...broken.deps, run: (command, args, runOptions) => args.includes(KEY_CLAIM_QUERY)
    ? { status: 1, stdout: '', stderr: '✘ [ERROR] fixture' } : run(command, args, runOptions) };
  await assert.rejects(runDeploy(options(), failing), /Could not read the encryption key id back from D1; nothing was deployed/);
  assert.equal(broken.calls.some(call => call.args[2] === 'deploy'), false);
});

test('two deploys from separate checkouts at once: only the first claim uploads a key', async () => {
  // Both saw a Worker without a key; they share one D1 (the claim row) but not a lock.
  const first = harness({ secrets: 'missing' });
  const keyA = GENERATED_KEY;
  await runDeploy(options(), first.deps);
  const keyB = Buffer.alloc(32, 4).toString('base64');
  const second = harness({ secrets: 'missing', claimed: first.claimed()! });
  await assert.rejects(runDeploy(options(), { ...second.deps, randomKey: () => keyB }), /already claimed a different/);
  assert.deepEqual(first.secretFiles.map(file => JSON.parse(file.json).TOKEN_ENCRYPTION_KEY), [keyA]);
  assert.equal(second.secretFiles.length, 0);
  assert.equal(second.calls.some(call => call.args[2] === 'deploy'), false);
});

test('the encrypted-data query and the reset SQL match the real schema', async () => {
  const d1 = createTestD1();
  d1.sqlite.exec(`
    INSERT INTO workspace (id, name, is_default, created_at) VALUES ('w', 'W', 1, 1);
    INSERT INTO membership (workspace_id, email, role, created_at, updated_at) VALUES ('w', 'a@example.org', 'admin', 1, 1);
    INSERT INTO connection (id, workspace_id, provider, provider_subject, refresh_token_ciphertext, token_key_id, status, created_by_email, created_at, updated_at)
      VALUES ('c1', 'w', 'google_ads', 's', 'v1.a.b', 'k1-aaaa', 'active', 'a@example.org', 1, 1),
             ('c2', 'w', 'meta_ads', 's', 'v1.a.b', 'k1-aaaa', 'active', 'a@example.org', 1, 1);
    INSERT INTO connected_account (id, workspace_id, connection_id, customer_id, is_manager, account_status, login_customer_id, eligible, selected, discovered_at)
      VALUES ('a1', 'w', 'c1', '123', 0, 'ENABLED', '123', 1, 1, 1);
    INSERT INTO project (id, workspace_id, name, created_at) VALUES ('p1', 'w', 'Brand', 1);
    INSERT INTO project_account (connected_account_id, workspace_id, project_id, created_at) VALUES ('a1', 'w', 'p1', 1);
    INSERT INTO google_setup (id, project_id, api_enabled_at, client_id, client_secret_ciphertext, client_secret_key_id, client_secret_last4, updated_at)
      VALUES (1, 'my-project', 5, '${'x'.repeat(40)}', 'v1.a.b', 'k1-bbbb', 'abcd', 1);
    INSERT INTO meta_setup (id, app_id, app_secret_ciphertext, app_secret_key_id, app_secret_last4, updated_at)
      VALUES (1, '1234567890', 'v1.a.b', 'k1-aaaa', 'abcd', 1);
    INSERT INTO pending_connection (id, workspace_id, provider, replaces_connection_id, replaces_subject, provider_subject,
        token_ciphertext, token_key_id, discovery, created_by_email, created_at, expires_at)
      VALUES ('p', 'w', 'google_ads', 'c1', 's', 's2', 'v1.a.b', 'k1-cccc', '{}', 'a@example.org', 1, 2);
  `);
  const rows = (sql: string) => d1.sqlite.prepare(sql).all().map(row => ({ ...row }));
  assert.deepEqual(rows(ENCRYPTED_DATA_QUERY), [
    { source: 'connection', key_id: 'k1-aaaa', n: 2 },
    { source: 'google_setup', key_id: 'k1-bbbb', n: 1 },
    { source: 'meta_setup', key_id: 'k1-aaaa', n: 1 },
    { source: 'pending_connection', key_id: 'k1-cccc', n: 1 },
  ]);
  // The key claim: first writer wins, read back by KEY_CLAIM_QUERY; the reset clears it.
  d1.sqlite.exec(keyClaimSql('k1-aaaaaaaaaaaaaaaa', 1));
  d1.sqlite.exec(keyClaimSql('k1-bbbbbbbbbbbbbbbb', 2));
  assert.deepEqual(rows(KEY_CLAIM_QUERY), [{ value: 'k1-aaaaaaaaaaaaaaaa' }]);
  assert.throws(() => keyClaimSql("k1-'; DROP TABLE x; --", 1));
  d1.sqlite.exec(RESET_ENCRYPTED_DATA_SQL);
  assert.deepEqual(rows(KEY_CLAIM_QUERY), []);
  assert.deepEqual(rows(ENCRYPTED_DATA_QUERY), []);
  assert.equal(d1.rows('connected_account').length, 0, 'accounts cascade with their connection');
  assert.equal(d1.rows('project_account').length, 0);
  assert.equal(d1.rows('project').length, 1, 'projects stay');
  assert.equal(d1.rows('membership').length, 1);
  assert.equal(d1.rows('google_setup')[0]!.project_id, 'my-project', 'wizard progress stays');
  assert.equal(d1.rows('google_setup')[0]!.api_enabled_at, 5);
  assert.equal(d1.rows('meta_setup')[0]!.app_id, '1234567890');
});
