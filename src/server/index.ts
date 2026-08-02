import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vault, VaultLockedError } from '../core/vault.js';
import {
  describeBundle,
  exportCookies,
  OutOfBundleError,
  proxyRequest,
  type CookieFormat,
} from '../core/agent.js';
import { AccessDeniedError, authorize, noteUse } from '../core/access.js';
import { createSession, handleManageApi, originAllowed } from './manage.js';
import { bearerToken, readJsonBody, sendJson } from './util.js';

export interface ServerOptions {
  port: number;
  host?: string;
  /** An unlocked vault. Agent tokens are useless without one. */
  vault: Vault;
  /** Locks the vault after this many idle minutes. 0 disables auto-lock. */
  autoLockMinutes?: number;
  /**
   * Serves the management UI as well as `/agent/*`. The key is printed in the
   * terminal and exchanged for a session cookie on the first page load, so the
   * browser cannot reach the vault without having seen the terminal.
   */
  ui?: { sessionKey: string };
}

const uiFile = (): string =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'index.html');

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
  const session = createSession();

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
      noteUse(vault, grantee, 'bundle_read', 'describe');
      sendJson(res, 200, {
        ...describeBundle(bundle),
        permissions: { allowFetch: grant.allowFetch, redactValues: grant.redactValues },
        expiresAt: grant.expiresAt,
      });
      return true;
    }

    if (url.pathname === '/agent/cookies') {
      if (grant.redactValues) {
        sendJson(res, 403, { error: 'this token cannot read cookie values; use /agent/fetch instead' });
        return true;
      }
      const format = (url.searchParams.get('format') ?? 'json') as CookieFormat;
      const target = url.searchParams.get('url');
      noteUse(vault, grantee, 'bundle_read', format);
      if (format === 'header') {
        if (!target) {
          sendJson(res, 400, { error: 'url is required for format=header' });
          return true;
        }
        sendJson(res, 200, { cookie: exportCookies(bundle, 'header', target) });
        return true;
      }
      if (format === 'netscape') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end(exportCookies(bundle, 'netscape'));
        return true;
      }
      if (format === 'storage-state') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(exportCookies(bundle, 'storage-state'));
        return true;
      }
      sendJson(res, 200, { cookies: JSON.parse(exportCookies(bundle, 'json')) as unknown });
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
        as?: 'html' | 'text';
      }>(req);
      if (!body.url) {
        sendJson(res, 400, { error: 'url is required' });
        return true;
      }
      let result;
      try {
        result = await proxyRequest(bundle, {
          url: body.url,
          method: body.method,
          headers: body.headers,
          body: body.body,
          as: body.as,
        });
      } catch (error) {
        if (error instanceof OutOfBundleError) {
          sendJson(res, 403, { error: error.message });
          return true;
        }
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        return true;
      }
      const target = new URL(body.url);
      noteUse(vault, grantee, 'bundle_fetch', `${body.method ?? 'GET'} ${target.origin}${target.pathname}`);
      sendJson(res, 200, result);
      return true;
    }

    sendJson(res, 404, { error: 'no such endpoint' });
    return true;
  }

  /** Serves the single-file UI, and only that file. */
  function serveUi(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (url.searchParams.get('k') === options.ui!.sessionKey) {
      session.grant(res);
      res.writeHead(302, { location: '/' });
      res.end();
      return;
    }
    if (!session.authorized(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Open the link cookiejar printed in your terminal.\n');
      return;
    }
    const file = uiFile();
    if (!fs.existsSync(file)) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('UI is missing from this install. Run npm run build.\n');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:",
      'referrer-policy': 'no-referrer',
    });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    void (async () => {
      try {
        if (await handleAgentApi(req, res, url)) return;
        if (url.pathname === '/health') {
          sendJson(res, 200, { ok: true, unlocked: vault.unlocked, ui: Boolean(options.ui) });
          return;
        }
        if (options.ui) {
          if (req.method !== 'GET' && !originAllowed(req, port)) {
            sendJson(res, 403, { error: 'cross-origin request refused' });
            return;
          }
          expire();
          lastUse = Date.now();
          if (await handleManageApi(req, res, url, { vault, sessionKey: options.ui.sessionKey, port }, session)) return;
          if (url.pathname === '/') {
            serveUi(req, res, url);
            return;
          }
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
