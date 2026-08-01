import { audit } from '../core/audit.js';
import { vaultPath } from '../core/paths.js';
import { keyring } from '../core/keyring.js';
import { BadPasswordError, MissingKeyError, Vault } from '../core/vault.js';
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
  const scripted = scriptedSecret();

  if (!vault.exists) {
    // No password by default: the key goes to the OS keyring and stays there.
    if (scripted) {
      vault.create(scripted);
    } else {
      vault.createManaged();
      console.log(`created ${vaultPath()} — the key is in ${keyring().where}, so there is nothing to remember`);
      audit({ event: 'unlock', detail: 'vault created' });
      return vault;
    }
    audit({ event: 'unlock', detail: 'vault created' });
    console.log(`created ${vaultPath()}`);
    return vault;
  }

  if (vault.protection === 'keyring') {
    try {
      vault.unlockFromKeyring();
      audit({ event: 'unlock' });
      return vault;
    } catch (error) {
      audit({ event: 'unlock_failed' });
      if (error instanceof MissingKeyError) {
        throw new CliError(
          `${error.message}. Without it the jar cannot be opened — cookiejar reset --force starts a new one.`,
        );
      }
      throw error;
    }
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      vault.unlock(scripted ?? (await askSecret('Master password: ')));
      audit({ event: 'unlock' });
      if (!scripted) console.log('(cookiejar passwd --none moves the key to your keyring and stops this prompt)');
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
