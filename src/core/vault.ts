import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureConfigDir, vaultPath } from './paths.js';
import { deriveKey, newSalt, open, openWithKey, seal, type SealedBox } from './crypto.js';
import { keyring, newVaultSecret } from './keyring.js';
import type { Bundle, VaultData } from './types.js';

/** Who holds the key: the OS keyring, or a passphrase in your head. */
export type Protection = 'keyring' | 'password';

interface VaultFile {
  format: 'cookiejar-vault';
  createdAt: string;
  /** Absent on jars made before keyring support, which were all password-locked. */
  protection?: Protection;
  box: SealedBox;
}

const EMPTY: VaultData = { version: 1, bundles: [] };

export class VaultLockedError extends Error {
  constructor() {
    super('vault is locked');
  }
}

export class BadPasswordError extends Error {
  constructor() {
    super('wrong master password');
  }
}

/** The jar is keyring-backed but the key is gone, so nothing can open it. */
export class MissingKeyError extends Error {
  constructor(where: string) {
    super(`the vault key is no longer in ${where}`);
  }
}

/**
 * The encrypted store of bundle definitions and grants. Cookie *values* are
 * never kept here: they are read live from the browsers on each access, so a
 * stolen vault file leaks nothing but bundle names and domains.
 */
export class Vault {
  private key: Buffer | null = null;
  private salt: Buffer | null = null;
  private mode: Protection = 'password';
  private data: VaultData | null = null;
  /** Identity of the file our decrypted copy came from, so we can tell when someone else wrote it. */
  private stamp: string | null = null;

  get exists(): boolean {
    return fs.existsSync(vaultPath());
  }

  get unlocked(): boolean {
    return this.key !== null;
  }

  /** How the jar on disk is protected; a jar that does not exist yet is keyring-backed. */
  get protection(): Protection {
    if (!this.exists) return 'keyring';
    return this.file().protection ?? 'password';
  }

  create(password: string): void {
    if (this.exists) throw new Error('vault already exists');
    this.salt = newSalt();
    this.key = deriveKey(password, this.salt);
    this.data = structuredClone(EMPTY);
    this.mode = 'password';
    this.persist();
  }

  /**
   * Makes a jar whose key lives in the OS keyring, so ordinary use never asks
   * for anything. The file stays encrypted: the key is 32 random bytes held by
   * the keychain rather than something derived from a passphrase.
   */
  createManaged(): void {
    if (this.exists) throw new Error('vault already exists');
    const secret = newVaultSecret();
    keyring().set(secret);
    this.key = Buffer.from(secret, 'base64');
    this.salt = newSalt();
    this.data = structuredClone(EMPTY);
    this.mode = 'keyring';
    this.persist();
  }

  /** Opens a keyring-backed jar with no prompt. */
  unlockFromKeyring(): void {
    const store = keyring();
    const secret = store.get();
    if (!secret) throw new MissingKeyError(store.where);
    const file = this.file();
    const key = Buffer.from(secret, 'base64');
    try {
      this.data = JSON.parse(openWithKey(file.box, key)) as VaultData;
    } catch {
      throw new MissingKeyError(store.where);
    }
    this.key = key;
    this.salt = Buffer.from(file.box.salt, 'base64');
    this.mode = 'keyring';
    this.stamp = this.diskStamp();
  }

  /** Hands the key to the OS keyring and stops asking for a password. */
  adoptKeyring(): void {
    const data = this.read();
    const secret = newVaultSecret();
    keyring().set(secret);
    this.key = Buffer.from(secret, 'base64');
    this.salt = newSalt();
    this.data = data;
    this.mode = 'keyring';
    this.persist();
  }

  /** Goes back to a passphrase, and takes the key out of the keyring. */
  adoptPassword(password: string): void {
    const data = this.read();
    this.salt = newSalt();
    this.key = deriveKey(password, this.salt);
    this.data = data;
    this.mode = 'password';
    this.persist();
    keyring().clear();
  }

  unlock(password: string): void {
    const file = JSON.parse(fs.readFileSync(vaultPath(), 'utf8')) as VaultFile;
    let opened;
    try {
      opened = open(file.box, password);
    } catch {
      throw new BadPasswordError();
    }
    this.data = JSON.parse(opened.plaintext) as VaultData;
    this.key = opened.key;
    this.salt = opened.salt;
    this.mode = 'password';
    this.stamp = this.diskStamp();
  }

  lock(): void {
    this.key?.fill(0);
    this.key = null;
    this.salt = null;
    this.data = null;
    this.stamp = null;
  }

  read(): VaultData {
    this.syncFromDisk();
    if (!this.data) throw new VaultLockedError();
    return this.data;
  }

  /**
   * Mutates the decrypted data and re-seals the file atomically. `read()` picks
   * up anyone else's edits first, so a long-lived holder — `cookiejar serve` —
   * can never write a stale copy back over a revocation made in the terminal.
   */
  write(mutate: (data: VaultData) => void): VaultData {
    const data = this.read();
    mutate(data);
    this.persist();
    return data;
  }

  bundle(id: string): Bundle {
    const found = this.read().bundles.find((b) => b.id === id);
    if (!found) throw new Error(`no such bundle: ${id}`);
    return found;
  }

  changePassword(current: string, next: string): void {
    this.unlock(current);
    this.adoptPassword(next);
  }

  private file(): VaultFile {
    return JSON.parse(fs.readFileSync(vaultPath(), 'utf8')) as VaultFile;
  }

  private diskStamp(): string | null {
    try {
      const stat = fs.statSync(vaultPath());
      return `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return null;
    }
  }

  /** Re-reads the file when another process has replaced it since we last touched it. */
  private syncFromDisk(): void {
    if (!this.key) return;
    const stamp = this.diskStamp();
    if (stamp === null || stamp === this.stamp) return;
    const file = this.file();
    try {
      this.data = JSON.parse(openWithKey(file.box, this.key)) as VaultData;
    } catch {
      // The master password changed under us; holding the old copy open would be wrong.
      this.lock();
      return;
    }
    this.salt = Buffer.from(file.box.salt, 'base64');
    this.stamp = stamp;
  }

  private persist(): void {
    if (!this.key || !this.salt || !this.data) throw new VaultLockedError();
    ensureConfigDir();
    const file: VaultFile = {
      format: 'cookiejar-vault',
      createdAt: new Date().toISOString(),
      protection: this.mode,
      box: seal(JSON.stringify(this.data), this.key, this.salt),
    };
    const target = vaultPath();
    const tmp = path.join(path.dirname(target), `.vault.${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, target);
    this.stamp = this.diskStamp();
  }
}

export function newBundleId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  return `${slug || 'bundle'}-${crypto.randomBytes(3).toString('hex')}`;
}
