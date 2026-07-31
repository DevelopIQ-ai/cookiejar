import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cookiejar-test-'));
process.env.HOME = sandbox;
process.env.COOKIEJAR_HOME = path.join(sandbox, '.cookiejar');

/** A minimal Chrome cookie store with plaintext values, which Chrome uses when no keyring is available. */
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

fakeChromeProfile();

const { startServer } = await import('../src/server/index.js');
const { Vault } = await import('../src/core/vault.js');
const { createBundle, grantId, issueGrant, revokeGrant } = await import('../src/core/manage.js');

const vault = new Vault();
vault.create('a-good-password');
const bundle = createBundle(vault, {
  name: 'Example read',
  selectors: [{ profileId: 'chrome:Default', domain: 'example.com', names: ['session'] }],
});

const { url, close } = await startServer({ port: 0, vault, autoLockMinutes: 0 });

const agent = (route: string, token: string, init: RequestInit = {}): Promise<Response> =>
  fetch(new URL(route, url), { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });

const tokenFor = (options: { label: string; allowFetch?: boolean; redactValues?: boolean }): string =>
  issueGrant(vault, bundle.id, options).token;

test.after(() => {
  void close().then(() => fs.rmSync(sandbox, { recursive: true, force: true }));
});

test('a token gives an agent exactly the selected cookies', async () => {
  const token = tokenFor({ label: 'test-agent', allowFetch: true });

  const jar = await (await agent('/agent/cookies?format=netscape', token)).text();
  assert.ok(jar.includes('sess-value'));
  assert.ok(!jar.includes('dark'), 'unselected cookies stay out of the bundle');
  assert.ok(!jar.includes('tracker'), 'other sites stay out of the bundle');

  const header = (await (
    await agent(`/agent/cookies?format=header&url=${encodeURIComponent('https://api.example.com/v1')}`, token)
  ).json()) as { cookie: string };
  assert.equal(header.cookie, 'session=sess-value');

  const described = (await (await agent('/agent/bundle', token)).json()) as { hosts: string[]; cookieCount: number };
  assert.deepEqual(described.hosts, ['example.com']);
  assert.equal(described.cookieCount, 1);

  const offHost = await agent('/agent/fetch', token, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://not-in-bundle.test/' }),
  });
  assert.equal(offHost.status, 403);

  assert.equal((await agent('/agent/cookies', 'cjr_wrong')).status, 403);

  const grant = vault.bundle(bundle.id).grants.find((g) => g.label === 'test-agent')!;
  assert.ok(grant.useCount >= 3, 'accesses are counted');

  revokeGrant(vault, bundle.id, grantId(grant));
  assert.equal((await agent('/agent/cookies?format=netscape', token)).status, 403);
});

test('a redacted token can only proxy', async () => {
  const token = tokenFor({ label: 'proxy-only', allowFetch: true, redactValues: true });
  assert.equal((await agent('/agent/cookies?format=netscape', token)).status, 403);
  assert.equal((await agent('/agent/bundle', token)).status, 200);
});

test('a revocation from the terminal cuts a token off at once, and survives', async () => {
  const token = tokenFor({ label: 'leaked', allowFetch: true });
  // The daemon caches the jar and writes it back as tokens are used.
  assert.equal((await agent('/agent/bundle', token)).status, 200);

  const terminal = new Vault();
  terminal.unlock('a-good-password');
  const grant = terminal.bundle(bundle.id).grants.find((g) => g.label === 'leaked')!;
  revokeGrant(terminal, bundle.id, grantId(grant));

  assert.equal((await agent('/agent/bundle', token)).status, 403, 'no daemon restart needed');
  assert.equal((await agent('/agent/bundle', token)).status, 403);

  const onDisk = new Vault();
  onDisk.unlock('a-good-password');
  assert.ok(
    onDisk.bundle(bundle.id).grants.find((g) => g.label === 'leaked')!.revokedAt,
    'the daemon does not write the revocation away',
  );
});

test('locking the jar cuts off agent tokens', async () => {
  const token = tokenFor({ label: 'until-lock', allowFetch: true });
  assert.equal((await agent('/agent/bundle', token)).status, 200);

  vault.lock();
  const denied = await agent('/agent/bundle', token);
  assert.equal(denied.status, 403);
  assert.match(((await denied.json()) as { error: string }).error, /locked/);

  vault.unlock('a-good-password');
  assert.equal((await agent('/agent/bundle', token)).status, 200);
});

test('the daemon manages nothing', async () => {
  const token = tokenFor({ label: 'curious', allowFetch: true });
  for (const route of ['/api/bundles', '/api/state', '/']) {
    assert.equal((await agent(route, token)).status, 404, `${route} is not served`);
  }
  const health = (await (await fetch(new URL('/health', url))).json()) as { ok: boolean; unlocked: boolean };
  assert.deepEqual(health, { ok: true, unlocked: true });
});
