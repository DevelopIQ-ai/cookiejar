import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cookieAppliesToHost,
  cookieAppliesToPath,
  cookieHeaderFor,
  domainCovers,
  isExpired,
  toNetscape,
  toStorageState,
} from '../src/core/bundles.js';
import type { Cookie } from '../src/core/types.js';

const cookie = (over: Partial<Cookie> = {}): Cookie => ({
  name: 'session',
  value: 'abc',
  domain: '.example.com',
  path: '/',
  expires: 0,
  secure: true,
  httpOnly: true,
  sameSite: 'Lax',
  ...over,
});

test('selector domains cover subdomains but not siblings', () => {
  assert.ok(domainCovers('example.com', '.example.com'));
  assert.ok(domainCovers('example.com', 'api.example.com'));
  assert.ok(!domainCovers('example.com', 'notexample.com'));
  assert.ok(!domainCovers('api.example.com', 'example.com'));
});

test('host matching follows the leading dot', () => {
  assert.ok(cookieAppliesToHost(cookie(), 'api.example.com'));
  assert.ok(cookieAppliesToHost(cookie({ domain: 'example.com' }), 'example.com'));
  assert.ok(!cookieAppliesToHost(cookie({ domain: 'example.com' }), 'api.example.com'));
});

test('path matching respects segment boundaries', () => {
  assert.ok(cookieAppliesToPath(cookie({ path: '/app' }), '/app/settings'));
  assert.ok(cookieAppliesToPath(cookie({ path: '/app' }), '/app'));
  assert.ok(!cookieAppliesToPath(cookie({ path: '/app' }), '/apple'));
});

test('expiry uses seconds since epoch and treats 0 as session', () => {
  assert.ok(!isExpired(cookie({ expires: 0 })));
  assert.ok(isExpired(cookie({ expires: 1 })));
  assert.ok(!isExpired(cookie({ expires: Date.now() / 1000 + 60 })));
});

test('cookie header skips other hosts, wrong paths, expired and insecure mismatches', () => {
  const cookies = [
    cookie({ name: 'a', value: '1' }),
    cookie({ name: 'b', value: '2', domain: 'other.com' }),
    cookie({ name: 'c', value: '3', path: '/admin' }),
    cookie({ name: 'd', value: '4', expires: 1 }),
    cookie({ name: 'e', value: '5', secure: true }),
  ];
  assert.equal(cookieHeaderFor(cookies, 'https://api.example.com/x'), 'a=1; e=5');
  assert.equal(cookieHeaderFor(cookies, 'http://api.example.com/x'), '');
  // Longer paths come first, matching what browsers send.
  assert.equal(cookieHeaderFor(cookies, 'https://api.example.com/admin/y'), 'c=3; a=1; e=5');
});

test('cookie header sends one value per name when two browsers disagree', () => {
  const header = cookieHeaderFor(
    [cookie({ name: 'session', value: 'from-chrome' }), cookie({ name: 'session', value: 'from-firefox' })],
    'https://example.com/',
  );
  assert.equal(header, 'session=from-chrome');
});

test('netscape jar marks httpOnly and subdomain flags', () => {
  const jar = toNetscape([cookie({ name: 'session', value: 'v' }), cookie({ name: 'plain', domain: 'example.com', httpOnly: false })]);
  assert.match(jar, /^# Netscape HTTP Cookie File/);
  assert.ok(jar.includes('#HttpOnly_.example.com\tTRUE\t/\tTRUE\t0\tsession\tv'));
  assert.ok(jar.includes('example.com\tFALSE\t/\tTRUE\t0\tplain\tabc'));
});

test('storage state is playwright shaped', () => {
  const parsed = JSON.parse(toStorageState([cookie({ sameSite: 'Unspecified' })])) as {
    cookies: Array<{ expires: number; sameSite: string }>;
    origins: unknown[];
  };
  assert.equal(parsed.cookies[0].expires, -1);
  assert.equal(parsed.cookies[0].sameSite, 'Lax');
  assert.deepEqual(parsed.origins, []);
});
