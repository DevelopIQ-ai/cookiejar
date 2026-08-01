import { profileHealth } from './browsers/index.js';
import { bareDomain, isExpired } from './bundles.js';
import type { BrowserId, CookieSelector, SourcedCookie } from './types.js';

/**
 * Turns the cookies already in a browser into bundles worth making. The point
 * is that nobody wants to hand an agent one site at a time: "everything I use
 * to book travel" is the unit people actually think in.
 */

export interface Category {
  id: string;
  name: string;
  description: string;
  /** Bare domains that belong to this category. */
  domains: string[];
}

export const CATEGORIES: Category[] = [
  {
    id: 'travel',
    name: 'travel',
    description: 'airlines, hotels, and booking sites — for an agent that checks in, rebooks, or hunts fares',
    domains: [
      'united.com', 'delta.com', 'aa.com', 'southwest.com', 'jetblue.com', 'alaskaair.com', 'flyfrontier.com',
      'spirit.com', 'britishairways.com', 'lufthansa.com', 'airfrance.com', 'klm.com', 'emirates.com',
      'qatarairways.com', 'singaporeair.com', 'cathaypacific.com', 'ana.co.jp', 'jal.co.jp', 'aircanada.com',
      'ryanair.com', 'easyjet.com', 'airindia.com', 'vistara.com',
      'booking.com', 'expedia.com', 'hotels.com', 'kayak.com', 'priceline.com', 'orbitz.com', 'skyscanner.net',
      'airbnb.com', 'vrbo.com', 'agoda.com', 'trip.com', 'makemytrip.com',
      'marriott.com', 'hilton.com', 'hyatt.com', 'ihg.com', 'accor.com', 'choicehotels.com', 'wyndhamhotels.com',
      'amtrak.com', 'thetrainline.com', 'raileurope.com', 'irctc.co.in',
      'hertz.com', 'avis.com', 'enterprise.com', 'turo.com',
      'tripit.com', 'seats.aero', 'pointsyeah.com', 'flightaware.com', 'global-entry.com', 'ttp.dhs.gov',
    ],
  },
  {
    id: 'work',
    name: 'work',
    description: 'issue trackers, docs, and chat — the tools an agent needs to actually do your job',
    domains: [
      'linear.app', 'github.com', 'gitlab.com', 'bitbucket.org', 'notion.so', 'slack.com', 'atlassian.net',
      'atlassian.com', 'asana.com', 'trello.com', 'monday.com', 'clickup.com', 'height.app', 'shortcut.com',
      'basecamp.com', 'figma.com', 'miro.com', 'loom.com', 'zoom.us', 'airtable.com', 'coda.io',
      'dropbox.com', 'box.com', 'confluence.com', 'productboard.com', 'pitch.com',
    ],
  },
  {
    id: 'dev',
    name: 'developer infrastructure',
    description: 'hosting, databases, and observability — for an agent that deploys or debugs',
    domains: [
      'vercel.com', 'netlify.com', 'cloudflare.com', 'aws.amazon.com', 'console.aws.amazon.com',
      'cloud.google.com', 'portal.azure.com', 'digitalocean.com', 'render.com', 'railway.app', 'fly.io',
      'heroku.com', 'supabase.com', 'planetscale.com', 'neon.tech', 'mongodb.com', 'redis.com',
      'npmjs.com', 'pypi.org', 'docker.com', 'sentry.io', 'datadoghq.com', 'posthog.com', 'grafana.com',
      'newrelic.com', 'circleci.com', 'buildkite.com', 'trigger.dev', 'upstash.com',
    ],
  },
  {
    id: 'finance',
    name: 'finance',
    description: 'banks, cards, and billing — treat this one carefully and prefer a proxy-only token',
    domains: [
      'chase.com', 'bankofamerica.com', 'wellsfargo.com', 'citi.com', 'americanexpress.com', 'capitalone.com',
      'discover.com', 'usbank.com', 'schwab.com', 'fidelity.com', 'vanguard.com', 'robinhood.com',
      'coinbase.com', 'kraken.com', 'stripe.com', 'paypal.com', 'wise.com', 'revolut.com', 'mercury.com',
      'brex.com', 'ramp.com', 'quickbooks.intuit.com', 'xero.com', 'gusto.com', 'ynab.com', 'mint.com',
    ],
  },
  {
    id: 'shopping',
    name: 'shopping and delivery',
    description: 'stores and delivery apps — order tracking, returns, price checks',
    domains: [
      'amazon.com', 'ebay.com', 'etsy.com', 'walmart.com', 'target.com', 'costco.com', 'bestbuy.com',
      'homedepot.com', 'ikea.com', 'wayfair.com', 'shopify.com', 'instacart.com', 'doordash.com',
      'ubereats.com', 'grubhub.com', 'uber.com', 'lyft.com',
    ],
  },
  {
    id: 'social',
    name: 'social',
    description: 'social networks and forums — posting, reading, or scraping your own feeds',
    domains: [
      'x.com', 'twitter.com', 'linkedin.com', 'reddit.com', 'facebook.com', 'instagram.com', 'threads.net',
      'bsky.app', 'tiktok.com', 'youtube.com', 'discord.com', 'substack.com', 'medium.com', 'news.ycombinator.com',
    ],
  },
  {
    id: 'ai',
    name: 'ai tools',
    description: 'model providers and AI products, for agents that drive other agents',
    domains: [
      'openai.com', 'chatgpt.com', 'claude.ai', 'anthropic.com', 'perplexity.ai', 'gemini.google.com',
      'huggingface.co', 'replicate.com', 'openrouter.ai', 'cursor.com', 'devin.ai', 'v0.dev',
    ],
  },
];

/** Cookie names that usually mean "this is the session", used to rank sites. */
const AUTH_HINTS = ['session', 'sess', 'sid', 'token', 'auth', 'login', 'logged', 'identity', 'jwt', 'csrf', 'account', 'user'];

export const looksLikeAuth = (name: string): boolean => {
  const lower = name.toLowerCase();
  return AUTH_HINTS.some((hint) => lower.includes(hint));
};

const categoryFor = (site: string): Category | undefined =>
  CATEGORIES.find((category) => category.domains.some((domain) => domain === site || site.endsWith(`.${domain}`)));

export interface SuggestedSite {
  site: string;
  profileId: string;
  cookieCount: number;
  /** Cookie names on this site that look like a session. */
  authNames: string[];
}

export interface Suggestion {
  categoryId: string;
  name: string;
  description: string;
  sites: SuggestedSite[];
  /** Ready to hand to createBundle: one selector per site, session cookies only. */
  selectors: CookieSelector[];
}

const site = (cookie: SourcedCookie): string => bareDomain(cookie.domain);

/**
 * Groups readable cookies into category bundles. A site only counts when it
 * has a cookie that looks like a session, so an analytics-only domain does not
 * end up in a bundle an agent would try to authenticate with.
 */
export function suggestBundles(browsers?: BrowserId[], profileIds?: string[]): Suggestion[] {
  const reads = profileHealth(profileIds, browsers).usable;
  const bySite = new Map<string, { site: string; profileId: string; names: Set<string>; auth: Set<string> }>();

  for (const read of reads) {
    for (const cookie of read.cookies) {
      if (isExpired(cookie)) continue;
      const key = `${cookie.profileId}\u0000${site(cookie)}`;
      const entry = bySite.get(key) ?? { site: site(cookie), profileId: cookie.profileId, names: new Set<string>(), auth: new Set<string>() };
      entry.names.add(cookie.name);
      if (looksLikeAuth(cookie.name)) entry.auth.add(cookie.name);
      bySite.set(key, entry);
    }
  }

  const grouped = new Map<string, SuggestedSite[]>();
  for (const entry of bySite.values()) {
    if (entry.auth.size === 0) continue;
    const category = categoryFor(entry.site);
    if (!category) continue;
    const list = grouped.get(category.id) ?? [];
    list.push({ site: entry.site, profileId: entry.profileId, cookieCount: entry.names.size, authNames: [...entry.auth].sort() });
    grouped.set(category.id, list);
  }

  return CATEGORIES.filter((category) => grouped.has(category.id)).map((category) => {
    const sites = grouped
      .get(category.id)!
      .sort((a, b) => b.authNames.length - a.authNames.length || a.site.localeCompare(b.site));
    return {
      categoryId: category.id,
      name: category.name,
      description: category.description,
      sites,
      selectors: sites.map(({ site: domain, profileId, authNames }) => ({ profileId, domain, names: authNames })),
    };
  });
}

export const findSuggestion = (suggestions: Suggestion[], id: string): Suggestion | undefined =>
  suggestions.find((suggestion) => suggestion.categoryId === id);
