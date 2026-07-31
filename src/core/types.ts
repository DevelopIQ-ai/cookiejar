export type BrowserId = 'chrome' | 'chrome-beta' | 'chromium' | 'brave' | 'edge' | 'arc' | 'firefox' | 'safari';

export interface BrowserProfile {
  browser: BrowserId;
  /** Human label, e.g. "Chrome — Profile 1". */
  label: string;
  /** Stable id used in bundle selectors, e.g. "chrome:Default". */
  id: string;
  /** Absolute path of the cookie store on disk. */
  path: string;
}

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Seconds since epoch, 0 for a session cookie. */
  expires: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'None' | 'Lax' | 'Strict' | 'Unspecified';
}

/** A cookie plus where it came from. Values are never written to disk or logs. */
export interface SourcedCookie extends Cookie {
  profileId: string;
  browser: BrowserId;
}

/** Cookie metadata without the secret, safe to print. */
export interface CookieMeta extends Omit<SourcedCookie, 'value'> {
  valueLength: number;
}

/**
 * Selects cookies out of a browser profile. `names` empty means "every cookie
 * on the matching hosts", which keeps a bundle working when a site rotates
 * cookie names.
 */
export interface CookieSelector {
  profileId: string;
  /** Cookie domain, matched with the usual leading-dot subdomain rules. */
  domain: string;
  names: string[];
}

export interface BundleGrant {
  /** sha256 of the token; the token itself is only shown once, at creation. */
  tokenHash: string;
  label: string;
  createdAt: string;
  /** Seconds since epoch, 0 for no expiry. */
  expiresAt: number;
  /** Allows proxying requests through the bundle, not just reading cookies. */
  allowFetch: boolean;
  /** Withholds raw cookie values: the agent may only proxy requests. */
  redactValues: boolean;
  lastUsedAt: string | null;
  useCount: number;
  revokedAt: string | null;
}

export interface Bundle {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  selectors: CookieSelector[];
  grants: BundleGrant[];
}

/** First-run answers from `cookiejar setup`. */
export interface Preferences {
  /** Browsers the user said they use, e.g. ['chrome', 'safari']. */
  browsers: BrowserId[];
  onboardedAt: string | null;
}

export interface VaultData {
  version: 1;
  bundles: Bundle[];
  preferences?: Preferences;
}

export interface AuditEntry {
  at: string;
  event: 'unlock' | 'unlock_failed' | 'bundle_read' | 'bundle_fetch' | 'grant_created' | 'grant_revoked' | 'bundle_saved' | 'bundle_deleted';
  bundleId?: string;
  grantLabel?: string;
  detail?: string;
}
