#!/usr/bin/env node
// Builds a throwaway HOME containing a fake Chrome/Firefox cookie store, so
// cookiejar can be developed and demoed without touching your real browser data.
//
//   node scripts/seed-demo-profile.mjs /tmp/cookiejar-demo
//   HOME=/tmp/cookiejar-demo COOKIEJAR_HOME=/tmp/cookiejar-demo/.cookiejar node dist/cli.js sites
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = process.argv[2] ?? '/tmp/cookiejar-demo';
const chromeDir = path.join(root, '.config', 'google-chrome', 'Default');
const firefoxDir = path.join(root, '.mozilla', 'firefox', 'abcd1234.demo');
fs.mkdirSync(chromeDir, { recursive: true });
fs.mkdirSync(firefoxDir, { recursive: true });

const YEAR = Math.floor(Date.now() / 1000) + 365 * 86_400;
const chromeCookies = [
  ['.github.com', 'user_session', 'demo-github-session', '/', YEAR, 1, 1, 1],
  ['.github.com', '_gh_sess', 'demo-gh-sess', '/', 0, 1, 1, 1],
  ['.github.com', 'dotcom_user', 'demo-user', '/', YEAR, 1, 0, 1],
  ['.linear.app', '__session', 'demo-linear-session', '/', YEAR, 1, 1, 2],
  ['.notion.so', 'token_v2', 'demo-notion-token', '/', YEAR, 1, 1, 1],
  ['.notion.so', 'notion_user_id', 'demo-notion-user', '/', YEAR, 1, 0, 1],
  ['.vercel.com', 'authorization', 'demo-vercel-auth', '/', YEAR, 1, 1, 1],
  ['.figma.com', '__Host-figma.authn', 'demo-figma-authn', '/', YEAR, 1, 1, 2],
  ['.stripe.com', 'sk_session', 'demo-stripe-session', '/', YEAR, 1, 1, 2],
  ['.news.ycombinator.com', 'user', 'demo-hn-user', '/', YEAR, 0, 0, 1],
  ['.united.com', 'SESSION_ID', 'demo-united-session', '/', YEAR, 1, 1, 1],
  ['.delta.com', 'dl_auth_token', 'demo-delta-token', '/', YEAR, 1, 1, 1],
  ['.booking.com', 'bkng_sso_session', 'demo-booking-session', '/', YEAR, 1, 1, 1],
  ['.airbnb.com', '_airbed_session_id', 'demo-airbnb-session', '/', YEAR, 1, 1, 1],
  ['.marriott.com', 'MI_SESSION', 'demo-marriott-session', '/', YEAR, 1, 1, 1],
  ['.amazon.com', 'session-token', 'demo-amazon-session', '/', YEAR, 1, 1, 1],
  ['.doubleclick.net', 'IDE', 'demo-ad-id', '/', YEAR, 0, 0, 0],
];

const chromeDb = new DatabaseSync(path.join(chromeDir, 'Cookies'));
chromeDb.exec(`CREATE TABLE IF NOT EXISTS cookies (
  host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
  expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER)`);
chromeDb.exec('DELETE FROM cookies');
const insertChrome = chromeDb.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
for (const [host, name, value, cookiePath, expires, secure, httpOnly, sameSite] of chromeCookies) {
  const webkitExpiry = expires === 0 ? 0n : (BigInt(expires) + 11_644_473_600n) * 1_000_000n;
  insertChrome.run(host, name, value, new Uint8Array(0), cookiePath, webkitExpiry, secure, httpOnly, sameSite);
}
chromeDb.close();
fs.writeFileSync(
  path.join(root, '.config', 'google-chrome', 'Local State'),
  JSON.stringify({ profile: { info_cache: { Default: { name: 'Personal' } } } }),
);

const firefoxDb = new DatabaseSync(path.join(firefoxDir, 'cookies.sqlite'));
firefoxDb.exec(`CREATE TABLE IF NOT EXISTS moz_cookies (
  host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER, isSecure INTEGER, isHttpOnly INTEGER, sameSite INTEGER)`);
firefoxDb.exec('DELETE FROM moz_cookies');
const insertFirefox = firefoxDb.prepare('INSERT INTO moz_cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
insertFirefox.run('.linear.app', '__session', 'demo-linear-firefox', '/', YEAR, 1, 1, 2);
insertFirefox.run('.reddit.com', 'reddit_session', 'demo-reddit-session', '/', YEAR, 1, 1, 1);
firefoxDb.close();

console.log(`seeded demo browser profiles under ${root}`);
