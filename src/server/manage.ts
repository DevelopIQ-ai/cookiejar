import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { readAudit } from '../core/audit.js';
import { installedBrowsers, profileHealth, safariAccess, toMeta } from '../core/browsers/index.js';
import { bareDomain, domainCovers, isExpired, resolveBundle } from '../core/bundles.js';
import {
  addSelector,
  createBundle,
  deleteBundle,
  grantId,
  issueGrant,
  removeSelector,
  revokeGrant,
  setPreferences,
  updateBundle,
} from '../core/manage.js';
import { findSuggestion, suggestBundles } from '../core/suggest.js';
import type { Bundle, BrowserId, CookieSelector } from '../core/types.js';
import type { Vault } from '../core/vault.js';
import { readJsonBody, sendJson } from './util.js';

/**
 * The browser-facing half of the daemon: everything `cookiejar` can do from the
 * terminal, over loopback HTTP, so the UI is a view of the same vault rather
 * than a second source of truth. It is only mounted by `cookiejar ui`.
 */

const SESSION_COOKIE = 'cjr_ui';

export interface ManageContext {
  vault: Vault;
  /** Printed once in the terminal; exchanged for the session cookie. */
  sessionKey: string;
  port: number;
}

export interface ManageSession {
  /** True once the browser has presented the session key from the terminal. */
  authorized(req: IncomingMessage): boolean;
  /** Sets the session cookie after a correct `?k=` on the opening request. */
  grant(res: ServerResponse): void;
  revoke(): void;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

export function createSession(): ManageSession {
  let token: string | null = null;
  return {
    authorized: (req) => Boolean(token) && parseCookies(req.headers.cookie)[SESSION_COOKIE] === token,
    grant(res) {
      token = crypto.randomBytes(32).toString('base64url');
      res.setHeader('set-cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`);
    },
    revoke() {
      token = null;
    },
  };
}

/**
 * The daemon listens on loopback, but any page in the browser can still POST to
 * 127.0.0.1, so state-changing requests must come from the UI's own origin.
 */
export function originAllowed(req: IncomingMessage, port: number): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]).has(origin);
}

const publicBundle = (bundle: Bundle) => ({
  ...bundle,
  grants: bundle.grants.map((grant) => ({ ...grant, id: grantId(grant), tokenHash: undefined })),
});

/** Honours the browsers picked in setup, exactly as the CLI does. */
function chosen(vault: Vault, all: boolean): BrowserId[] | undefined {
  if (all) return undefined;
  const preferences = vault.read().preferences;
  return preferences?.onboardedAt && preferences.browsers.length > 0 ? preferences.browsers : undefined;
}

export async function handleManageApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: ManageContext,
  session: ManageSession,
): Promise<boolean> {
  const route = url.pathname;
  if (!route.startsWith('/api/')) return false;
  const method = req.method ?? 'GET';
  const { vault } = ctx;

  if (!session.authorized(req)) {
    sendJson(res, 401, { error: 'this page lost its session — restart cookiejar ui' });
    return true;
  }
  if (method !== 'GET' && !originAllowed(req, ctx.port)) {
    sendJson(res, 403, { error: 'cross-origin request refused' });
    return true;
  }

  const all = url.searchParams.get('all') === '1';

  if (route === '/api/state') {
    const health = profileHealth();
    const preferences = vault.read().preferences;
    sendJson(res, 200, {
      unlocked: vault.unlocked,
      browsers: preferences?.browsers ?? [],
      installed: installedBrowsers(),
      safari: safariAccess().state,
      profiles: health.usable.map((read) => ({
        id: read.profile.id,
        label: read.profile.label,
        browser: read.profile.browser,
        cookieCount: read.cookies.length,
        siteCount: new Set(read.cookies.map((c) => bareDomain(c.domain))).size,
      })),
      blocked: health.blocked.map(({ profile, error }) => ({ id: profile.id, label: profile.label, error })),
    });
    return true;
  }

  if (route === '/api/browsers' && method === 'POST') {
    const body = await readJsonBody<{ browsers?: string[] }>(req);
    sendJson(res, 200, { preferences: setPreferences(vault, (body.browsers ?? []) as BrowserId[], true) });
    return true;
  }

  if (route === '/api/sites') {
    const query = (url.searchParams.get('q') ?? '').toLowerCase();
    const sites = new Map<string, { site: string; cookieCount: number; profileIds: Set<string>; expired: number }>();
    for (const read of profileHealth(undefined, chosen(vault, all)).usable) {
      for (const cookie of read.cookies) {
        const site = bareDomain(cookie.domain);
        if (query && !site.includes(query)) continue;
        const entry = sites.get(site) ?? { site, cookieCount: 0, profileIds: new Set<string>(), expired: 0 };
        entry.cookieCount += 1;
        entry.profileIds.add(cookie.profileId);
        if (isExpired(cookie)) entry.expired += 1;
        sites.set(site, entry);
      }
    }
    sendJson(res, 200, {
      sites: [...sites.values()]
        .map((entry) => ({ ...entry, profileIds: [...entry.profileIds] }))
        .sort((a, b) => b.cookieCount - a.cookieCount || a.site.localeCompare(b.site)),
    });
    return true;
  }

  if (route === '/api/cookies') {
    const site = url.searchParams.get('site');
    if (!site) {
      sendJson(res, 400, { error: 'site is required' });
      return true;
    }
    // toMeta drops the value: the browser never receives a cookie value.
    const cookies = profileHealth(undefined, chosen(vault, all))
      .usable.flatMap((read) => read.cookies)
      .filter((cookie) => domainCovers(site, cookie.domain))
      .map(toMeta)
      .sort((a, b) => a.profileId.localeCompare(b.profileId) || a.name.localeCompare(b.name));
    sendJson(res, 200, { cookies });
    return true;
  }

  if (route === '/api/suggestions') {
    sendJson(res, 200, { suggestions: suggestBundles(chosen(vault, all)) });
    return true;
  }

  if (route === '/api/suggestions/accept' && method === 'POST') {
    const body = await readJsonBody<{ categoryId?: string; name?: string }>(req);
    const suggestion = findSuggestion(suggestBundles(chosen(vault, all)), body.categoryId ?? '');
    if (!suggestion) {
      sendJson(res, 404, { error: 'no such suggestion' });
      return true;
    }
    const bundle = createBundle(vault, {
      name: body.name?.trim() || suggestion.name,
      description: suggestion.description,
      selectors: suggestion.selectors,
    });
    sendJson(res, 200, { bundle: publicBundle(bundle) });
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
    const bundle = createBundle(vault, { name: body.name, description: body.description, selectors: body.selectors });
    sendJson(res, 200, { bundle: publicBundle(bundle) });
    return true;
  }

  const match = /^\/api\/bundles\/([^/]+)(\/.*)?$/.exec(route);
  if (match) {
    const bundleId = decodeURIComponent(match[1]);
    const sub = match[2] ?? '';
    let bundle: Bundle;
    try {
      bundle = vault.bundle(bundleId);
    } catch {
      sendJson(res, 404, { error: 'no such bundle' });
      return true;
    }

    if (sub === '' && method === 'GET') {
      const resolved = resolveBundle(bundle);
      sendJson(res, 200, {
        bundle: publicBundle(bundle),
        cookies: resolved.cookies.map(toMeta),
        emptySelectors: resolved.emptySelectors,
        errors: resolved.errors,
      });
      return true;
    }

    if (sub === '' && method === 'PUT') {
      const body = await readJsonBody<{ name?: string; description?: string }>(req);
      sendJson(res, 200, { bundle: publicBundle(updateBundle(vault, bundleId, body)) });
      return true;
    }

    if (sub === '' && method === 'DELETE') {
      deleteBundle(vault, bundleId);
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (sub === '/selectors' && method === 'POST') {
      const body = await readJsonBody<CookieSelector>(req);
      if (!body.profileId || !body.domain) {
        sendJson(res, 400, { error: 'profileId and domain are required' });
        return true;
      }
      addSelector(vault, bundleId, { profileId: body.profileId, domain: body.domain, names: body.names ?? [] });
      sendJson(res, 200, { bundle: publicBundle(vault.bundle(bundleId)) });
      return true;
    }

    if (sub === '/selectors' && method === 'DELETE') {
      const domain = url.searchParams.get('domain');
      if (!domain) {
        sendJson(res, 400, { error: 'domain is required' });
        return true;
      }
      removeSelector(vault, bundleId, domain, url.searchParams.get('profileId') ?? undefined);
      sendJson(res, 200, { bundle: publicBundle(vault.bundle(bundleId)) });
      return true;
    }

    if (sub === '/grants' && method === 'POST') {
      const body = await readJsonBody<{ label?: string; expiresInDays?: number; allowFetch?: boolean; redactValues?: boolean }>(req);
      const { token, grant } = issueGrant(vault, bundleId, body);
      // The only place a token is ever returned; it is not stored anywhere.
      sendJson(res, 200, { token, grant: { ...grant, id: grantId(grant), tokenHash: undefined } });
      return true;
    }

    const grantMatch = /^\/grants\/([0-9a-f]+)$/.exec(sub);
    if (grantMatch && method === 'DELETE') {
      try {
        revokeGrant(vault, bundleId, grantMatch[1]);
      } catch {
        sendJson(res, 404, { error: 'no such token' });
        return true;
      }
      sendJson(res, 200, { ok: true });
      return true;
    }
  }

  // Every token the jar handed out, in one place: per-bundle lists hide the
  // one you forgot about, which is the one that matters.
  if (route === '/api/tokens') {
    const now = Date.now() / 1000;
    sendJson(res, 200, {
      tokens: vault.read().bundles.flatMap((bundle) =>
        bundle.grants.map((grant) => ({
          id: grantId(grant),
          bundleId: bundle.id,
          bundleName: bundle.name,
          label: grant.label,
          createdAt: grant.createdAt,
          expiresAt: grant.expiresAt,
          lastUsedAt: grant.lastUsedAt,
          useCount: grant.useCount,
          proxyOnly: grant.redactValues,
          state: grant.revokedAt ? 'revoked' : grant.expiresAt && grant.expiresAt < now ? 'expired' : 'live',
        })),
      ),
    });
    return true;
  }

  if (route === '/api/activity') {
    sendJson(res, 200, { entries: readAudit(200) });
    return true;
  }

  if (route === '/api/lock' && method === 'POST') {
    session.revoke();
    vault.lock();
    sendJson(res, 200, { ok: true });
    return true;
  }

  sendJson(res, 404, { error: 'no such endpoint' });
  return true;
}
