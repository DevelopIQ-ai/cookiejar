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

test('nothing needs the vault edited by hand: rename, list every token, revoke the lot, start over', () => {
  run('setup', '--browsers', 'chrome'); // the scripted answer, no prompt
  assert.match(run('status'), /browsers {3}chrome$/m);

  const bundleId = /created (\S+)/.exec(run('bundle', 'new', 'first name'))![1];
  run('bundle', 'add', bundleId, 'example.com', '--names', 'session');
  assert.match(run('bundle', 'edit', bundleId, '--name', 'better name', '--description', 'for devin'), /better name/);
  assert.match(run('bundles'), /better name/);
  assert.throws(() => run('bundle', 'edit', bundleId), /nothing to change/);

  run('token', 'new', bundleId, '--label', 'one');
  run('token', 'new', bundleId, '--label', 'two');
  const tokens = run('tokens');
  assert.match(tokens, /one/);
  assert.match(tokens, /two/);
  assert.doesNotMatch(tokens, /cjr_/, 'tokens are listed by id, never by value');

  assert.match(run('token', 'revoke', '--all'), /revoked 2 tokens/);
  assert.match(run('tokens', '--live'), /no live tokens/);
  assert.match(run('activity', '--bundle', bundleId), /grant_revoked/);
  assert.doesNotMatch(run('activity', '--bundle', 'no-such-bundle'), /grant_revoked/);

  run('reset', '--force');
  assert.equal(fs.existsSync(path.join(sandbox, '.cookiejar', 'vault.json')), false);
  assert.match(run('bundles'), /No bundles yet/, 'a fresh jar comes back empty');
});

test('suggest groups what you are signed into, and only writes when you accept', () => {
  const chrome = path.join(sandbox, '.config', 'google-chrome', 'Default');
  const db = new DatabaseSync(path.join(chrome, 'Cookies'));
  const insert = db.prepare(`INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const expiry = (BigInt(Math.floor(Date.now() / 1000) + 86_400) + 11_644_473_600n) * 1_000_000n;
  insert.run('.united.com', 'SESSION_ID', 'united-secret', new Uint8Array(0), '/', expiry, 1, 1, 1);
  insert.run('.github.com', 'user_session', 'github-secret', new Uint8Array(0), '/', expiry, 1, 1, 1);
  db.close();

  const listed = run('suggest');
  assert.match(listed, /travel/);
  assert.match(listed, /united\.com/);
  assert.doesNotMatch(listed, /united-secret/, 'suggestions print names, never values');
  assert.match(run('bundles'), /No bundles yet/, 'listing suggestions writes nothing');

  assert.match(run('suggest', 'travel', '--yes'), /created travel/);
  const bundleId = /^(travel\S*)/m.exec(run('bundles'))![1];
  assert.match(run('bundle', bundleId), /SESSION_ID/);
  assert.throws(() => run('suggest', 'nonsense'), /no suggestion called nonsense/);

  run('bundle', 'rm', bundleId, '--force');
});

test('skill drops a SKILL.md an agent can pick up, and will not clobber it', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cookiejar-skill-'));
  const target = path.join(project, '.agents', 'skills', 'cookiejar', 'SKILL.md');
  run('skill', '--dir', path.dirname(target));

  const body = fs.readFileSync(target, 'utf8');
  assert.match(body, /^---\nname: cookiejar\n/, 'it is a real skill file');
  assert.match(body, /COOKIEJAR_TOKEN/);
  assert.match(body, /agent\/fetch/);

  assert.throws(() => run('skill', '--dir', path.dirname(target)), /already exists/);
  fs.writeFileSync(target, 'mine');
  assert.throws(() => run('skill', '--dir', path.dirname(target)), /already exists/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'mine', 'an edited skill is left alone');
  run('skill', '--dir', path.dirname(target), '--force');
  assert.notEqual(fs.readFileSync(target, 'utf8'), 'mine');

  assert.match(run('skill', '--print'), /Maintaining a bundle/);
  fs.rmSync(project, { recursive: true, force: true });
});
