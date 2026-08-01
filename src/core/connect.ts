import fs from 'node:fs';
import path from 'node:path';
import { configDir, ensureConfigDir } from './paths.js';

/**
 * One string that carries everything a remote agent needs: where the daemon is
 * and the token to use. It is not encryption — it is a single copy-pasteable
 * unit so a handover cannot be half done, with a URL but no token.
 */
export interface Connection {
  url: string;
  token: string;
  bundle: string;
  /** Unix seconds, 0 when the token never expires. */
  expiresAt: number;
}

const PREFIX = 'cjr1.';

export function encodeConnection(connection: Connection): string {
  const payload = JSON.stringify({
    u: connection.url,
    t: connection.token,
    b: connection.bundle,
    e: connection.expiresAt,
  });
  return PREFIX + Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeConnection(value: string): Connection {
  const trimmed = value.trim();
  if (!trimmed.startsWith(PREFIX)) throw new Error('that is not a cookiejar connect string (they start with cjr1.)');
  let parsed: { u?: string; t?: string; b?: string; e?: number };
  try {
    parsed = JSON.parse(Buffer.from(trimmed.slice(PREFIX.length), 'base64url').toString('utf8')) as typeof parsed;
  } catch {
    throw new Error('that connect string is damaged — copy it again');
  }
  if (!parsed.u || !parsed.t) throw new Error('that connect string is missing its address or token');
  let url: URL;
  try {
    url = new URL(parsed.u);
  } catch {
    throw new Error('that connect string does not carry a usable address');
  }
  if (url.protocol !== 'https:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new Error('a connect string must be https unless it points at this machine');
  }
  return { url: parsed.u, token: parsed.t, bundle: parsed.b ?? 'bundle', expiresAt: parsed.e ?? 0 };
}

const connectionPath = (): string => path.join(configDir(), 'connection.json');

/**
 * Remembers the borrowed bundle on the agent's side, so `export`, `header` and
 * `mcp` need no flags after `cookiejar connect`. This file does hold a token,
 * hence 0600 — it is the agent's copy, never the lender's.
 */
export function saveConnection(connection: Connection): string {
  ensureConfigDir();
  const file = connectionPath();
  fs.writeFileSync(file, `${JSON.stringify(connection, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export function loadConnection(): Connection | null {
  try {
    return JSON.parse(fs.readFileSync(connectionPath(), 'utf8')) as Connection;
  } catch {
    return null;
  }
}

export function forgetConnection(): void {
  fs.rmSync(connectionPath(), { force: true });
}
