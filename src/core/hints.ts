/**
 * Why a request failed even though the cookies were right.
 *
 * Plenty of hosts serve their website from cookies and their API from a token,
 * so an agent using a bundle gets a bare 401 from `api.github.com` and concludes
 * the loan is broken. It is not: that endpoint simply does not accept a browser
 * session. Saying so costs one line and saves a retry loop.
 */

interface Hint {
  matches: (url: URL) => boolean;
  hint: string;
}

const HINTS: Hint[] = [
  {
    matches: (url) => url.hostname === 'api.github.com',
    hint: "github's REST API ignores browser cookies — it wants a personal access token. The github.com pages themselves work with this bundle.",
  },
  {
    matches: (url) => url.hostname === 'api.linear.app' || url.pathname.startsWith('/graphql'),
    hint: 'this looks like an API endpoint; some of them require an API key even when the website accepts your session.',
  },
  {
    matches: (url) => url.hostname.startsWith('api.'),
    hint: 'this is an API host — if it keeps refusing, it probably wants an API key rather than the website session in this bundle.',
  },
];

/**
 * A sentence to add to a 401/403 from upstream, or undefined when the failure
 * needs no explaining. Only unauthorized responses are annotated: a 403 on a
 * page you simply may not see is not a cookie problem either, but it is also
 * not something a token would fix.
 */
export function authHint(target: URL, status: number, body: string): string | undefined {
  if (status !== 401 && status !== 403) return undefined;
  const matched = HINTS.find((entry) => entry.matches(target));
  if (matched) return matched.hint;
  if (/requires? authentication|not authenticated|unauthorized|invalid.{0,10}token/i.test(body.slice(0, 2000))) {
    return 'the bundle sent its cookies and the host still refused: the session may have expired in the browser, or this endpoint wants an API key.';
  }
  return undefined;
}
