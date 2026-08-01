import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cookiejar-suggest-'));
process.env.HOME = sandbox;
process.env.COOKIEJAR_HOME = path.join(sandbox, '.cookiejar');

const YEAR = Math.floor(Date.now() / 1000) + 365 * 86_400;

/** Two browsers, so a suggestion has to keep profiles apart. */
function seed(): void {
  const chrome = path.join(sandbox, '.config', 'google-chrome', 'Default');
  fs.mkdirSync(chrome, { recursive: true });
  const db = new DatabaseSync(path.join(chrome, 'Cookies'));
  db.exec(`CREATE TABLE cookies (
    host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
    expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER)`);
  const insert = db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const expiry = (BigInt(YEAR) + 11_644_473_600n) * 1_000_000n;
  const add = (host: string, name: string, value: string) =>
    insert.run(host, name, value, new Uint8Array(0), '/', expiry, 1, 1, 1);
  add('.united.com', 'SESSION_ID', 'united-secret-value');
  add('.united.com', '_ga', 'analytics-only');
  add('.booking.com', 'bkng_sso_session', 'booking-secret-value');
  add('.github.com', 'user_session', 'github-secret-value');
  add('.doubleclick.net', 'IDE', 'ad-secret-value');
  add('.somerandomsite.test', 'session', 'unknown-secret-value');
  db.close();
  fs.writeFileSync(
    path.join(sandbox, '.config', 'google-chrome', 'Local State'),
    JSON.stringify({ profile: { info_cache: { Default: { name: 'Personal' } } } }),
  );

  const firefox = path.join(sandbox, '.mozilla', 'firefox', 'abcd1234.work');
  fs.mkdirSync(firefox, { recursive: true });
  const ff = new DatabaseSync(path.join(firefox, 'cookies.sqlite'));
  ff.exec(`CREATE TABLE moz_cookies (
    host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER)`);
  ff.prepare('INSERT INTO moz_cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    '.github.com', 'user_session', 'firefox-secret-value', '/', YEAR, 1, 1, 1,
  );
  ff.close();
}

seed();

const { suggestBundles, findSuggestion, looksLikeAuth } = await import('../src/core/suggest.js');
const { createBundle } = await import('../src/core/manage.js');
const { resolveBundle } = await import('../src/core/bundles.js');
const { Vault } = await import('../src/core/vault.js');

test.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

test('sites are grouped into the category people actually think in', () => {
  const suggestions = suggestBundles();
  const travel = findSuggestion(suggestions, 'travel');
  assert.ok(travel, 'flights and hotels belong together');
  assert.deepEqual(travel.sites.map((site) => site.site).sort(), ['booking.com', 'united.com']);
  assert.ok(findSuggestion(suggestions, 'work'), 'github is work');
  assert.equal(findSuggestion(suggestions, 'finance'), undefined, 'empty categories are not offered');
});

test('a suggestion carries session cookies only, and never a value', () => {
  const travel = findSuggestion(suggestBundles(), 'travel')!;
  const united = travel.sites.find((site) => site.site === 'united.com')!;
  assert.deepEqual(united.authNames, ['SESSION_ID'], 'analytics cookies stay out of the selector');
  assert.equal(united.cookieCount, 2, 'the site total still reflects what is there');
  assert.ok(!JSON.stringify(suggestBundles()).includes('secret-value'), 'no cookie value is ever in a suggestion');
});

test('sites with nothing that looks like a login are skipped', () => {
  const sites = suggestBundles().flatMap((suggestion) => suggestion.sites.map((site) => site.site));
  assert.ok(!sites.includes('doubleclick.net'), 'an analytics-only domain is not a bundle');
  assert.ok(!sites.includes('somerandomsite.test'), 'an uncategorised site is not guessed at');
  assert.ok(looksLikeAuth('__session') && !looksLikeAuth('_ga'));
});

test('the same site in two browsers stays two selectors', () => {
  const work = findSuggestion(suggestBundles(), 'work')!;
  const github = work.selectors.filter((selector) => selector.domain === 'github.com');
  assert.equal(github.length, 2, 'chrome and firefox logins are not merged');
  assert.deepEqual(github.map((selector) => selector.profileId).sort(), ['chrome:Default', 'firefox:abcd1234.work']);
});

test('accepting a suggestion makes a bundle that resolves to real cookies', () => {
  const vault = new Vault();
  vault.create('a-good-password');
  const travel = findSuggestion(suggestBundles(), 'travel')!;
  const bundle = createBundle(vault, { name: travel.name, description: travel.description, selectors: travel.selectors });

  const resolved = resolveBundle(bundle);
  assert.deepEqual(resolved.cookies.map((cookie) => cookie.name).sort(), ['SESSION_ID', 'bkng_sso_session']);
  assert.ok(!JSON.stringify(vault.read()).includes('united-secret-value'), 'the vault stores selectors, not values');
});

test('only the browsers picked in setup are suggested from', () => {
  const chromeOnly = findSuggestion(suggestBundles(['chrome']), 'work')!;
  assert.deepEqual(chromeOnly.selectors.map((selector) => selector.profileId), ['chrome:Default']);
});
