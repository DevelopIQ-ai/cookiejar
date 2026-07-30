import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withCookieDb } from './sqlite.js';
import type { BrowserProfile, SourcedCookie } from '../types.js';

function profileRoots(): string[] {
  const home = os.homedir();
  return process.platform === 'darwin'
    ? [path.join(home, 'Library/Application Support/Firefox/Profiles')]
    : [path.join(home, '.mozilla/firefox'), path.join(home, 'snap/firefox/common/.mozilla/firefox')];
}

export function discoverFirefoxProfiles(): BrowserProfile[] {
  const profiles: BrowserProfile[] = [];
  for (const root of profileRoots()) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const cookies = path.join(root, entry.name, 'cookies.sqlite');
      if (!fs.existsSync(cookies)) continue;
      const name = entry.name.replace(/^[a-z0-9]+\./i, '');
      profiles.push({
        browser: 'firefox',
        id: `firefox:${entry.name}`,
        label: `Firefox — ${name || entry.name}`,
        path: cookies,
      });
    }
  }
  return profiles;
}

const sameSiteFromFirefox = (value: number): SourcedCookie['sameSite'] =>
  value === 0 ? 'None' : value === 1 ? 'Lax' : value === 2 ? 'Strict' : 'Unspecified';

export function readFirefoxCookies(profile: BrowserProfile): SourcedCookie[] {
  return withCookieDb(profile.path, (db) => {
    const rows = db
      .prepare(`SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies ORDER BY host, name`)
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      name: String(row.name),
      value: String(row.value ?? ''),
      domain: String(row.host),
      path: String(row.path ?? '/'),
      expires: Number(row.expiry ?? 0),
      secure: Boolean(row.isSecure),
      httpOnly: Boolean(row.isHttpOnly),
      sameSite: sameSiteFromFirefox(Number(row.sameSite ?? -1)),
      profileId: profile.id,
      browser: profile.browser,
    }));
  });
}
