import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBinaryCookies } from '../src/core/browsers/safari.js';
import type { BrowserProfile } from '../src/core/types.js';

const profile: BrowserProfile = { browser: 'safari', id: 'safari:default', label: 'Safari', path: '/dev/null' };

/** Builds one cookie record in Apple's binarycookies layout. */
function record(domain: string, name: string, path: string, value: string, flags: number, expiresUnix: number): Buffer {
  const strings = [domain, name, path, value].map((s) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.of(0)]));
  const headerSize = 56;
  const offsets: number[] = [];
  let cursor = headerSize;
  for (const string of strings) {
    offsets.push(cursor);
    cursor += string.length;
  }
  const buf = Buffer.alloc(cursor);
  buf.writeUInt32LE(cursor, 0);
  buf.writeUInt32LE(flags, 8);
  buf.writeUInt32LE(offsets[0], 16);
  buf.writeUInt32LE(offsets[1], 20);
  buf.writeUInt32LE(offsets[2], 24);
  buf.writeUInt32LE(offsets[3], 28);
  buf.writeDoubleLE(expiresUnix - 978_307_200, 40);
  buf.writeDoubleLE(0, 48);
  for (const [index, string] of strings.entries()) string.copy(buf, offsets[index]);
  return buf;
}

function file(records: Buffer[]): Buffer {
  const headerSize = 8 + records.length * 4;
  const offsets: number[] = [];
  let cursor = headerSize;
  for (const rec of records) {
    offsets.push(cursor);
    cursor += rec.length;
  }
  const page = Buffer.alloc(cursor + 4);
  page.writeUInt32BE(0x0000_0100, 0);
  page.writeUInt32LE(records.length, 4);
  for (const [index, offset] of offsets.entries()) page.writeUInt32LE(offset, 8 + index * 4);
  for (const [index, rec] of records.entries()) rec.copy(page, offsets[index]);

  const head = Buffer.alloc(12);
  head.write('cook', 0, 'latin1');
  head.writeUInt32BE(1, 4);
  head.writeUInt32BE(page.length, 8);
  return Buffer.concat([head, page]);
}

test('parses a binarycookies page', () => {
  const expires = 1_800_000_000;
  const cookies = parseBinaryCookies(
    file([
      record('.github.com', 'user_session', '/', 'sess-value', 0x5, expires),
      record('example.com', 'plain', '/app', 'v', 0x0, 0),
    ]),
    profile,
  );

  assert.equal(cookies.length, 2);
  assert.deepEqual(
    { ...cookies[0] },
    {
      name: 'user_session',
      value: 'sess-value',
      domain: '.github.com',
      path: '/',
      expires,
      secure: true,
      httpOnly: true,
      sameSite: 'Unspecified',
      profileId: 'safari:default',
      browser: 'safari',
    },
  );
  assert.equal(cookies[1].secure, false);
  assert.equal(cookies[1].path, '/app');
});

test('rejects a file that is not binarycookies', () => {
  assert.throws(() => parseBinaryCookies(Buffer.from('nope'), profile), /not a binarycookies/);
});
