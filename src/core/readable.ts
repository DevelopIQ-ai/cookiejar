/**
 * Turning a page into something an agent can afford to read.
 *
 * A logged-in page is mostly chrome: script tags, inlined state, nav. Handing
 * all of it to a model costs a fortune and buries the three lines that mattered,
 * so this reduces HTML to text with the structure that carries meaning — links,
 * headings, list items — and nothing else. It is deliberately regex-based: a
 * DOM parser would be a runtime dependency, and cookiejar has none.
 */

const BLOCK = /^(p|div|section|article|main|header|footer|nav|aside|ul|ol|li|dl|dt|dd|table|tr|thead|tbody|form|fieldset|figure|figcaption|blockquote|pre|hr|br|h[1-6])$/i;

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#x27': "'",
  '#x2F': '/',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name: string) => {
    const known = ENTITIES[name] ?? ENTITIES[name.toLowerCase()];
    if (known) return known;
    if (name.startsWith('#x') || name.startsWith('#X')) {
      const code = Number.parseInt(name.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (name.startsWith('#')) {
      const code = Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return whole;
  });
}

export function pageTitle(html: string): string | undefined {
  const found = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = found ? decodeEntities(found[1]).replace(/\s+/g, ' ').trim() : '';
  return title || undefined;
}

/**
 * The whole page as plain text. Headings keep their `#`, links keep their href
 * so an agent can navigate, and everything invisible is dropped.
 */
export function htmlToText(html: string, opts: { links?: boolean } = {}): string {
  const links = opts.links ?? true;
  let text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<![^>]*>/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    // Unclosed script/style at the end of a truncated body would swallow nothing
    // otherwise, so drop a dangling open tag too.
    .replace(/<(script|style)\b[^>]*>[\s\S]*$/i, ' ');

  text = text.replace(/<h([1-6])[^>]*>/gi, (_whole, level: string) => `\n\n${'#'.repeat(Number(level))} `);
  text = text.replace(/<li[^>]*>/gi, '\n- ');

  if (links) {
    text = text.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_whole, href: string, inner: string) => {
      const label = decodeEntities(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      if (!label) return ' ';
      if (href.startsWith('javascript:') || href === '#') return ` ${label} `;
      return ` [${label}](${href}) `;
    });
  }

  text = text.replace(/<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g, (_whole, tag: string) => (BLOCK.test(tag) ? '\n' : ' '));
  text = decodeEntities(text);

  return text
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface Readable {
  title?: string;
  text: string;
  /** Set when the text was cut to fit a budget, so the agent knows to narrow. */
  truncated: boolean;
  /** How much was thrown away, which is the whole point of the mode. */
  originalBytes: number;
  bytes: number;
}

export function readable(html: string, opts: { limit?: number; links?: boolean } = {}): Readable {
  const limit = opts.limit ?? 20_000;
  const full = htmlToText(html, { links: opts.links });
  const cut = full.length > limit;
  return {
    title: pageTitle(html),
    text: cut ? `${full.slice(0, limit)}\n\n… cut here; ${full.length - limit} more characters.` : full,
    truncated: cut,
    originalBytes: html.length,
    bytes: full.length,
  };
}

const JSONISH = /^\s*[[{]/;

/** True for a body worth handing over verbatim: JSON is already agent-readable. */
export const looksLikeJson = (body: string, contentType?: string): boolean =>
  (contentType ?? '').includes('json') || JSONISH.test(body);

export const looksLikeHtml = (body: string, contentType?: string): boolean =>
  (contentType ?? '').includes('html') || /^\s*(<!doctype html|<html)/i.test(body);
