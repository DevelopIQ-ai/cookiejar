import { audit } from '../core/audit.js';
import { vaultPath } from '../core/paths.js';
import { BadPasswordError, Vault } from '../core/vault.js';
import { askSecret } from './prompt.js';

export class CliError extends Error {}

/** COOKIEJAR_PASSWORD lets scripts run without a prompt; interactive use has none. */
const scriptedSecret = (): string | undefined => process.env.COOKIEJAR_PASSWORD;

/**
 * Opens the vault for a terminal command, unechoed prompt and all. Creates the
 * jar on first use so `cookiejar setup` is the only onboarding step.
 */
export async function openVault(): Promise<Vault> {
  const vault = new Vault();
  if (!vault.exists) {
    vault.create(await newPassword('No jar yet. Pick a master password (8+ characters): '));
    audit({ event: 'unlock', detail: 'vault created' });
    console.log(`created ${vaultPath()}`);
    return vault;
  }

  const scripted = scriptedSecret();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      vault.unlock(scripted ?? (await askSecret('Master password: ')));
      audit({ event: 'unlock' });
      return vault;
    } catch (error) {
      audit({ event: 'unlock_failed' });
      if (scripted || !(error instanceof BadPasswordError)) throw error;
      console.error('wrong master password');
    }
  }
  throw new CliError('could not unlock the jar');
}

export async function newPassword(question: string): Promise<string> {
  const scripted = scriptedSecret();
  if (scripted) return scripted;
  const chosen = await askSecret(question);
  if (chosen.length < 8) throw new CliError('master password must be at least 8 characters');
  if (chosen !== (await askSecret('Again: '))) throw new CliError('passwords did not match');
  return chosen;
}

/** True when a `cookiejar serve` daemon is up and holding the jar open. */
export async function daemonHoldsVault(url: string): Promise<boolean> {
  try {
    const response = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(300) });
    return ((await response.json()) as { unlocked?: boolean }).unlocked === true;
  } catch {
    // No daemon is the normal case: only agents need one.
    return false;
  }
}

/**
 * The daemon keeps the decrypted jar in memory and rewrites it as tokens get
 * used, so it can clobber an edit made here. Warn rather than refuse.
 */
export async function warnIfDaemonRunning(url: string): Promise<void> {
  if (!(await daemonHoldsVault(url))) return;
  console.error(`warning: cookiejar serve is running at ${url}; restart it so this edit takes effect.`);
}
