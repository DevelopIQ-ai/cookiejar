import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { Vault, VaultLockedError } from '../core/vault.js';
import {
  bareDomain,
  cookieHeaderFor,
  resolveBundle,
  toNetscape,
  toStorageState,
} from '../core/bundles.js';
import { AccessDeniedError, authorize, noteUse } from '../core/access.js';
import { bearerToken, readJsonBody, sendJson } from './util.js';

export interface ServerOptions {
  port: number;
  host?: string;
  /** An unlocked vault. Agent tokens are useless without one. */
  vault: Vault;
  /** Locks the vault after this many idle minutes. 0 disables auto-lock. */
  autoLockMinutes?: number;
}

/**
 * The agent side of cookiejar: a loopback HTTP server that answers bundle
 * tokens. Management lives entirely in the CLI, so nothing here can create or
 * change a bundle — a leaked token can only use what it was granted.
 */
export function createServer(options: ServerOptions) {
  const { vault } = options;
  const port = options.port;
  const autoLockMs = (options.autoLockMinutes ?? 30) * 60_000;
  let lastUse = Date.now();

  const expire = (): void => {
    if (autoLockMs > 0 && vault.unlocked && Date.now() - lastUse > autoLockMs) vault.lock();
  };

  async function handleAgentApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith('/agent/')) return false;
    expire();
    let grantee;
    try {
      grantee = authorize(vault, bearerToken(req));
    } catch (error) {
      sendJson(res, error instanceof AccessDeniedError ? 403 : 500, { error: (error as Error).message });
      return true;
    }
    lastUse = Date.now();
    const { bundle, grant } = grantee;

    if (url.pathname === '/agent/bundle') {
      const resolved = resolveBundle(bundle);
      noteUse(vault, grantee, 'bundle_read', 'describe');
      sendJson(res, 200, {
        bundle: { id: bundle.id, name: bundle.name, description: bundle.description },
        hosts: [...new Set(resolved.cookies.map((c) => bareDomain(c.domain)))].sort(),
        cookieCount: resolved.cookies.length,
        permissions: { allowFetch: grant.allowFetch, redactValues: grant.redactValues },
        warnings: resolved.errors.map((e) => `${e.profileId}: ${e.error}`),
      });
      return true;
    }

    if (url.pathname === '/agent/cookies') {
      if (grant.redactValues) {
        sendJson(res, 403, { error: 'this token cannot read cookie values; use /agent/fetch instead' });
        return true;
      }
      const resolved = resolveBundle(bundle);
      const format = url.searchParams.get('format') ?? 'json';
      const target = url.searchParams.get('url');
      noteUse(vault, grantee, 'bundle_read', format);
      if (format === 'netscape') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end(toNetscape(resolved.cookies));
        return true;
      }
      if (format === 'storage-state') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(toStorageState(resolved.cookies));
        return true;
      }
      if (format === 'header') {
        if (!target) {
          sendJson(res, 400, { error: 'url is required for format=header' });
          return true;
        }
        sendJson(res, 200, { cookie: cookieHeaderFor(resolved.cookies, target) });
        return true;
      }
      sendJson(res, 200, {
        cookies: resolved.cookies.map(({ profileId, browser, ...cookie }) => cookie),
      });
      return true;
    }

    if (url.pathname === '/agent/fetch' && req.method === 'POST') {
      if (!grant.allowFetch) {
        sendJson(res, 403, { error: 'this token may not proxy requests' });
        return true;
      }
      const body = await readJsonBody<{
        url?: string;
        method?: string;
        headers?: Record<string, string>;
        body?: string;
      }>(req);
      if (!body.url) {
        sendJson(res, 400, { error: 'url is required' });
        return true;
      }
      const resolved = resolveBundle(bundle);
      let target: URL;
      try {
        target = new URL(body.url);
      } catch {
        sendJson(res, 400, { error: 'invalid url' });
        return true;
      }
      const hosts = new Set(resolved.cookies.map((c) => bareDomain(c.domain)));
      const allowed = [...hosts].some(
        (host) => target.hostname === host || target.hostname.endsWith(`.${host}`) || host.endsWith(`.${target.hostname}`),
      );
      if (!allowed) {
        sendJson(res, 403, { error: `bundle "${bundle.name}" holds no cookies for ${target.hostname}` });
        return true;
      }
      const cookieHeader = cookieHeaderFor(resolved.cookies, target.toString());
      noteUse(vault, grantee, 'bundle_fetch', `${body.method ?? 'GET'} ${target.origin}${target.pathname}`);
      const upstream = await fetch(target, {
        method: body.method ?? 'GET',
        headers: { ...(body.headers ?? {}), cookie: cookieHeader },
        body: body.body,
        redirect: 'follow',
      });
      const text = await upstream.text();
      sendJson(res, 200, {
        status: upstream.status,
        // set-cookie is stripped: an agent may use the session, not extend it.
        headers: Object.fromEntries([...upstream.headers].filter(([k]) => k !== 'set-cookie')),
        body: text.slice(0, 1_000_000),
        truncated: text.length > 1_000_000,
      });
      return true;
    }

    sendJson(res, 404, { error: 'no such endpoint' });
    return true;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    void (async () => {
      try {
        if (await handleAgentApi(req, res, url)) return;
        if (url.pathname === '/health') {
          sendJson(res, 200, { ok: true, unlocked: vault.unlocked });
          return;
        }
        sendJson(res, 404, { error: 'cookiejar serves /agent/* only; manage bundles with the cookiejar CLI' });
      } catch (error) {
        const status = error instanceof VaultLockedError ? 401 : 500;
        sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });

  return { server, vault };
}

export function startServer(options: ServerOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const { server } = createServer(options);
  const host = options.host ?? '127.0.0.1';
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      resolve({
        url: `http://${host}:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
