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
const { url, close } = await startServer({ port: 0, autoLockMinutes: 0 });
let session = '';

const ui = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const response = await fetch(new URL(path, url), {
    ...init,
    headers: { 'content-type': 'application/json', cookie: session, ...(init.headers ?? {}) },
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) session = setCookie.split(';')[0];
  return response;
};
const agent = (path: string, token: string, init: RequestInit = {}): Promise<Response> =>
  fetch(new URL(path, url), { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });

test.after(() => {
  void close().then(() => fs.rmSync(sandbox, { recursive: true, force: true }));
});

test('locked jar exposes nothing', async () => {
  const state = (await (await ui('/api/state')).json()) as { vaultExists: boolean; unlocked: boolean };
  assert.equal(state.vaultExists, false);
  assert.equal(state.unlocked, false);
  assert.equal((await ui('/api/bundles')).status, 401);
});

test('creating the vault unlocks the session and finds browser cookies', async () => {
  assert.equal((await ui('/api/vault/create', { method: 'POST', body: JSON.stringify({ password: 'short' }) })).status, 400);
  const created = await ui('/api/vault/create', { method: 'POST', body: JSON.stringify({ password: 'a-good-password' }) });
  assert.equal(created.status, 200);

  const profiles = (await (await ui('/api/profiles')).json()) as { profiles: Array<{ id: string; cookieCount: number }> };
  const chrome = profiles.profiles.find((p) => p.id === 'chrome:Default');
  assert.equal(chrome?.cookieCount, 3);

  const sites = (await (await ui('/api/sites')).json()) as { sites: Array<{ site: string; cookieCount: number }> };
  assert.equal(sites.sites.find((s) => s.site === 'example.com')?.cookieCount, 2);

  const cookies = (await (await ui('/api/cookies?site=example.com')).json()) as { cookies: Array<Record<string, unknown>> };
  assert.equal(cookies.cookies.length, 2);
  assert.ok(!JSON.stringify(cookies.cookies).includes('sess-value'), 'the UI listing must not leak values');
});

test('a bundle plus token gives an agent exactly the selected cookies', async () => {
  const { bundle } = (await (
    await ui('/api/bundles', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Example read',
        selectors: [{ profileId: 'chrome:Default', domain: 'example.com', names: ['session'] }],
      }),
    })
  ).json()) as { bundle: { id: string } };

  const preview = (await (await ui(`/api/bundles/${bundle.id}/preview`)).json()) as { cookies: Array<{ name: string }> };
  assert.deepEqual(
    preview.cookies.map((c) => c.name),
    ['session'],
  );

  const { token } = (await (
    await ui(`/api/bundles/${bundle.id}/grants`, {
      method: 'POST',
      body: JSON.stringify({ label: 'test-agent', allowFetch: true, redactValues: false }),
    })
  ).json()) as { token: string };

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

  const grants = (await (await ui('/api/bundles')).json()) as { bundles: Array<{ grants: Array<{ id: string; useCount: number }> }> };
  assert.ok(grants.bundles[0].grants[0].useCount >= 3, 'accesses are counted');

  await ui(`/api/bundles/${bundle.id}/grants/${grants.bundles[0].grants[0].id}`, { method: 'DELETE' });
  assert.equal((await agent('/agent/cookies?format=netscape', token)).status, 403);
});

test('a redacted token can only proxy', async () => {
  const bundles = (await (await ui('/api/bundles')).json()) as { bundles: Array<{ id: string }> };
  const { token } = (await (
    await ui(`/api/bundles/${bundles.bundles[0].id}/grants`, {
      method: 'POST',
      body: JSON.stringify({ label: 'proxy-only', allowFetch: true, redactValues: true }),
    })
  ).json()) as { token: string };
  assert.equal((await agent('/agent/cookies?format=netscape', token)).status, 403);
  assert.equal((await agent('/agent/bundle', token)).status, 200);
});

test('locking the jar cuts off agent tokens', async () => {
  const bundles = (await (await ui('/api/bundles')).json()) as { bundles: Array<{ id: string }> };
  const { token } = (await (
    await ui(`/api/bundles/${bundles.bundles[0].id}/grants`, {
      method: 'POST',
      body: JSON.stringify({ label: 'until-lock', allowFetch: true, redactValues: false }),
    })
  ).json()) as { token: string };
  assert.equal((await agent('/agent/bundle', token)).status, 200);

  await ui('/api/vault/lock', { method: 'POST' });
  const denied = await agent('/agent/bundle', token);
  assert.equal(denied.status, 403);
  assert.match(((await denied.json()) as { error: string }).error, /locked/);

  assert.equal((await ui('/api/vault/unlock', { method: 'POST', body: JSON.stringify({ password: 'nope' }) })).status, 401);
  assert.equal(
    (await ui('/api/vault/unlock', { method: 'POST', body: JSON.stringify({ password: 'a-good-password' }) })).status,
    200,
  );
  assert.equal((await agent('/agent/bundle', token)).status, 200);
});

test('cross-origin writes are refused', async () => {
  const response = await ui('/api/vault/lock', { method: 'POST', headers: { origin: 'https://evil.test' } });
  assert.equal(response.status, 403);
});
