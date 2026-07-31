import { discoverChromiumProfiles, readChromiumCookies } from './chromium.js';
import { discoverFirefoxProfiles, readFirefoxCookies } from './firefox.js';
import { discoverSafariProfiles, readSafariCookies, safariAccess } from './safari.js';
import type { BrowserId, BrowserProfile, CookieMeta, SourcedCookie } from '../types.js';

export { safariAccess, type SafariAccess } from './safari.js';

export function discoverProfiles(): BrowserProfile[] {
  return [...discoverChromiumProfiles(), ...discoverFirefoxProfiles(), ...discoverSafariProfiles()];
}

export function findProfile(profileId: string): BrowserProfile {
  const profile = discoverProfiles().find((p) => p.id === profileId);
  if (!profile) throw new Error(`no such browser profile: ${profileId}`);
  return profile;
}

export function readCookies(profile: BrowserProfile): SourcedCookie[] {
  if (profile.browser === 'firefox') return readFirefoxCookies(profile);
  if (profile.browser === 'safari') return readSafariCookies(profile);
  return readChromiumCookies(profile);
}

export interface ProfileReadResult {
  profile: BrowserProfile;
  cookies: SourcedCookie[];
  error?: string;
}

/** Reads every discovered profile, reporting per-profile failures instead of throwing. */
export function readAllProfiles(profileIds?: string[]): ProfileReadResult[] {
  return discoverProfiles()
    .filter((profile) => !profileIds || profileIds.includes(profile.id))
    .map((profile) => {
      try {
        return { profile, cookies: readCookies(profile) };
      } catch (error) {
        return { profile, cookies: [], error: error instanceof Error ? error.message : String(error) };
      }
    });
}

export interface ProfileHealth {
  /** Profiles that read cleanly and hold at least one cookie. */
  usable: ProfileReadResult[];
  /** Profiles that could not be read: locked keychain, missing disk access. */
  blocked: Array<{ profile: BrowserProfile; error: string }>;
  /** Profiles that read cleanly but hold nothing worth showing. */
  empty: BrowserProfile[];
}

/** Splits a read into the three states worth reporting. */
export function profileHealth(profileIds?: string[]): ProfileHealth {
  const health: ProfileHealth = { usable: [], blocked: [], empty: [] };
  for (const read of readAllProfiles(profileIds)) {
    if (read.error) health.blocked.push({ profile: read.profile, error: read.error });
    else if (read.cookies.length === 0) health.empty.push(read.profile);
    else health.usable.push(read);
  }
  return health;
}

/** Browser families present on this machine, for the first-run questions. */
export function installedBrowsers(): BrowserId[] {
  const browsers = new Set(discoverProfiles().map((profile) => profile.browser));
  if (safariAccess().state !== 'absent') browsers.add('safari');
  return [...browsers];
}

export function toMeta(cookie: SourcedCookie): CookieMeta {
  const { value, ...rest } = cookie;
  return { ...rest, valueLength: value.length };
}
