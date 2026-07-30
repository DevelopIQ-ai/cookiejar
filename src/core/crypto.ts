import crypto from 'node:crypto';

const SCRYPT_PARAMS = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 } as const;
const KEY_BYTES = 32;
// Unicode form used before hashing, so the same typed passphrase always derives the same key.
const NORMALIZATION: Parameters<string['normalize']>[0] = 'NFKC';

export interface SealedBox {
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase.normalize(NORMALIZATION), salt, KEY_BYTES, SCRYPT_PARAMS);
}

export function seal(plaintext: string, key: Buffer, salt: Buffer): SealedBox {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    kdf: 'scrypt',
    N: SCRYPT_PARAMS.N,
    r: SCRYPT_PARAMS.r,
    p: SCRYPT_PARAMS.p,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function open(box: SealedBox, passphrase: string): { plaintext: string; key: Buffer; salt: Buffer } {
  const salt = Buffer.from(box.salt, 'base64');
  const key = crypto.scryptSync(passphrase.normalize(NORMALIZATION), salt, KEY_BYTES, {
    N: box.N,
    r: box.r,
    p: box.p,
    maxmem: SCRYPT_PARAMS.maxmem,
  });
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(box.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  return { plaintext, key, salt };
}

export function newSalt(): Buffer {
  return crypto.randomBytes(16);
}

export function newToken(prefix = 'cjr'): string {
  return `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function tokenMatches(token: string, hash: string): boolean {
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
