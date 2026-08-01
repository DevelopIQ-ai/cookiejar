import { profileHealth, toMeta } from '../core/browsers/index.js';
import { bareDomain, domainCovers, isExpired, resolveBundle } from '../core/bundles.js';
import {
  addSelector,
  createBundle,
  grantId,
  isLive,
  issueGrant,
  removeSelector,
  revokeGrant,
  updateBundle,
} from '../core/manage.js';
import { suggestBundles } from '../core/suggest.js';
import type { BrowserId } from '../core/types.js';
import type { Vault } from '../core/vault.js';

/**
 * The tools an agent running on *your* machine gets: enough to keep a bundle
 * tidy without you opening the UI. It can see which sites you are signed into
 * and which cookie names exist, and it can change bundle membership — it can
 * never read a cookie value, because nothing here returns one.
 */
export const MANAGE_TOOLS = [
  {
    name: 'list_sites',
    description: 'List the sites the user is signed into, with how many cookies each has and which browser profile they came from.',
    inputSchema: {
      type: 'object',
      properties: { filter: { type: 'string', description: 'Only sites containing this text.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'list_cookies',
    description: 'List the cookie names and flags for one site. Values are never returned.',
    inputSchema: {
      type: 'object',
      properties: { site: { type: 'string' }, profileId: { type: 'string' } },
      required: ['site'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_bundles',
    description: 'List the bundles in the jar, with their sites and how many tokens are live.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'show_bundle',
    description: 'Show one bundle: its selectors, what they resolve to right now, and its tokens.',
    inputSchema: {
      type: 'object',
      properties: { bundleId: { type: 'string' } },
      required: ['bundleId'],
      additionalProperties: false,
    },
  },
  {
    name: 'suggest_bundles',
    description: 'Group the signed-in sites into bundles worth making (travel, work, dev, finance, shopping, social, ai). Suggests only; creates nothing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create_bundle',
    description: 'Create a bundle. Pass a categoryId from suggest_bundles to fill it in, or leave it empty and add sites yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        fromSuggestion: { type: 'string', description: 'A categoryId from suggest_bundles.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_site',
    description: 'Add a site to a bundle. Omit names to track every cookie the site has, which survives the site renaming its session cookie.',
    inputSchema: {
      type: 'object',
      properties: {
        bundleId: { type: 'string' },
        site: { type: 'string' },
        profileId: { type: 'string' },
        names: { type: 'array', items: { type: 'string' } },
      },
      required: ['bundleId', 'site'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_site',
    description: 'Remove a site from a bundle.',
    inputSchema: {
      type: 'object',
      properties: { bundleId: { type: 'string' }, site: { type: 'string' }, profileId: { type: 'string' } },
      required: ['bundleId', 'site'],
      additionalProperties: false,
    },
  },
  {
    name: 'rename_bundle',
    description: 'Rename a bundle or change its description.',
    inputSchema: {
      type: 'object',
      properties: { bundleId: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } },
      required: ['bundleId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_tokens',
    description: 'Every token the jar has handed out, with its state and use count. Token values are not stored and cannot be shown again.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'issue_token',
    description: 'Mint a token for a bundle. Returned once. Keep proxyOnly true unless the user asks for raw cookie values.',
    inputSchema: {
      type: 'object',
      properties: {
        bundleId: { type: 'string' },
        label: { type: 'string' },
        minutes: { type: 'number', description: 'Lifetime in minutes. Default 60.' },
        proxyOnly: { type: 'boolean', default: true },
      },
      required: ['bundleId'],
      additionalProperties: false,
    },
  },
  {
    name: 'revoke_token',
    description: 'Revoke one token, or every live token in a bundle when tokenId is omitted.',
    inputSchema: {
      type: 'object',
      properties: { bundleId: { type: 'string' }, tokenId: { type: 'string' } },
      required: ['bundleId'],
      additionalProperties: false,
    },
  },
] as const;

const str = (value: unknown): string => String(value ?? '');

/** Required arguments, named in the error: an agent that forgot one should be told which. */
const need = (args: Record<string, unknown>, field: string): string => {
  const value = args[field];
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} is required`);
  return value;
};

function chosen(vault: Vault): BrowserId[] | undefined {
  const preferences = vault.read().preferences;
  return preferences?.onboardedAt && preferences.browsers.length > 0 ? preferences.browsers : undefined;
}

export async function runManageTool(vault: Vault, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'list_sites': {
      const filter = args.filter ? str(args.filter).toLowerCase() : undefined;
      const sites = new Map<string, { cookies: number; profiles: Set<string> }>();
      for (const read of profileHealth(undefined, chosen(vault)).usable) {
        for (const cookie of read.cookies) {
          const site = bareDomain(cookie.domain);
          if (filter && !site.includes(filter)) continue;
          const entry = sites.get(site) ?? { cookies: 0, profiles: new Set<string>() };
          entry.cookies += 1;
          entry.profiles.add(cookie.profileId);
          sites.set(site, entry);
        }
      }
      return [...sites.entries()]
        .sort((a, b) => b[1].cookies - a[1].cookies || a[0].localeCompare(b[0]))
        .map(([site, entry]) => ({ site, cookies: entry.cookies, profiles: [...entry.profiles] }));
    }

    case 'list_cookies': {
      const site = need(args, 'site');
      return profileHealth(args.profileId ? [str(args.profileId)] : undefined, chosen(vault))
        .usable.flatMap((read) => read.cookies)
        .filter((cookie) => domainCovers(site, cookie.domain))
        .map(toMeta)
        .map((cookie) => ({
          name: cookie.name,
          domain: cookie.domain,
          profileId: cookie.profileId,
          httpOnly: cookie.httpOnly,
          secure: cookie.secure,
          expired: isExpired(cookie),
        }));
    }

    case 'list_bundles':
      return vault.read().bundles.map((bundle) => ({
        id: bundle.id,
        name: bundle.name,
        description: bundle.description,
        sites: [...new Set(bundle.selectors.map((s) => s.domain))],
        liveTokens: bundle.grants.filter(isLive).length,
      }));

    case 'show_bundle': {
      const bundle = vault.bundle(need(args, 'bundleId'));
      const resolved = resolveBundle(bundle);
      return {
        id: bundle.id,
        name: bundle.name,
        description: bundle.description,
        selectors: bundle.selectors,
        resolves: resolved.cookies.map(toMeta).map(({ name: cookieName, domain, profileId }) => ({ name: cookieName, domain, profileId })),
        emptySelectors: resolved.emptySelectors,
        warnings: resolved.errors.map((error) => `${error.profileId}: ${error.error}`),
        tokens: bundle.grants.map((grant) => ({
          id: grantId(grant),
          label: grant.label,
          revoked: Boolean(grant.revokedAt),
          expiresAt: grant.expiresAt,
          proxyOnly: grant.redactValues,
          useCount: grant.useCount,
        })),
      };
    }

    case 'suggest_bundles':
      return suggestBundles(chosen(vault)).map((suggestion) => ({
        categoryId: suggestion.categoryId,
        name: suggestion.name,
        description: suggestion.description,
        sites: suggestion.sites,
      }));

    case 'create_bundle': {
      const from = args.fromSuggestion ? str(args.fromSuggestion) : undefined;
      const suggestion = from ? suggestBundles(chosen(vault)).find((s) => s.categoryId === from) : undefined;
      if (from && !suggestion) throw new Error(`no suggestion called ${from}`);
      const bundle = createBundle(vault, {
        name: need(args, 'name'),
        description: args.description ? str(args.description) : suggestion?.description,
        selectors: suggestion?.selectors,
      });
      return { id: bundle.id, name: bundle.name, sites: bundle.selectors.map((s) => s.domain) };
    }

    case 'add_site': {
      const site = need(args, 'site');
      const names = Array.isArray(args.names) ? args.names.map(str) : [];
      let profileId = args.profileId ? str(args.profileId) : undefined;
      if (!profileId) {
        const holders = [
          ...new Set(
            profileHealth(undefined, chosen(vault))
              .usable.flatMap((read) => read.cookies)
              .filter((cookie) => domainCovers(site, cookie.domain))
              .map((cookie) => cookie.profileId),
          ),
        ];
        if (holders.length === 0) throw new Error(`no cookies for ${site} — the user may not be signed in`);
        if (holders.length > 1) throw new Error(`${site} is signed in on ${holders.join(', ')} — pass profileId`);
        profileId = holders[0];
      }
      const bundle = addSelector(vault, need(args, 'bundleId'), { profileId, domain: site, names });
      return { id: bundle.id, sites: bundle.selectors.map((s) => s.domain) };
    }

    case 'remove_site': {
      const bundle = removeSelector(vault, need(args, 'bundleId'), need(args, 'site'), args.profileId ? str(args.profileId) : undefined);
      return { id: bundle.id, sites: bundle.selectors.map((s) => s.domain) };
    }

    case 'rename_bundle': {
      const bundle = updateBundle(vault, need(args, 'bundleId'), {
        name: args.name ? str(args.name) : undefined,
        description: args.description === undefined ? undefined : str(args.description),
      });
      return { id: bundle.id, name: bundle.name, description: bundle.description };
    }

    case 'list_tokens':
      return vault.read().bundles.flatMap((bundle) =>
        bundle.grants.map((grant) => ({
          id: grantId(grant),
          bundleId: bundle.id,
          label: grant.label,
          revoked: Boolean(grant.revokedAt),
          expiresAt: grant.expiresAt,
          proxyOnly: grant.redactValues,
          useCount: grant.useCount,
          lastUsedAt: grant.lastUsedAt,
        })),
      );

    case 'issue_token': {
      const minutes = typeof args.minutes === 'number' ? args.minutes : 60;
      const { token, grant } = issueGrant(vault, need(args, 'bundleId'), {
        label: args.label ? str(args.label) : 'agent',
        expiresInDays: minutes / 1440,
        allowFetch: true,
        redactValues: args.proxyOnly !== false,
      });
      return {
        token,
        id: grantId(grant),
        expiresAt: grant.expiresAt,
        proxyOnly: grant.redactValues,
        note: 'Shown once. It only works while cookiejar serve (or cookiejar lend) is running.',
      };
    }

    case 'revoke_token': {
      const bundleId = need(args, 'bundleId');
      if (args.tokenId) {
        const grant = revokeGrant(vault, bundleId, need(args, 'tokenId'));
        return { revoked: [grantId(grant)] };
      }
      const live = vault.bundle(bundleId).grants.filter(isLive);
      for (const grant of live) revokeGrant(vault, bundleId, grantId(grant));
      return { revoked: live.map(grantId) };
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
