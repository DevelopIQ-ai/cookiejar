import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserProfile, SourcedCookie } from '../types.js';

const MAC_EPOCH_OFFSET = 978_307_200; // 2001-01-01 → 1970-01-01

export class FullDiskAccessError extends Error {
  constructor(file: string) {
    super(
      `cannot read ${file}. macOS protects Safari's cookies: grant Full Disk Access to the terminal (or app) running cookiejar in System Settings → Privacy & Security → Full Disk Access.`,
    );
  }
}

function safariCookieFile(): string | null {
  if (process.platform !== 'darwin') return null;
  const home = os.homedir();
  const candidates = [
    path.join(home, 'Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies'),
    path.join(home, 'Library/Cookies/Cookies.binarycookies'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

export interface SafariAccess {
  /** `absent` on non-macOS or when Safari has never stored a cookie. */
  state: 'ok' | 'blocked' | 'absent';
  path: string | null;
}

/**
 * macOS keeps Safari's cookies inside a TCC-protected container, so a process
 * without Full Disk Access can see the file but not open it.
 */
export function safariAccess(): SafariAccess {
  const file = safariCookieFile();
  if (!file) {
    if (process.platform !== 'darwin') return { state: 'absent', path: null };
    const container = path.join(os.homedir(), 'Library/Containers/com.apple.Safari');
    return { state: fs.existsSync(container) ? 'blocked' : 'absent', path: null };
  }
  try {
    fs.accessSync(file, fs.constants.R_OK);
    // Readability is not enough: TCC denies the actual open, not the check.
    fs.closeSync(fs.openSync(file, 'r'));
    return { state: 'ok', path: file };
  } catch {
    return { state: 'blocked', path: file };
  }
}

export function discoverSafariProfiles(): BrowserProfile[] {
  const file = safariCookieFile();
  if (!file) return [];
  return [{ browser: 'safari', id: 'safari:default', label: 'Safari', path: file }];
}

/** Reads Apple's undocumented-but-stable `Cookies.binarycookies` container. */
export function parseBinaryCookies(buf: Buffer, profile: BrowserProfile): SourcedCookie[] {
  if (buf.subarray(0, 4).toString('latin1') !== 'cook') throw new Error('not a binarycookies file');
  const pageCount = buf.readUInt32BE(4);
  const pageSizes: number[] = [];
  for (let i = 0; i < pageCount; i++) pageSizes.push(buf.readUInt32BE(8 + i * 4));

  const cookies: SourcedCookie[] = [];
  let cursor = 8 + pageCount * 4;
  for (const size of pageSizes) {
    const page = buf.subarray(cursor, cursor + size);
    cursor += size;
    const cookieCount = page.readUInt32LE(4);
    for (let i = 0; i < cookieCount; i++) {
      const offset = page.readUInt32LE(8 + i * 4);
      const record = page.subarray(offset);
      const flags = record.readUInt32LE(8);
      const readString = (at: number): string => {
        const end = record.indexOf(0, at);
        return record.subarray(at, end === -1 ? undefined : end).toString('utf8');
      };
      const domain = readString(record.readUInt32LE(16));
      const name = readString(record.readUInt32LE(20));
      const cookiePath = readString(record.readUInt32LE(24));
      const value = readString(record.readUInt32LE(28));
      const expires = Math.max(0, Math.floor(record.readDoubleLE(40) + MAC_EPOCH_OFFSET));
      cookies.push({
        name,
        value,
        domain,
        path: cookiePath || '/',
        expires,
        secure: (flags & 0x1) !== 0,
        httpOnly: (flags & 0x4) !== 0,
        sameSite: 'Unspecified',
        profileId: profile.id,
        browser: 'safari',
      });
    }
  }
  return cookies;
}

export function readSafariCookies(profile: BrowserProfile): SourcedCookie[] {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(profile.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EACCES') {
      throw new FullDiskAccessError(profile.path);
    }
    throw error;
  }
  return parseBinaryCookies(buf, profile);
}
