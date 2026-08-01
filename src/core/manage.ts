import { audit } from './audit.js';
import { hashToken, newToken } from './crypto.js';
import { newBundleId, type Vault } from './vault.js';
import type { Bundle, BundleGrant, BrowserId, CookieSelector, Preferences } from './types.js';

/**
 * Bundle and grant edits, shared by the daemon's HTTP API and the CLI so the
 * terminal and the agent daemon can never drift apart.
 */

export interface BundleInput {
  name: string;
  description?: string;
  selectors?: CookieSelector[];
}

export function createBundle(vault: Vault, input: BundleInput): Bundle {
  const name = input.name.trim();
  if (!name) throw new Error('bundle name is required');
  const now = new Date().toISOString();
  const bundle: Bundle = {
    id: newBundleId(name),
    name,
    description: input.description?.trim() ?? '',
    createdAt: now,
    updatedAt: now,
    selectors: input.selectors ?? [],
    grants: [],
  };
  vault.write((data) => data.bundles.push(bundle));
  audit({ event: 'bundle_saved', bundleId: bundle.id, detail: 'created' });
  return bundle;
}

export function updateBundle(vault: Vault, bundleId: string, patch: Partial<BundleInput>): Bundle {
  vault.bundle(bundleId);
  vault.write((data) => {
    const target = data.bundles.find((b) => b.id === bundleId)!;
    if (patch.name?.trim()) target.name = patch.name.trim();
    if (patch.description !== undefined) target.description = patch.description.trim();
    if (patch.selectors) target.selectors = patch.selectors;
    target.updatedAt = new Date().toISOString();
  });
  audit({ event: 'bundle_saved', bundleId });
  return vault.bundle(bundleId);
}

export function deleteBundle(vault: Vault, bundleId: string): void {
  vault.bundle(bundleId);
  vault.write((data) => {
    data.bundles = data.bundles.filter((b) => b.id !== bundleId);
  });
  audit({ event: 'bundle_deleted', bundleId });
}

/** Adds a site to a bundle, merging with any selector it already has for it. */
export function addSelector(vault: Vault, bundleId: string, selector: CookieSelector): Bundle {
  const bundle = vault.bundle(bundleId);
  const merged = bundle.selectors.map((s) => ({ ...s, names: [...s.names] }));
  const existing = merged.find((s) => s.profileId === selector.profileId && s.domain === selector.domain);
  if (!existing) merged.push(selector);
  else if (selector.names.length === 0) existing.names = [];
  else for (const name of selector.names) if (!existing.names.includes(name)) existing.names.push(name);
  return updateBundle(vault, bundleId, { selectors: merged });
}

export function removeSelector(vault: Vault, bundleId: string, domain: string, profileId?: string): Bundle {
  const bundle = vault.bundle(bundleId);
  const kept = bundle.selectors.filter((s) => s.domain !== domain || (profileId ? s.profileId !== profileId : false));
  if (kept.length === bundle.selectors.length) throw new Error(`bundle ${bundleId} has no selector for ${domain}`);
  return updateBundle(vault, bundleId, { selectors: kept });
}

export interface GrantInput {
  label?: string;
  expiresInDays?: number;
  allowFetch?: boolean;
  redactValues?: boolean;
}

/** The raw token is returned once here and never stored: only its hash is. */
export function issueGrant(vault: Vault, bundleId: string, input: GrantInput): { token: string; grant: BundleGrant } {
  vault.bundle(bundleId);
  const token = newToken();
  const grant: BundleGrant = {
    tokenHash: hashToken(token),
    label: input.label?.trim() || 'agent',
    createdAt: new Date().toISOString(),
    expiresAt: input.expiresInDays ? Math.floor(Date.now() / 1000 + input.expiresInDays * 86_400) : 0,
    allowFetch: input.allowFetch ?? true,
    redactValues: input.redactValues ?? false,
    lastUsedAt: null,
    useCount: 0,
    revokedAt: null,
  };
  vault.write((data) => data.bundles.find((b) => b.id === bundleId)!.grants.push(grant));
  audit({ event: 'grant_created', bundleId, grantLabel: grant.label });
  return { token, grant };
}

export const grantId = (grant: BundleGrant): string => grant.tokenHash.slice(0, 12);

/** Live means usable right now: neither revoked nor past its expiry. */
export const isLive = (grant: BundleGrant): boolean =>
  !grant.revokedAt && !(grant.expiresAt && grant.expiresAt * 1000 < Date.now());

export function revokeGrant(vault: Vault, bundleId: string, id: string): BundleGrant {
  const grant = vault.bundle(bundleId).grants.find((g) => g.tokenHash.startsWith(id));
  if (!grant) throw new Error(`no such token: ${id}`);
  vault.write((data) => {
    const target = data.bundles.find((b) => b.id === bundleId)!.grants.find((g) => g.tokenHash === grant.tokenHash)!;
    target.revokedAt = new Date().toISOString();
  });
  audit({ event: 'grant_revoked', bundleId, grantLabel: grant.label });
  return grant;
}

export function setPreferences(vault: Vault, browsers: BrowserId[], done: boolean): Preferences {
  const preferences: Preferences = { browsers, onboardedAt: done ? new Date().toISOString() : null };
  vault.write((data) => {
    data.preferences = preferences;
  });
  return preferences;
}
