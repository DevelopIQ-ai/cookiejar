/**
 * What an agent is allowed to do with a bundle, independent of how it got here.
 *
 * The same three operations back the HTTP daemon (a bundle lent over a tunnel)
 * and the local MCP server (an agent on this machine, no daemon, no token), so
 * a cloud agent and a local one see exactly the same behaviour — including the
 * host allowlist and the fact that `set-cookie` never comes back.
 */
import { bareDomain, cookieHeaderFor, resolveBundle, toNetscape, toStorageState } from './bundles.js';
import { authHint } from './hints.js';
import { looksLikeHtml, readable } from './readable.js';
import type { Bundle } from './types.js';

export interface BundleDescription {
  bundle: { id: string; name: string; description?: string };
  hosts: string[];
  cookieCount: number;
  warnings: string[];
}

export function describeBundle(bundle: Bundle): BundleDescription {
  const resolved = resolveBundle(bundle);
  return {
    bundle: { id: bundle.id, name: bundle.name, description: bundle.description },
    hosts: hostsOf(bundle),
    cookieCount: resolved.cookies.length,
    warnings: resolved.errors.map((error) => `${error.profileId}: ${error.error}`),
  };
}

export const hostsOf = (bundle: Bundle): string[] =>
  [...new Set(resolveBundle(bundle).cookies.map((cookie) => bareDomain(cookie.domain)))].sort();

/** A request is in bounds when the bundle holds cookies for that host or its parent. */
export function hostAllowed(bundle: Bundle, hostname: string): boolean {
  return hostsOf(bundle).some(
    (host) => hostname === host || hostname.endsWith(`.${host}`) || host.endsWith(`.${hostname}`),
  );
}

export type CookieFormat = 'netscape' | 'storage-state' | 'json' | 'header';

export function exportCookies(bundle: Bundle, format: CookieFormat, url?: string): string {
  const { cookies } = resolveBundle(bundle);
  if (format === 'netscape') return toNetscape(cookies);
  if (format === 'storage-state') return toStorageState(cookies);
  if (format === 'header') {
    if (!url) throw new Error('a url is required for the header format');
    return cookieHeaderFor(cookies, url);
  }
  return JSON.stringify(
    cookies.map(({ profileId, browser, ...cookie }) => cookie),
    null,
    2,
  );
}

/** How much of a response body an agent should ever be handed at once. */
export const BODY_LIMIT = 1_000_000;

export interface ProxyRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /**
   * `html` is the response as it came. `text` strips a page down to its readable
   * content, which is what an agent almost always wants and a fraction of the
   * tokens.
   */
  as?: 'html' | 'text';
}

export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
  title?: string;
  /** Set when the reply was reduced to readable text, so the size is explainable. */
  extracted?: { from: number; to: number };
  /** Why an unauthorized response is not necessarily a broken bundle. */
  hint?: string;
}

export class OutOfBundleError extends Error {
  constructor(bundle: Bundle, hostname: string) {
    super(`bundle "${bundle.name}" holds no cookies for ${hostname}`);
  }
}

/**
 * Makes the request with the bundle's cookies attached. The caller never sees
 * them: this returns the response only, minus any `set-cookie`, so an agent may
 * use the session but not extend or capture it.
 */
export async function proxyRequest(bundle: Bundle, request: ProxyRequest): Promise<ProxyResponse> {
  let target: URL;
  try {
    target = new URL(request.url);
  } catch {
    throw new Error('invalid url');
  }
  if (!hostAllowed(bundle, target.hostname)) throw new OutOfBundleError(bundle, target.hostname);

  const cookie = cookieHeaderFor(resolveBundle(bundle).cookies, target.toString());
  const upstream = await fetch(target, {
    method: request.method ?? 'GET',
    headers: { ...(request.headers ?? {}), cookie },
    body: request.body,
    redirect: 'follow',
  });
  const raw = await upstream.text();
  const headers = Object.fromEntries([...upstream.headers].filter(([name]) => name !== 'set-cookie'));
  const hint = authHint(target, upstream.status, raw);

  if (request.as === 'text' && looksLikeHtml(raw, upstream.headers.get('content-type') ?? undefined)) {
    const page = readable(raw);
    return {
      status: upstream.status,
      headers,
      body: page.text,
      truncated: page.truncated,
      title: page.title,
      extracted: { from: page.originalBytes, to: page.text.length },
      hint,
    };
  }

  return {
    status: upstream.status,
    headers,
    body: raw.slice(0, BODY_LIMIT),
    truncated: raw.length > BODY_LIMIT,
    hint,
  };
}
