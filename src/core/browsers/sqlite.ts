import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/**
 * Browsers hold a write lock on their cookie stores while running, so read from
 * a throwaway copy (including the WAL, or recent cookies go missing).
 */
export function withCookieDb<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), `cookiejar-${crypto.randomBytes(4).toString('hex')}-`));
  const copy = path.join(scratch, path.basename(dbPath));
  try {
    fs.copyFileSync(dbPath, copy);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, copy + suffix);
    }
    const db = new DatabaseSync(copy, { readOnly: false });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** Chromium stores timestamps as microseconds since 1601-01-01. */
export function webkitToUnix(micros: number | bigint): number {
  const value = typeof micros === 'bigint' ? Number(micros) : micros;
  if (!value) return 0;
  return Math.max(0, Math.floor(value / 1_000_000 - 11_644_473_600));
}
