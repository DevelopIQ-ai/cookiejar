import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cookiejar-ui-'));
process.env.HOME = sandbox;
process.env.COOKIEJAR_HOME = path.join(sandbox, '.cookiejar');

function seed(): void {
  const dir = path.join(sandbox, '.config', 'google-chrome', 'Default');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'Cookies'));
  db.exec(`CREATE TABLE cookies (
    host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
    expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER)`);
  const insert = db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const expiry = (BigInt(Math.floor(Date.now() / 1000) + 365 * 86_400) + 11_644_473_600n) * 1_000_000n;
  insert.run('.github.com', 'user_session', 'github-secret-value', new Uint8Array(0), '/', expiry, 1, 1, 1);
  insert.run('.united.com', 'SESSION_ID', 'united-secret-value', new Uint8Array(0), '/', expiry, 1, 1, 1);
  db.close();
}

seed();

const { startServer } = await import('../src/server/index.js');
const { Vault } = await import('../src/core/vault.js');

const vault = new Vault();
vault.create('a-good-password');

const SESSION_KEY = 'test-session-key';
const { url, close } = await startServer({ port: 0, vault, autoLockMinutes: 0, ui: { sessionKey: SESSION_KEY } });

test.after(() => {
  void close().then(() => fs.rmSync(sandbox, { recursive: true, force: true }));
});

// The browser trades the terminal's key for this cookie once, exactly as a real page does.
const entry = await fetch(new URL(`/?k=${SESSION_KEY}`, url), { redirect: 'manual' });
const sessionCookie = (entry.headers.get('set-cookie') ?? '').split(';')[0];

const ui = (route: string, init: RequestInit = {}): Promise<Response> =>
  fetch(new URL(route, url), {
    ...init,
    headers: { cookie: sessionCookie, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

test('the page is only served to a browser that saw the terminal', async () => {
  assert.equal(entry.status, 302);
  assert.ok(sessionCookie.startsWith('cjr_ui='));
  assert.equal((await fetch(new URL('/', url))).status, 403, 'a bare visit is refused');
  assert.equal((await fetch(new URL('/?k=guess', url))).status, 403);
  assert.equal((await fetch(new URL('/api/bundles', url))).status, 401, 'the API needs the session too');
});

test('the UI can browse cookies but never receives a value', async () => {
  const sites = (await (await ui('/api/sites')).json()) as { sites: { site: string }[] };
  assert.deepEqual(sites.sites.map((site) => site.site).sort(), ['github.com', 'united.com']);

  const body = await (await ui('/api/cookies?site=github.com')).text();
  assert.ok(body.includes('user_session'), 'names are shown');
  assert.ok(!body.includes('github-secret-value'), 'values are not');

  const suggestions = await (await ui('/api/suggestions')).text();
  assert.ok(suggestions.includes('travel') && !suggestions.includes('united-secret-value'));
});

test('accepting a suggestion in the UI creates the same bundle the CLI would', async () => {
  const accepted = (await (await ui('/api/suggestions/accept', {
    method: 'POST',
    body: JSON.stringify({ categoryId: 'travel' }),
  })).json()) as { bundle: { id: string; selectors: { domain: string; names: string[] }[] } };
  assert.deepEqual(accepted.bundle.selectors, [{ profileId: 'chrome:Default', domain: 'united.com', names: ['SESSION_ID'] }]);
  assert.equal(vault.bundle(accepted.bundle.id).name, 'travel');

  const detail = await (await ui(`/api/bundles/${accepted.bundle.id}`)).text();
  assert.ok(detail.includes('SESSION_ID') && !detail.includes('united-secret-value'));
});

test('a token issued in the UI is shown once and never listed again', async () => {
  const { bundle } = (await (await ui('/api/bundles', {
    method: 'POST',
    body: JSON.stringify({ name: 'work' }),
  })).json()) as { bundle: { id: string } };

  const issued = (await (await ui(`/api/bundles/${bundle.id}/grants`, {
    method: 'POST',
    body: JSON.stringify({ label: 'devin', expiresInDays: 1, redactValues: true }),
  })).json()) as { token: string; grant: { id: string } };
  assert.ok(issued.token.startsWith('cjr_'));

  const listed = await (await ui(`/api/bundles/${bundle.id}`)).text();
  assert.ok(!listed.includes(issued.token), 'the token itself is never returned twice');

  await ui(`/api/bundles/${bundle.id}/grants/${issued.grant.id}`, { method: 'DELETE' });
  const revoked = (await (await ui(`/api/bundles/${bundle.id}`)).json()) as {
    bundle: { grants: { revokedAt?: string }[] };
  };
  assert.ok(revoked.bundle.grants[0].revokedAt, 'revoking from the UI sticks');
});

test('every token the jar handed out is listed in one place', async () => {
  const bundles = (await (await ui('/api/bundles')).json()) as { bundles: { id: string }[] };
  const id = bundles.bundles[0].id;
  await ui(`/api/bundles/${id}/grants`, { method: 'POST', body: JSON.stringify({ label: 'a cloud agent', redactValues: true }) });

  const { tokens } = (await (await ui('/api/tokens')).json()) as {
    tokens: { id: string; bundleName: string; label: string; state: string; proxyOnly: boolean }[];
  };
  const listed = tokens.find((token) => token.label === 'a cloud agent')!;
  assert.equal(listed.state, 'live');
  assert.equal(listed.proxyOnly, true);
  assert.ok(listed.bundleName, 'the bundle is named, so the list reads without cross-referencing');
  assert.ok(!JSON.stringify(tokens).includes('cjr_'), 'no token value is ever listed');

  await ui(`/api/bundles/${id}/grants/${listed.id}`, { method: 'DELETE' });
  const after = (await (await ui('/api/tokens')).json()) as { tokens: { id: string; state: string }[] };
  assert.equal(after.tokens.find((token) => token.id === listed.id)!.state, 'revoked');
});

test('another page on this machine cannot drive the UI API', async () => {
  const response = await ui('/api/bundles', {
    method: 'POST',
    headers: { origin: 'http://evil.example' },
    body: JSON.stringify({ name: 'stolen' }),
  });
  assert.equal(response.status, 403);
  assert.ok(!vault.read().bundles.some((bundle) => bundle.name === 'stolen'));
});

test('the audit log the UI shows carries no values or tokens', async () => {
  const entries = await (await ui('/api/activity')).text();
  assert.ok(entries.includes('bundle_saved'));
  assert.ok(!entries.includes('secret-value') && !entries.includes('cjr_'));
});

// Last: locking from the UI drops its own session as well as every agent.
test('locking the jar from the UI ends the session', async () => {
  assert.equal((await ui('/api/lock', { method: 'POST' })).status, 200);
  assert.equal(vault.unlocked, false);
  assert.equal((await ui('/api/state')).status, 401);
});
