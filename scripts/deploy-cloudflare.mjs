#!/usr/bin/env node
// One-command Cloudflare self-host deploy of OpenADS.
//
//   cp deploy/.env.cloudflare.example deploy/.env.cloudflare   # then fill it in
//   npm run deploy:cloudflare -- --plan                         # show what would happen
//   npm run deploy:cloudflare                                   # deploy
//
// Flags: --env-file <path> (default deploy/.env.cloudflare), --plan (no changes),
// --offline (with --plan: do not contact Cloudflare), --reset-encrypted-data
// (only when the Worker lost its TOKEN_ENCRYPTION_KEY: delete the data the old key
// encrypted, after a confirmation) and --yes (confirm without a prompt).
// Guide: docs/SELF_HOSTING_CLOUDFLARE.md
// Runs the pinned wrangler with `npx --no-install wrangler` and argument arrays
// (no shell). Secrets never appear in arguments or output.
// Run it as `node -- scripts/deploy-cloudflare.mjs …` (the npm script does): Node
// itself otherwise inspects an `--env-file` argument even after the script path.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  acquireDeployLock, childEnvironment, DEFAULT_ENV_FILE, DeployError, envFileModeWarning, parseEnvFile, runDeploy, validateEnv,
} from './lib/cloudflare-deploy.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
let options;
try {
  ({ values: options } = parseArgs({
    options: {
      'env-file': { type: 'string', default: DEFAULT_ENV_FILE },
      plan: { type: 'boolean', default: false },
      offline: { type: 'boolean', default: false },
      'reset-encrypted-data': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}
if (options.help) {
  console.log('Usage: npm run deploy:cloudflare -- [--plan [--offline]] [--env-file deploy/.env.cloudflare] [--reset-encrypted-data [--yes]]');
  process.exit(0);
}
if (options.offline && !options.plan) {
  console.error('--offline only works with --plan.');
  process.exit(2);
}

const envFile = options['env-file'];
const envPath = join(root, envFile);
if (!existsSync(envFile) && !existsSync(envPath)) {
  console.error(`\n${envFile} not found. Create it first:\n\n  cp deploy/.env.cloudflare.example deploy/.env.cloudflare\n\nthen fill it in (docs/SELF_HOSTING_CLOUDFLARE.md).\n`);
  process.exit(1);
}
const envSource = existsSync(envFile) ? envFile : envPath;
const validation = validateEnv(parseEnvFile(readFileSync(envSource, 'utf8')));
// The env file can hold secrets (META_APP_SECRET, a restored key): it should be 0600.
const modeWarning = envFileModeWarning(statSync(envSource).mode, envFile);
if (modeWarning) validation.warnings.push(modeWarning);
if (!validation.ok) {
  console.error(`\n${envFile} needs fixing:\n`);
  for (const error of validation.errors) console.error(`  ✗ ${error}`);
  for (const warning of validation.warnings) console.error(`  ! ${warning}`);
  console.error('');
  process.exit(1);
}

/**
 * Real command runner: argument arrays only, no shell; stdin closed so wrangler
 * never prompts. `env` (which carries the forced WRANGLER_LOG=log,
 * WRANGLER_LOG_SANITIZE and WRANGLER_WRITE_LOGS) overrides the inherited environment.
 */
function run(command, args, { env = {}, unsetEnv = [], inherit = false }) {
  const childEnv = childEnvironment(process.env, env, unsetEnv);
  const result = spawnSync(command, args, {
    cwd: root, env: childEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    stdio: inherit ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) return { status: 1, stdout: '', stderr: result.error.message };
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const privateDir = path => {
  const dir = dirname(join(root, path));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
};
let releaseLock = null;
const files = {
  readText: path => readFileSync(join(root, path), 'utf8'),
  writeSecretFile: json => {
    const dir = mkdtempSync(join(tmpdir(), 'openads-deploy-'));
    chmodSync(dir, 0o700);
    const path = join(dir, 'secrets.json');
    writeFileSync(path, json, { mode: 0o600 });
    chmodSync(path, 0o600);
    return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  },
  writePrivateText: (path, text) => {
    privateDir(path);
    const target = join(root, path);
    writeFileSync(target, text, { mode: 0o600 });
    chmodSync(target, 0o600); // `mode` only applies when the file is created.
  },
  createPrivateText: (path, text) => {
    privateDir(path);
    writeFileSync(join(root, path), text, { mode: 0o600, flag: 'wx' });
  },
  makePrivate: path => {
    const target = join(root, path);
    let info;
    try {
      info = lstatSync(target);
    } catch {
      return; // Nothing to protect.
    }
    if (info.isSymbolicLink()) return; // Never follow a link out of the project.
    if (info.isDirectory()) {
      chmodSync(target, 0o700);
      for (const entry of readdirSync(target, { withFileTypes: true })) {
        if (entry.isFile()) chmodSync(join(target, entry.name), 0o600);
      }
    } else if (info.isFile()) {
      chmodSync(target, 0o600);
    }
  },
  lock: (path, log) => {
    privateDir(path);
    const release = acquireDeployLock(join(root, path), { log });
    releaseLock = release;
    return () => {
      releaseLock = null;
      release();
    };
  },
};

// Ctrl-C during a deploy: release the lock before exiting.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    releaseLock?.();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

/** A yes/no question on the terminal; false without one (then --yes is needed). */
async function confirm(question) {
  if (!process.stdin.isTTY) {
    console.error(`  ${question}\n  No terminal to confirm on.`);
    return false;
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  prompt.on('SIGINT', () => process.emit('SIGINT', 'SIGINT'));
  try {
    return /^yes$/i.test((await prompt.question(`  ${question} Type "yes" to confirm: `)).trim());
  } finally {
    prompt.close();
  }
}

try {
  await runDeploy({
    settings: validation.settings, warnings: validation.warnings, envFile,
    plan: options.plan, offline: options.offline,
    resetEncryptedData: options['reset-encrypted-data'], yes: options.yes,
  }, {
    run, files, fetch,
    log: line => console.log(line),
    randomKey: () => randomBytes(32).toString('base64'),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    nodeVersion: process.versions.node,
    confirm,
  });
} catch (error) {
  if (error instanceof DeployError) {
    console.error('');
    error.lines.forEach((line, index) => console.error(index === 0 ? `  ✗ ${line}` : `    ${line}`));
    console.error('');
    process.exit(1);
  }
  throw error;
}
