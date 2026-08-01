import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/**
 * The handover, end to end: a jar that never asks for a password, a bundle
 * lent with one command, and a second machine that only has the connect
 * string. The tunnel is skipped with --local; everything else is real.
 */

const lender = fs.mkdtempSync(path.join(os.tmpdir(), 'cookiejar-lender-'));
const borrower = fs.mkdtempSync(path.join(os.tmpdir(), 'cookiejar-borrower-'));
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');
const PORT = 4288;

function seed(): void {
  const dir = path.join(lender, '.config', 'google-chrome', 'Default');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'Cookies'));
  db.exec(`CREATE TABLE cookies (
    host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
    expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER)`);
  db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    '.localhost',
    'session',
    'the-secret-value',
    new Uint8Array(0),
    '/',
    0,
    0,
    1,
    1,
  );
  db.close();
}

seed();

// The in-process half of these tests reads the same fake browser and jar.
process.env.HOME = lender;
process.env.COOKIEJAR_HOME = path.join(lender, '.cookiejar');
process.env.COOKIEJAR_KEYRING = 'file';

/** No COOKIEJAR_PASSWORD anywhere: the key comes from the (file) keyring. */
const env = (home: string): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: home,
  COOKIEJAR_HOME: path.join(home, '.cookiejar'),
  COOKIEJAR_KEYRING: 'file',
  COOKIEJAR_PORT: String(PORT),
  COOKIEJAR_PASSWORD: undefined,
  COOKIEJAR_TOKEN: undefined,
  COOKIEJAR_URL: undefined,
});

const run = (home: string, ...args: string[]): string =>
  execFileSync(process.execPath, ['--import', 'tsx', cli, ...args], { encoding: 'utf8', env: env(home) });

test.after(() => {
  fs.rmSync(lender, { recursive: true, force: true });
  fs.rmSync(borrower, { recursive: true, force: true });
});

test('the jar opens with no password, and a password is opt-in', () => {
  const created = run(lender, 'status');
  assert.match(created, /key {8}/);
  assert.ok(fs.existsSync(path.join(lender, '.cookiejar', 'key')), 'the key is kept outside the vault file');

  const vaultFile = fs.readFileSync(path.join(lender, '.cookiejar', 'vault.json'), 'utf8');
  assert.match(vaultFile, /"protection": "keyring"/);
  assert.doesNotMatch(vaultFile, /localhost/, 'the vault is still encrypted');

  // A second command opens it again without a prompt, which is the whole point.
  assert.match(run(lender, 'bundles'), /No bundles yet/);
});

test('a connect string is checked, not trusted', async () => {
  const { decodeConnection, encodeConnection } = await import('../src/core/connect.js');
  const connection = { url: 'https://x.trycloudflare.com', token: 'cjr_abc', bundle: 'work-1', expiresAt: 42 };
  assert.deepEqual(decodeConnection(encodeConnection(connection)), connection);

  const encoded = encodeConnection(connection);
  assert.throws(() => decodeConnection('http://x.trycloudflare.com'), /connect string/);
  assert.throws(() => decodeConnection(encoded.slice(0, -8)), /connect string/, 'a truncated paste is rejected');
  assert.throws(
    () => decodeConnection(`cjr1.${Buffer.from('{"u":"nonsense","t":"cjr_a"}').toString('base64url')}`),
    /connect string/,
  );
});

test('a bundle can be lent with one command, and taken back with one keystroke', async () => {
  run(lender, 'setup', '--browsers', 'chrome');
  const bundleId = /created (\S+)/.exec(run(lender, 'bundle', 'new', 'demo'))![1];
  run(lender, 'bundle', 'add', bundleId, 'localhost', '--names', 'session');

  // The site the borrowed session will be used against. It has to be its own
  // process: this one blocks on execFileSync while the request is in flight.
  const upstream = spawn(process.execPath, [
    '-e',
    `require('http').createServer((q, s) => {
       s.writeHead(200, { 'set-cookie': 'tracker=should-be-stripped' });
       s.end('cookie: ' + (q.headers.cookie || 'none'));
     }).listen(0, function () { console.log(this.address().port); });`,
  ]);
  const upstreamPort = await new Promise<string>((resolve) =>
    upstream.stdout.once('data', (chunk: Buffer) => resolve(chunk.toString().trim())),
  );

  const lending = spawn(process.execPath, ['--import', 'tsx', cli, 'lend', bundleId, '--local', '--minutes', '5'], {
    env: env(lender),
  });
  let out = '';
  const connectString = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`lend never printed a string:\n${out}`)), 30_000);
    lending.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const found = /\b(cjr1\.[A-Za-z0-9_-]+)/.exec(out);
      if (!found) return;
      clearTimeout(timer);
      resolve(found[1]);
    });
    lending.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
  });

  assert.doesNotMatch(out, /the-secret-value/, 'lending never prints a cookie value');
  assert.match(out, /proxy only/);

  // The borrower has a different home: only the connect string crosses over.
  const connected = run(borrower, 'connect', connectString);
  assert.match(connected, /connected to "demo"/);
  assert.match(connected, /hidden \(proxy only\)/);
  assert.doesNotMatch(connected, /the-secret-value/);

  const fetched = run(borrower, 'fetch', `http://localhost:${upstreamPort}/`);
  assert.match(fetched, /cookie: session=the-secret-value/, 'the upstream site sees the login');

  // Proxy only means the borrower cannot pull the values out for itself.
  assert.throws(() => run(borrower, 'export', '--format', 'netscape'), /cannot read cookie values/);

  lending.kill('SIGINT');
  await new Promise<void>((done) => lending.on('exit', () => done()));

  assert.match(run(lender, 'tokens'), /revoked/, 'ctrl-c revoked the loan');
  assert.throws(() => run(borrower, 'fetch', `http://localhost:${upstreamPort}/`), /revoked|ECONNREFUSED|fetch failed/);

  run(borrower, 'disconnect');
  upstream.kill();
});

test('an agent on this machine can maintain a bundle without seeing a value', async () => {
  const { Vault } = await import('../src/core/vault.js');
  const { runManageTool } = await import('../src/mcp/manage.js');

  const vault = new Vault();
  vault.unlockFromKeyring();

  const sites = (await runManageTool(vault, 'list_sites', {})) as { site: string }[];
  assert.ok(sites.some((entry) => entry.site === 'localhost'));

  const cookies = JSON.stringify(await runManageTool(vault, 'list_cookies', { site: 'localhost' }));
  assert.match(cookies, /session/);
  assert.doesNotMatch(cookies, /the-secret-value/, 'the agent sees names, never values');

  const made = (await runManageTool(vault, 'create_bundle', { name: 'agent made' })) as { id: string };
  await runManageTool(vault, 'add_site', { bundleId: made.id, site: 'localhost' });
  const shown = (await runManageTool(vault, 'show_bundle', { bundleId: made.id })) as {
    resolves: { name: string }[];
  };
  assert.deepEqual(shown.resolves.map((cookie) => cookie.name), ['session']);
  assert.doesNotMatch(JSON.stringify(shown), /the-secret-value/);

  const issued = (await runManageTool(vault, 'issue_token', { bundleId: made.id, minutes: 5 })) as {
    token: string;
    id: string;
    proxyOnly: boolean;
  };
  assert.ok(issued.token.startsWith('cjr_'));
  assert.equal(issued.proxyOnly, true, 'proxy only unless asked otherwise');

  const revoked = (await runManageTool(vault, 'revoke_token', { bundleId: made.id })) as { revoked: string[] };
  assert.deepEqual(revoked.revoked, [issued.id]);

  await runManageTool(vault, 'remove_site', { bundleId: made.id, site: 'localhost' });
  const emptied = (await runManageTool(vault, 'show_bundle', { bundleId: made.id })) as { selectors: unknown[] };
  assert.equal(emptied.selectors.length, 0);

  // A forgotten argument says which one, rather than looking up the empty id.
  await assert.rejects(() => runManageTool(vault, 'show_bundle', {}), /bundleId is required/);
  await assert.rejects(() => runManageTool(vault, 'add_site', { bundleId: made.id }), /site is required/);
});

test('an expired token is not counted as live', async () => {
  const { Vault } = await import('../src/core/vault.js');
  const { createBundle, issueGrant } = await import('../src/core/manage.js');

  const vault = new Vault();
  vault.unlockFromKeyring();
  const bundle = createBundle(vault, { name: 'counting' });
  issueGrant(vault, bundle.id, { label: 'yesterday', expiresInDays: -1 });

  assert.match(run(lender, 'tokens'), /expired/);
  const listed = run(lender, 'bundles')
    .split('\n')
    .find((line) => line.includes(bundle.id))!;
  assert.match(listed, /0 live tokens/, 'the summary agrees with the token list');
});
