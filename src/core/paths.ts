import { homedir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/** Everything cookiejar persists lives under this directory, and nowhere else. */
export function configDir(): string {
  return process.env.COOKIEJAR_HOME ?? path.join(homedir(), '.cookiejar');
}

export function vaultPath(): string {
  return path.join(configDir(), 'vault.json');
}

export function auditPath(): string {
  return path.join(configDir(), 'audit.log');
}

export function ensureConfigDir(): string {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}
