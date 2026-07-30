import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureConfigDir, vaultPath } from './paths.js';
import { deriveKey, newSalt, open, seal, type SealedBox } from './crypto.js';
import type { Bundle, VaultData } from './types.js';

interface VaultFile {
  format: 'cookiejar-vault';
  createdAt: string;
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

/**
 * The encrypted store of bundle definitions and grants. Cookie *values* are
 * never kept here: they are read live from the browsers on each access, so a
 * stolen vault file leaks nothing but bundle names and domains.
 */
export class Vault {
  private key: Buffer | null = null;
  private salt: Buffer | null = null;
  private data: VaultData | null = null;

  get exists(): boolean {
    return fs.existsSync(vaultPath());
  }

  get unlocked(): boolean {
    return this.key !== null;
  }

  create(password: string): void {
    if (this.exists) throw new Error('vault already exists');
    this.salt = newSalt();
    this.key = deriveKey(password, this.salt);
    this.data = structuredClone(EMPTY);
    this.persist();
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
  }

  lock(): void {
    this.key?.fill(0);
    this.key = null;
    this.salt = null;
    this.data = null;
  }

  read(): VaultData {
    if (!this.data) throw new VaultLockedError();
    return this.data;
  }

  /** Mutates the decrypted data and re-seals the file atomically. */
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
    const data = this.read();
    this.salt = newSalt();
    this.key = deriveKey(next, this.salt);
    this.data = data;
    this.persist();
  }

  private persist(): void {
    if (!this.key || !this.salt || !this.data) throw new VaultLockedError();
    ensureConfigDir();
    const file: VaultFile = {
      format: 'cookiejar-vault',
      createdAt: new Date().toISOString(),
      box: seal(JSON.stringify(this.data), this.key, this.salt),
    };
    const target = vaultPath();
    const tmp = path.join(path.dirname(target), `.vault.${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, target);
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
