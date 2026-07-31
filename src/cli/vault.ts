import { audit } from '../core/audit.js';
import { vaultPath } from '../core/paths.js';
import { BadPasswordError, Vault } from '../core/vault.js';
import { askSecret } from './prompt.js';

export class CliError extends Error {}

/**
 * Opens the vault for a one-shot terminal command. The password comes from
 * COOKIEJAR_PASSWORD (handy for scripts) or an unechoed prompt.
 */
export async function openVault(): Promise<Vault> {
  const vault = new Vault();
  if (!vault.exists) {
    const password = await newPassword('No jar yet. Pick a master password (8+ characters): ');
    vault.create(password);
    audit({ event: 'unlock', detail: 'vault created' });
    console.log(`created ${vaultPath()}`);
    return vault;
  }

  const fromEnv = process.env.COOKIEJAR_PASSWORD;
  for (let attempt = 0; attempt < 3; attempt++) {
    const password = fromEnv ?? (await askSecret('Master password: '));
    try {
      vault.unlock(password);
      audit({ event: 'unlock' });
      return vault;
    } catch (error) {
      audit({ event: 'unlock_failed' });
      if (fromEnv || !(error instanceof BadPasswordError)) throw error;
      console.error('wrong master password');
    }
  }
  throw new CliError('could not unlock the jar');
}

export async function newPassword(question: string): Promise<string> {
  const fromEnv = process.env.COOKIEJAR_PASSWORD;
  if (fromEnv) return fromEnv;
  const password = await askSecret(question);
  if (password.length < 8) throw new CliError('master password must be at least 8 characters');
  const again = await askSecret('Again: ');
  if (password !== again) throw new CliError('passwords did not match');
  return password;
}

/**
 * The app keeps the decrypted vault in memory, so a terminal write can be
 * clobbered by the next save from an open tab. Warn rather than refuse.
 */
export async function warnIfDaemonRunning(url: string): Promise<void> {
  try {
    const response = await fetch(new URL('/api/state', url), { signal: AbortSignal.timeout(300) });
    const state = (await response.json()) as { holdsVault?: boolean };
    if (!state.holdsVault) return;
    console.error(`warning: the app at ${url} is open and unlocked; close or lock it so it cannot overwrite this edit.`);
  } catch {
    // No daemon (or it is locked) is the normal case for terminal use.
  }
}
