import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { decryptChromiumValue, UnavailableKeyError, type Keyring } from '../src/core/browsers/chromium.js';

const key = crypto.pbkdf2Sync('peanuts', 'saltysalt', 1, 16, 'sha1');
const keyring: Keyring = { cbcKeys: [key], gcmKey: null };

function encrypt(value: Buffer, version = 'v10'): Buffer {
  const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from(version, 'latin1'), cipher.update(value), cipher.final()]);
}

test('reads a plaintext value when the browser stored one', () => {
  assert.equal(decryptChromiumValue(Buffer.alloc(0), 'plain', keyring), 'plain');
});

test('decrypts a v10 cookie', () => {
  assert.equal(decryptChromiumValue(encrypt(Buffer.from('session-value')), '', keyring, '.example.com'), 'session-value');
});

test('drops the domain hash prefix newer Chrome adds', () => {
  const hash = crypto.createHash('sha256').update('.example.com').digest();
  const blob = encrypt(Buffer.concat([hash, Buffer.from('bound-value')]));
  assert.equal(decryptChromiumValue(blob, '', keyring, '.example.com'), 'bound-value');
});

test('keeps a long value that merely looks like a prefixed one', () => {
  const value = 'a'.repeat(64);
  assert.equal(decryptChromiumValue(encrypt(Buffer.from(value)), '', keyring, '.example.com'), value);
});

test('reports app-bound and keyless cookies instead of guessing', () => {
  assert.throws(() => decryptChromiumValue(Buffer.from('v20abc'), '', keyring), UnavailableKeyError);
  assert.throws(
    () => decryptChromiumValue(encrypt(Buffer.from('x')), '', { cbcKeys: [], gcmKey: null }),
    UnavailableKeyError,
  );
});
