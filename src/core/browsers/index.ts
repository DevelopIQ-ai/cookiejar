import { discoverChromiumProfiles, readChromiumCookies } from './chromium.js';
import { discoverFirefoxProfiles, readFirefoxCookies } from './firefox.js';
import { discoverSafariProfiles, readSafariCookies } from './safari.js';
import type { BrowserProfile, CookieMeta, SourcedCookie } from '../types.js';

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

export function toMeta(cookie: SourcedCookie): CookieMeta {
  const { value, ...rest } = cookie;
  return { ...rest, valueLength: value.length };
}
