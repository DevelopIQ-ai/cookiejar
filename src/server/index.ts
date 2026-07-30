import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Vault, newBundleId, BadPasswordError, VaultLockedError } from '../core/vault.js';
import { audit, readAudit } from '../core/audit.js';
import { hashToken, newToken } from '../core/crypto.js';
import { readAllProfiles, toMeta } from '../core/browsers/index.js';
import {
  bareDomain,
  cookieHeaderFor,
  domainCovers,
  isExpired,
  resolveBundle,
  toNetscape,
  toStorageState,
} from '../core/bundles.js';
import { AccessDeniedError, authorize, noteUse } from '../core/access.js';
import type { Bundle, CookieSelector } from '../core/types.js';
import { bearerToken, originAllowed, parseCookies, readJsonBody, sendJson } from './util.js';

const SESSION_COOKIE = 'cjr_session';
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export interface ServerOptions {
  port: number;
  host?: string;
  uiDir?: string;
  /** Locks the vault after this many idle minutes. 0 disables auto-lock. */
  autoLockMinutes?: number;
}

interface Session {
  token: string;
  lastSeen: number;
}

export function createServer(options: ServerOptions) {
  const vault = new Vault();
  const port = options.port;
  const uiDir = options.uiDir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
  const autoLockMs = (options.autoLockMinutes ?? 30) * 60_000;
  let session: Session | null = null;

  const expireSession = (): void => {
    if (!session) return;
    if (autoLockMs > 0 && Date.now() - session.lastSeen > autoLockMs) {
      session = null;
      vault.lock();
    }
  };

  const hasSession = (req: IncomingMessage): boolean => {
    expireSession();
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!session || !token || token !== session.token) return false;
    session.lastSeen = Date.now();
    return vault.unlocked;
  };

  const startSession = (res: ServerResponse): void => {
    session = { token: crypto.randomBytes(32).toString('base64url'), lastSeen: Date.now() };
    res.setHeader('set-cookie', `${SESSION_COOKIE}=${session.token}; Path=/; HttpOnly; SameSite=Strict`);
  };

  const publicBundle = (bundle: Bundle) => ({
    ...bundle,
    grants: bundle.grants.map(({ tokenHash, ...rest }) => ({ ...rest, id: tokenHash.slice(0, 12), tokenHash })),
  });

  async function handleUiApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const method = req.method ?? 'GET';
    const route = url.pathname;

    if (route === '/api/state') {
      sendJson(res, 200, {
        vaultExists: vault.exists,
        unlocked: hasSession(req),
        platform: process.platform,
        autoLockMinutes: options.autoLockMinutes ?? 30,
      });
      return true;
    }

    if (route === '/api/vault/create' && method === 'POST') {
      const { password } = await readJsonBody<{ password?: string }>(req);
      if (!password || password.length < 8) {
        sendJson(res, 400, { error: 'master password must be at least 8 characters' });
        return true;
      }
      vault.create(password);
      startSession(res);
      audit({ event: 'unlock', detail: 'vault created' });
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (route === '/api/vault/unlock' && method === 'POST') {
      const { password } = await readJsonBody<{ password?: string }>(req);
      try {
        vault.unlock(password ?? '');
      } catch (error) {
        audit({ event: 'unlock_failed' });
        sendJson(res, 401, { error: error instanceof BadPasswordError ? 'wrong master password' : String(error) });
        return true;
      }
      startSession(res);
      audit({ event: 'unlock' });
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (route === '/api/vault/lock' && method === 'POST') {
      session = null;
      vault.lock();
      sendJson(res, 200, { ok: true });
      return true;
    }

    // Everything below needs an unlocked session.
    if (!route.startsWith('/api/')) return false;
    if (!hasSession(req)) {
      sendJson(res, 401, { error: 'locked' });
      return true;
    }

    if (route === '/api/vault/password' && method === 'POST') {
      const { current, next } = await readJsonBody<{ current?: string; next?: string }>(req);
      if (!next || next.length < 8) {
        sendJson(res, 400, { error: 'new password must be at least 8 characters' });
        return true;
      }
      try {
        vault.changePassword(current ?? '', next);
      } catch {
        sendJson(res, 401, { error: 'wrong master password' });
        return true;
      }
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (route === '/api/profiles') {
      const reads = readAllProfiles();
      sendJson(res, 200, {
        profiles: reads.map((read) => ({
          ...read.profile,
          cookieCount: read.cookies.length,
          siteCount: new Set(read.cookies.map((c) => bareDomain(c.domain))).size,
          error: read.error ?? null,
        })),
      });
      return true;
    }

    if (route === '/api/sites') {
      const profileIds = url.searchParams.getAll('profileId');
      const query = (url.searchParams.get('q') ?? '').toLowerCase();
      const reads = readAllProfiles(profileIds.length ? profileIds : undefined);
      const sites = new Map<string, { site: string; cookieCount: number; profileIds: Set<string>; expiring: number }>();
      for (const read of reads) {
        for (const cookie of read.cookies) {
          const site = bareDomain(cookie.domain);
          if (query && !site.includes(query)) continue;
          const entry = sites.get(site) ?? { site, cookieCount: 0, profileIds: new Set(), expiring: 0 };
          entry.cookieCount += 1;
          entry.profileIds.add(cookie.profileId);
          if (isExpired(cookie)) entry.expiring += 1;
          sites.set(site, entry);
        }
      }
      sendJson(res, 200, {
        sites: [...sites.values()]
          .map((entry) => ({ ...entry, profileIds: [...entry.profileIds] }))
          .sort((a, b) => b.cookieCount - a.cookieCount || a.site.localeCompare(b.site)),
        errors: reads.filter((r) => r.error).map((r) => ({ profileId: r.profile.id, error: r.error! })),
      });
      return true;
    }

    if (route === '/api/cookies') {
      const site = url.searchParams.get('site');
      if (!site) {
        sendJson(res, 400, { error: 'site is required' });
        return true;
      }
      const profileIds = url.searchParams.getAll('profileId');
      const reads = readAllProfiles(profileIds.length ? profileIds : undefined);
      const cookies = reads
        .flatMap((read) => read.cookies)
        .filter((cookie) => domainCovers(site, cookie.domain))
        .map(toMeta)
        .sort((a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name));
      sendJson(res, 200, { cookies });
      return true;
    }

    if (route === '/api/bundles' && method === 'GET') {
      sendJson(res, 200, { bundles: vault.read().bundles.map(publicBundle) });
      return true;
    }

    if (route === '/api/bundles' && method === 'POST') {
      const body = await readJsonBody<{ name?: string; description?: string; selectors?: CookieSelector[] }>(req);
      if (!body.name?.trim()) {
        sendJson(res, 400, { error: 'bundle name is required' });
        return true;
      }
      const now = new Date().toISOString();
      const bundle: Bundle = {
        id: newBundleId(body.name),
        name: body.name.trim(),
        description: body.description?.trim() ?? '',
        createdAt: now,
        updatedAt: now,
        selectors: body.selectors ?? [],
        grants: [],
      };
      vault.write((data) => data.bundles.push(bundle));
      audit({ event: 'bundle_saved', bundleId: bundle.id, detail: 'created' });
      sendJson(res, 200, { bundle: publicBundle(bundle) });
      return true;
    }

    const bundleMatch = /^\/api\/bundles\/([^/]+)(\/.*)?$/.exec(route);
    if (bundleMatch) {
      const bundleId = decodeURIComponent(bundleMatch[1]);
      const sub = bundleMatch[2] ?? '';
      let bundle: Bundle;
      try {
        bundle = vault.bundle(bundleId);
      } catch {
        sendJson(res, 404, { error: 'no such bundle' });
        return true;
      }

      if (sub === '' && method === 'PUT') {
        const body = await readJsonBody<{ name?: string; description?: string; selectors?: CookieSelector[] }>(req);
        vault.write((data) => {
          const target = data.bundles.find((b) => b.id === bundleId)!;
          if (body.name?.trim()) target.name = body.name.trim();
          if (body.description !== undefined) target.description = body.description.trim();
          if (body.selectors) target.selectors = body.selectors;
          target.updatedAt = new Date().toISOString();
        });
        audit({ event: 'bundle_saved', bundleId });
        sendJson(res, 200, { bundle: publicBundle(vault.bundle(bundleId)) });
        return true;
      }

      if (sub === '' && method === 'DELETE') {
        vault.write((data) => {
          data.bundles = data.bundles.filter((b) => b.id !== bundleId);
        });
        audit({ event: 'bundle_deleted', bundleId });
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (sub === '/preview' && method === 'GET') {
        const resolved = resolveBundle(bundle);
        sendJson(res, 200, {
          cookies: resolved.cookies.map(toMeta),
          emptySelectors: resolved.emptySelectors,
          errors: resolved.errors,
        });
        return true;
      }

      if (sub === '/grants' && method === 'POST') {
        const body = await readJsonBody<{
          label?: string;
          expiresInDays?: number;
          allowFetch?: boolean;
          redactValues?: boolean;
        }>(req);
        const token = newToken();
        const grant = {
          tokenHash: hashToken(token),
          label: body.label?.trim() || 'agent',
          createdAt: new Date().toISOString(),
          expiresAt: body.expiresInDays ? Math.floor(Date.now() / 1000 + body.expiresInDays * 86_400) : 0,
          allowFetch: body.allowFetch ?? true,
          redactValues: body.redactValues ?? false,
          lastUsedAt: null,
          useCount: 0,
          revokedAt: null,
        };
        vault.write((data) => data.bundles.find((b) => b.id === bundleId)!.grants.push(grant));
        audit({ event: 'grant_created', bundleId, grantLabel: grant.label });
        sendJson(res, 200, { token, grant: { ...grant, id: grant.tokenHash.slice(0, 12) } });
        return true;
      }

      const grantMatch = /^\/grants\/([0-9a-f]+)$/.exec(sub);
      if (grantMatch && method === 'DELETE') {
        vault.write((data) => {
          const grant = data.bundles
            .find((b) => b.id === bundleId)!
            .grants.find((g) => g.tokenHash.startsWith(grantMatch[1]));
          if (grant) grant.revokedAt = new Date().toISOString();
        });
        audit({ event: 'grant_revoked', bundleId });
        sendJson(res, 200, { ok: true });
        return true;
      }
    }

    if (route === '/api/audit') {
      sendJson(res, 200, { entries: readAudit(200) });
      return true;
    }

    sendJson(res, 404, { error: 'no such endpoint' });
    return true;
  }

  async function handleAgentApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith('/agent/')) return false;
    let grantee;
    try {
      grantee = authorize(vault, bearerToken(req));
    } catch (error) {
      sendJson(res, error instanceof AccessDeniedError ? 403 : 500, { error: (error as Error).message });
      return true;
    }
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
        headers: Object.fromEntries([...upstream.headers].filter(([k]) => k !== 'set-cookie')),
        body: text.slice(0, 1_000_000),
        truncated: text.length > 1_000_000,
      });
      return true;
    }

    sendJson(res, 404, { error: 'no such endpoint' });
    return true;
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const candidate = path.join(uiDir, relative);
    const file = candidate.startsWith(uiDir) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()
      ? candidate
      : path.join(uiDir, 'index.html');
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('UI not built. Run `npm run build:ui`.\n');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': file.endsWith('.html') ? 'no-store' : 'public, max-age=3600',
      'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:",
      'referrer-policy': 'no-referrer',
    });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    void (async () => {
      try {
        if (req.method !== 'GET' && !originAllowed(req, port)) {
          sendJson(res, 403, { error: 'cross-origin request refused' });
          return;
        }
        if (await handleAgentApi(req, res, url)) return;
        if (await handleUiApi(req, res, url)) return;
        serveStatic(req, res, url);
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
