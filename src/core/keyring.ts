import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { configDir, ensureConfigDir } from './paths.js';

const SERVICE = 'cookiejar';
const ACCOUNT = 'vault-key';

export type KeyringKind = 'keychain' | 'libsecret' | 'file';

export interface Keyring {
  kind: KeyringKind;
  /** Where the key ends up, in words a person can act on. */
  where: string;
  get(): string | null;
  set(secret: string): void;
  clear(): void;
}

const run = (command: string, args: string[], input?: string) =>
  spawnSync(command, args, { encoding: 'utf8', input });

const has = (command: string): boolean => run('sh', ['-c', `command -v ${command}`]).status === 0;

/** macOS Keychain, which is what "no password" should mean on a Mac. */
const keychain = (): Keyring => ({
  kind: 'keychain',
  where: 'your macOS Keychain',
  get() {
    const found = run('security', ['find-generic-password', '-a', ACCOUNT, '-s', SERVICE, '-w']);
    return found.status === 0 ? found.stdout.trim() : null;
  },
  set(secret) {
    const wrote = run('security', [
      'add-generic-password',
      '-a', ACCOUNT,
      '-s', SERVICE,
      '-w', secret,
      '-U',
      '-D', 'cookiejar vault key',
    ]);
    if (wrote.status !== 0) throw new Error(`could not write to the Keychain: ${wrote.stderr.trim()}`);
  },
  clear() {
    run('security', ['delete-generic-password', '-a', ACCOUNT, '-s', SERVICE]);
  },
});

/** GNOME Keyring / KWallet, through the freedesktop secret service. */
const libsecret = (): Keyring => ({
  kind: 'libsecret',
  where: 'your login keyring',
  get() {
    const found = run('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT]);
    return found.status === 0 && found.stdout.trim() ? found.stdout.trim() : null;
  },
  set(secret) {
    const wrote = run(
      'secret-tool',
      ['store', '--label=cookiejar vault key', 'service', SERVICE, 'account', ACCOUNT],
      secret,
    );
    if (wrote.status !== 0) throw new Error(`could not write to the keyring: ${wrote.stderr.trim()}`);
  },
  clear() {
    run('secret-tool', ['clear', 'service', SERVICE, 'account', ACCOUNT]);
  },
});

/**
 * No OS keyring here, so the key is a 0600 file next to the vault. That is
 * weaker — anything that can read one can read the other — but it is honest
 * about it, and it still keeps the key out of backups that skip dotfiles.
 */
const keyFile = (): Keyring => {
  const file = () => path.join(configDir(), 'key');
  return {
    kind: 'file',
    where: file(),
    get() {
      try {
        return fs.readFileSync(file(), 'utf8').trim() || null;
      } catch {
        return null;
      }
    },
    set(secret) {
      ensureConfigDir();
      fs.writeFileSync(file(), `${secret}\n`, { mode: 0o600 });
      fs.chmodSync(file(), 0o600);
    },
    clear() {
      fs.rmSync(file(), { force: true });
    },
  };
};

/** Picks the strongest store this machine actually has. */
export function keyring(): Keyring {
  if (process.env.COOKIEJAR_KEYRING === 'file') return keyFile();
  if (process.platform === 'darwin' && has('security')) return keychain();
  if (has('secret-tool')) return libsecret();
  return keyFile();
}

export function newVaultSecret(): string {
  return crypto.randomBytes(32).toString('base64');
}
