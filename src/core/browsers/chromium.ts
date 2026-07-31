import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { webkitToUnix, withCookieDb } from './sqlite.js';
import type { BrowserId, BrowserProfile, SourcedCookie } from '../types.js';

interface ChromiumFlavour {
  browser: BrowserId;
  label: string;
  /** Per-platform user-data directory, relative to $HOME. */
  dirs: { darwin?: string; linux?: string };
  /** macOS Keychain service holding the profile encryption password. */
  keychainService: string;
  /** Linux keyring label. */
  linuxKeyringApp: string;
}

const FLAVOURS: ChromiumFlavour[] = [
  {
    browser: 'chrome',
    label: 'Chrome',
    dirs: { darwin: 'Library/Application Support/Google/Chrome', linux: '.config/google-chrome' },
    keychainService: 'Chrome Safe Storage',
    linuxKeyringApp: 'chrome',
  },
  {
    browser: 'chrome-beta',
    label: 'Chrome Beta',
    dirs: { darwin: 'Library/Application Support/Google/Chrome Beta', linux: '.config/google-chrome-beta' },
    keychainService: 'Chrome Safe Storage',
    linuxKeyringApp: 'chrome',
  },
  {
    browser: 'chromium',
    label: 'Chromium',
    dirs: { darwin: 'Library/Application Support/Chromium', linux: '.config/chromium' },
    keychainService: 'Chromium Safe Storage',
    linuxKeyringApp: 'chromium',
  },
  {
    browser: 'brave',
    label: 'Brave',
    dirs: {
      darwin: 'Library/Application Support/BraveSoftware/Brave-Browser',
      linux: '.config/BraveSoftware/Brave-Browser',
    },
    keychainService: 'Brave Safe Storage',
    linuxKeyringApp: 'brave',
  },
  {
    browser: 'edge',
    label: 'Edge',
    dirs: { darwin: 'Library/Application Support/Microsoft Edge', linux: '.config/microsoft-edge' },
    keychainService: 'Microsoft Edge Safe Storage',
    linuxKeyringApp: 'chromium',
  },
  {
    browser: 'arc',
    label: 'Arc',
    dirs: { darwin: 'Library/Application Support/Arc/User Data' },
    keychainService: 'Arc Safe Storage',
    linuxKeyringApp: 'chromium',
  },
];

function userDataDir(flavour: ChromiumFlavour): string | null {
  const rel = process.platform === 'darwin' ? flavour.dirs.darwin : flavour.dirs.linux;
  if (!rel) return null;
  const dir = path.join(os.homedir(), rel);
  return fs.existsSync(dir) ? dir : null;
}

function profileNames(userDir: string): Map<string, string> {
  const names = new Map<string, string>();
  try {
    const state = JSON.parse(fs.readFileSync(path.join(userDir, 'Local State'), 'utf8')) as {
      profile?: { info_cache?: Record<string, { name?: string }> };
    };
    for (const [dir, info] of Object.entries(state.profile?.info_cache ?? {})) {
      if (info.name) names.set(dir, info.name);
    }
  } catch {
    // A missing or half-written Local State just costs us pretty profile names.
  }
  return names;
}

export function discoverChromiumProfiles(): BrowserProfile[] {
  const profiles: BrowserProfile[] = [];
  for (const flavour of FLAVOURS) {
    const userDir = userDataDir(flavour);
    if (!userDir) continue;
    const pretty = profileNames(userDir);
    for (const entry of fs.readdirSync(userDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cookies = [
        path.join(userDir, entry.name, 'Cookies'),
        path.join(userDir, entry.name, 'Network', 'Cookies'),
      ].find((p) => fs.existsSync(p));
      if (!cookies) continue;
      profiles.push({
        browser: flavour.browser,
        id: `${flavour.browser}:${entry.name}`,
        label: `${flavour.label} — ${pretty.get(entry.name) ?? entry.name}`,
        path: cookies,
      });
    }
  }
  return profiles;
}

function keychainPassword(service: string): string | null {
  try {
    return execFileSync('security', ['find-generic-password', '-w', '-s', service], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function linuxKeyringPassword(app: string): string | null {
  for (const args of [
    ['lookup', 'application', app],
    ['lookup', 'application', 'chrome'],
  ]) {
    try {
      const out = execFileSync('secret-tool', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (out) return out.trim();
    } catch {
      // secret-tool missing or the entry is absent; fall through to "peanuts".
    }
  }
  return null;
}

/** Chromium derives its AES key from a password with fixed, published parameters. */
function legacyKey(password: string, iterations: number): Buffer {
  return crypto.pbkdf2Sync(password, 'saltysalt', iterations, 16, 'sha1');
}

export interface Keyring {
  /** Keys to try against `v10`/`v11` AES-128-CBC blobs. */
  cbcKeys: Buffer[];
  /** Key for `v10` AES-256-GCM blobs (Windows). */
  gcmKey: Buffer | null;
}

function keyringFor(flavour: ChromiumFlavour): Keyring {
  if (process.platform === 'darwin') {
    const password = keychainPassword(flavour.keychainService);
    return { cbcKeys: password ? [legacyKey(password, 1003)] : [], gcmKey: null };
  }
  const keys = [legacyKey('peanuts', 1)];
  const fromKeyring = linuxKeyringPassword(flavour.linuxKeyringApp);
  if (fromKeyring) keys.unshift(legacyKey(fromKeyring, 1));
  return { cbcKeys: keys, gcmKey: null };
}

export class UnavailableKeyError extends Error {}

/**
 * Recent Chrome versions bind a cookie to its host by prefixing the plaintext
 * with sha256(host_key), so strip that prefix when it is really there.
 */
function stripDomainPrefix(plaintext: Buffer, host: string | undefined): Buffer {
  if (plaintext.length <= 32) return plaintext;
  const prefix = plaintext.subarray(0, 32);
  for (const candidate of host ? [host, host.replace(/^\./, '')] : []) {
    if (crypto.createHash('sha256').update(candidate).digest().equals(prefix)) return plaintext.subarray(32);
  }
  // Unknown hash: fall back to "a value would not contain control bytes".
  return prefix.some((byte) => byte < 0x20) ? plaintext.subarray(32) : plaintext;
}

function decryptCbc(blob: Buffer, key: Buffer, host: string | undefined): string {
  const iv = Buffer.alloc(16, 0x20);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  const out = Buffer.concat([decipher.update(blob), decipher.final()]);
  return stripDomainPrefix(out, host).toString('utf8');
}

function decryptGcm(blob: Buffer, key: Buffer, host: string | undefined): string {
  const nonce = blob.subarray(0, 12);
  const tag = blob.subarray(blob.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(blob.subarray(12, blob.length - 16)), decipher.final()]);
  return stripDomainPrefix(out, host).toString('utf8');
}

export function decryptChromiumValue(encrypted: Buffer, plain: string, keyring: Keyring, host?: string): string {
  if (plain) return plain;
  if (encrypted.length === 0) return '';
  const version = encrypted.subarray(0, 3).toString('latin1');
  const body = encrypted.subarray(3);
  if (version === 'v20') {
    // App-bound encryption (Windows only); the key lives behind an elevation service.
    throw new UnavailableKeyError('app-bound encrypted cookie (v20) is not supported');
  }
  if (version === 'v10' || version === 'v11') {
    if (keyring.gcmKey) return decryptGcm(body, keyring.gcmKey, host);
    let lastError: unknown;
    for (const key of keyring.cbcKeys) {
      try {
        return decryptCbc(body, key, host);
      } catch (error) {
        lastError = error;
      }
    }
    if (keyring.cbcKeys.length === 0) throw new UnavailableKeyError('no decryption key available for this browser');
    throw lastError instanceof Error ? lastError : new Error('failed to decrypt cookie');
  }
  return encrypted.toString('utf8');
}

const sameSiteFromChromium = (value: number): SourcedCookie['sameSite'] =>
  value === 0 ? 'None' : value === 1 ? 'Lax' : value === 2 ? 'Strict' : 'Unspecified';

export function readChromiumCookies(profile: BrowserProfile): SourcedCookie[] {
  const flavour = FLAVOURS.find((f) => f.browser === profile.browser);
  if (!flavour) throw new Error(`unknown chromium flavour: ${profile.browser}`);
  const keyring = keyringFor(flavour);

  return withCookieDb(profile.path, (db) => {
    // Some profile directories contain unrelated SQLite files or freshly-created
    // cookie stores that haven't had the cookies table created yet.
    const table = db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cookies'`,
    ).get();
    if (!table) return [];

    const statement = db.prepare(
      `SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite
       FROM cookies ORDER BY host_key, name`,
    );
    // Chromium expiry timestamps overflow a JS number, so read integers as BigInt.
    statement.setReadBigInts(true);
    const rows = statement.all() as Array<Record<string, unknown>>;

    const cookies: SourcedCookie[] = [];
    for (const row of rows) {
      const encrypted = row.encrypted_value instanceof Uint8Array ? Buffer.from(row.encrypted_value) : Buffer.alloc(0);
      let value: string;
      try {
        value = decryptChromiumValue(encrypted, String(row.value ?? ''), keyring, String(row.host_key ?? ''));
      } catch {
        continue; // Skip cookies we cannot read rather than failing the whole profile.
      }
      cookies.push({
        name: String(row.name),
        value,
        domain: String(row.host_key),
        path: String(row.path ?? '/'),
        expires: webkitToUnix(row.expires_utc as bigint),
        secure: Boolean(row.is_secure),
        httpOnly: Boolean(row.is_httponly),
        sameSite: sameSiteFromChromium(Number(row.samesite ?? -1)),
        profileId: profile.id,
        browser: profile.browser,
      });
    }
    return cookies;
  });
}
