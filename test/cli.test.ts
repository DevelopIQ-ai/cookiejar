import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cookiejar-cli-'));
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');

function fakeChromeProfile(): void {
  const dir = path.join(sandbox, '.config', 'google-chrome', 'Default');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'Cookies'));
  db.exec(`CREATE TABLE cookies (
    host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
    expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER)`);
  const insert = db.prepare(`INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.run('.example.com', 'session', 'sess-value', new Uint8Array(0), '/', 0, 1, 1, 1);
  insert.run('.example.com', 'theme', 'dark', new Uint8Array(0), '/', 0, 0, 0, 1);
  insert.run('.other.com', 'tracker', 'nope', new Uint8Array(0), '/', 0, 0, 0, 1);
  db.close();
}

function fakeFirefoxProfile(): void {
  const dir = path.join(sandbox, '.mozilla', 'firefox', 'abcd.demo');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'cookies.sqlite'));
  db.exec(`CREATE TABLE moz_cookies (
    host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER,
    isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER)`);
  db.prepare(`INSERT INTO moz_cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    '.example.com',
    'ff-only',
    'ff-value',
    '/',
    0,
    1,
    1,
    1,
  );
  db.close();
}

/** Runs the CLI the way a user would, with the password supplied out of band. */
const run = (...args: string[]): string => runWith(undefined, ...args);

const runWith = (input: string | undefined, ...args: string[]): string =>
  execFileSync(process.execPath, ['--import', 'tsx', cli, ...args], {
    encoding: 'utf8',
    input,
    env: {
      ...process.env,
      HOME: sandbox,
      COOKIEJAR_HOME: path.join(sandbox, '.cookiejar'),
      COOKIEJAR_PASSWORD: 'a-good-password',
      // Somewhere nothing is listening: these runs never expect a daemon.
      COOKIEJAR_PORT: '4188',
    },
  });

fakeChromeProfile();
fakeFirefoxProfile();

test('the terminal can do the whole flow without the app', () => {
  // Answering "1" picks Chrome only, and that answer has to hold afterwards.
  assert.match(runWith('1\n', 'setup'), /Which browsers do you use\?/);
  assert.match(run('status'), /browsers {3}chrome/);

  assert.match(run('sites'), /example\.com/);
  const cookies = run('cookies', 'example.com');
  assert.match(cookies, /session/);
  assert.doesNotMatch(cookies, /sess-value/, 'cookie values never reach the terminal');
  assert.doesNotMatch(cookies, /ff-only/, 'browsers left out of setup are not read');
  assert.match(run('cookies', 'example.com', '--all'), /ff-only/, '--all ignores the setup answer');

  const created = run('bundle', 'new', 'example agent');
  const bundleId = /created (\S+)/.exec(created)![1];
  run('bundle', 'add', bundleId, 'example.com', '--names', 'session');

  const shown = run('bundle', bundleId);
  assert.match(shown, /session/);
  assert.doesNotMatch(shown, /theme/, 'only the picked cookie is in the bundle');

  const token = /^(cjr_\S+)/m.exec(run('token', 'new', bundleId, '--label', 'devin', '--proxy-only'))![1];
  assert.ok(token.startsWith('cjr_'));
  assert.doesNotMatch(run('bundle', bundleId), new RegExp(token), 'the token is shown once, never stored');

  // Export reads the vault directly: no daemon, no token.
  const exported = run('export', '--bundle', bundleId, '--format', 'storage-state');
  const jar = JSON.parse(exported) as { cookies: Array<{ name: string; value: string }> };
  assert.deepEqual(
    jar.cookies.map((c) => c.name),
    ['session'],
  );
  assert.equal(jar.cookies[0].value, 'sess-value');
  assert.equal(run('header', '--bundle', bundleId, '--url-target', 'https://example.com/x').trim(), 'session=sess-value');

  assert.match(run('share', bundleId), /@puffle\/cookiejar/);
  assert.match(run('share', bundleId, '--tunnel', 'https://t.example'), /https:\/\/t\.example\/agent\/fetch/);

  const grantId = /^ {2}([0-9a-f]{12})/m.exec(run('bundle', bundleId))![1];
  run('token', 'revoke', bundleId, grantId);
  assert.match(run('bundle', bundleId), /revoked/);

  run('bundle', 'rm', bundleId, '--force');
  assert.match(run('bundles'), /No bundles yet/);
});
