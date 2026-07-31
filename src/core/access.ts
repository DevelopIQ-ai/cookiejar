import { audit } from './audit.js';
import { tokenMatches } from './crypto.js';
import { VaultLockedError, type Vault } from './vault.js';
import type { Bundle, BundleGrant } from './types.js';

export class AccessDeniedError extends Error {}

const LOCKED = 'cookiejar is locked; start it with `cookiejar serve`';

export interface Grantee {
  bundle: Bundle;
  grant: BundleGrant;
}

/**
 * Resolves a bearer token to the bundle it unlocks. Requires the vault to be
 * unlocked: agent tokens are useless while the jar is closed.
 */
export function authorize(vault: Vault, token: string | undefined): Grantee {
  if (!token) throw new AccessDeniedError('missing bundle token');
  const now = Date.now() / 1000;
  // read() can lock the jar itself, if the master password changed under us.
  let bundles;
  try {
    bundles = vault.read().bundles;
  } catch (error) {
    if (error instanceof VaultLockedError) throw new AccessDeniedError(LOCKED);
    throw error;
  }
  for (const bundle of bundles) {
    for (const grant of bundle.grants) {
      if (!tokenMatches(token, grant.tokenHash)) continue;
      if (grant.revokedAt) throw new AccessDeniedError('this token was revoked');
      if (grant.expiresAt && grant.expiresAt < now) throw new AccessDeniedError('this token has expired');
      return { bundle, grant };
    }
  }
  throw new AccessDeniedError('unknown bundle token');
}

export function noteUse(vault: Vault, grantee: Grantee, event: 'bundle_read' | 'bundle_fetch', detail?: string): void {
  vault.write((data) => {
    const bundle = data.bundles.find((b) => b.id === grantee.bundle.id);
    const grant = bundle?.grants.find((g) => g.tokenHash === grantee.grant.tokenHash);
    if (!grant) return;
    grant.lastUsedAt = new Date().toISOString();
    grant.useCount += 1;
  });
  audit({ event, bundleId: grantee.bundle.id, grantLabel: grantee.grant.label, detail });
}
