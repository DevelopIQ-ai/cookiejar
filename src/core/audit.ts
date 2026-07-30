import fs from 'node:fs';
import { auditPath, ensureConfigDir } from './paths.js';
import type { AuditEntry } from './types.js';

/** Append-only local log of every access. Cookie values are never recorded. */
export function audit(entry: Omit<AuditEntry, 'at'>): void {
  ensureConfigDir();
  fs.appendFileSync(auditPath(), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
}

export function readAudit(limit = 200): AuditEntry[] {
  if (!fs.existsSync(auditPath())) return [];
  return fs
    .readFileSync(auditPath(), 'utf8')
    .split('\n')
    .filter(Boolean)
    .slice(-limit)
    .reverse()
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as AuditEntry];
      } catch {
        return [];
      }
    });
}
