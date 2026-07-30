import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveKey, hashToken, newSalt, newToken, open, seal, tokenMatches } from '../src/core/crypto.js';

test('seals and opens with the same password', () => {
  const salt = newSalt();
  const box = seal('{"hello":"jar"}', deriveKey('correct horse battery', salt), salt);
  assert.equal(open(box, 'correct horse battery').plaintext, '{"hello":"jar"}');
});

test('refuses the wrong password', () => {
  const salt = newSalt();
  const box = seal('secret', deriveKey('right', salt), salt);
  assert.throws(() => open(box, 'wrong'));
});

test('ciphertext carries no plaintext', () => {
  const salt = newSalt();
  const box = seal('session=abc123', deriveKey('pw12345678', salt), salt);
  assert.ok(!JSON.stringify(box).includes('abc123'));
});

test('tokens compare by hash', () => {
  const token = newToken();
  assert.ok(tokenMatches(token, hashToken(token)));
  assert.ok(!tokenMatches(newToken(), hashToken(token)));
  assert.ok(token.startsWith('cjr_'));
});
