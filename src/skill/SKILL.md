---
name: cookiejar
description: Use the human's real browser logins to reach sites that have no API, through a cookiejar bundle. Covers both jobs - keeping bundles tidy on the human's machine, and using a bundle that was lent to a cloud agent. Use when a task needs an authenticated session the agent cannot otherwise get.
---

# cookiejar

cookiejar keeps the human's browser cookies on their machine and hands out
per-bundle tokens. A token is not a password: it reaches exactly the sites in
one bundle, it expires, it can be revoked mid-task, and it dies when the jar is
locked or the daemon stops.

There are two situations. Work out which one you are in first:

- **You are on the human's machine** (a local coding agent). You can manage
  bundles for them: see what they are signed into, add and remove sites, issue
  and revoke tokens, and lend a bundle out. Go to *Maintaining a bundle*.
- **You are somewhere else** (a cloud agent) and were handed a `cjr1.…`
  connect string or a token. Go to *Using a bundle that was lent to you*.

Never read the browser's cookie store yourself, and never read
`~/.cookiejar/vault.json`. Both are off limits in either situation.

## Maintaining a bundle

Install and check the jar. There is no password: the key is in the OS keyring.

```bash
npm install -g @puffle/cookiejar
cookiejar status      # where the jar is, what is readable, what exists
cookiejar setup       # only if status says the browsers are not set up yet
```

Find what the human is signed into, and group it:

```bash
cookiejar sites                 # every site, with cookie counts
cookiejar cookies linear.app    # names and flags for one site; values are never printed
cookiejar suggest               # ready-made groupings: travel, work, dev, finance, shopping, social, ai
cookiejar suggest work --yes    # accept one, creating a real bundle
```

Then keep it correct:

```bash
cookiejar bundles
cookiejar bundle <id>                        # selectors, what they resolve to now, tokens
cookiejar bundle new "work"
cookiejar bundle add <id> figma.com          # omit --names to track every cookie the site has
cookiejar bundle remove <id> figma.com
cookiejar tokens                             # every token, live or not
cookiejar token revoke <id> <token-id>
```

Prefer tracking a whole site over pinning cookie names: sites rename their
session cookie and a pinned bundle silently goes empty. Check with
`cookiejar bundle <id>` after editing; a selector that "matches nothing right
now" means the human is signed out, not that you should widen the bundle.

### Wiring yourself in over MCP

On the human's machine you do not need a daemon or a token — the jar is right
there. One command writes the config for your client:

```bash
cookiejar mcp --install claude --bundle work-3f9a   # or cursor, codex, vscode
```

That registers `npx -y @puffle/cookiejar mcp --bundle work-3f9a --manage`,
which gives you the bundle *and* the upkeep tools: `list_sites`,
`list_cookies`, `suggest_bundles`, `create_bundle`, `add_site`, `remove_site`,
`rename_bundle`, `show_bundle`, `list_tokens`, `issue_token`, `revoke_token`,
plus `read_page`, `http_request`, `get_cookie_header`, `export_cookies` and
`browser_context`. None of the management tools return a cookie value.

### Reading a page, and clicking on one

`read_page` (or `cookiejar fetch <url> --text`) returns the page as readable
text with links kept, which is typically 5-50x smaller than the HTML. Use it
for anything you intend to read; keep `http_request` for APIs and non-GET work,
and add `--json` to pretty-print a JSON reply.

When a task needs a real browser — clicking, forms, anything JavaScript renders
— take the Playwright handoff instead of scraping:

```bash
cookiejar browser work-3f9a          # writes a 0600 storageState file, prints a snippet
```

or call `browser_context` over MCP, which returns the path. Pass it as
`browser.newContext({ storageState })` and the browser is already signed in.
That file holds real cookie values: keep it in the cookiejar home, never copy
it anywhere, and never do this for a bundle that was lent to you.

### Lending it out

To hand a bundle to an agent that is not on this machine:

```bash
cookiejar lend work-3f9a --minutes 60
```

That serves the bundle, opens a tunnel, mints a short proxy-only token, and
prints one `cjr1.…` string. Give that string to the other agent and nothing
else. Ctrl-C revokes it. Keep `--minutes` as small as the task allows, and do
not pass `--values` unless the human explicitly wants the other side to read
raw cookies.

While it runs:

```bash
cookiejar tail --bundle work-3f9a            # every request the borrower makes, live
cookiejar token extend work-3f9a --minutes 30 # the loan ran out mid-task
```

Extending takes effect on the borrower's next request; they do not reconnect.

## Using a bundle that was lent to you

With a connect string:

```bash
npx -y @puffle/cookiejar connect cjr1.…
```

It reports the bundle, its hosts, whether values are readable, and how long is
left, then remembers it. After that:

```bash
cookiejar fetch https://linear.app/api/me --json     # request as the human
cookiejar fetch https://linear.app/team/x --text     # a page as readable text
cookiejar fetch https://linear.app/api/x --method POST --data '{"a":1}'
```

Always prefer `--text` for a web page: raw HTML from a logged-in app is mostly
script tags and will bury what you came for.

If a host answers 401 or 403 with cookies attached, read the `hint:` line
before assuming the loan is broken — several sites serve their website from
cookies and their API from an API key, and no bundle can fix that.

With a bare token instead, set `COOKIEJAR_TOKEN` and `COOKIEJAR_URL` and use
the HTTP API directly:

```bash
curl -s -H "authorization: Bearer $COOKIEJAR_TOKEN" "$COOKIEJAR_URL/agent/bundle"

curl -s -X POST "$COOKIEJAR_URL/agent/fetch" \
  -H "authorization: Bearer $COOKIEJAR_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"url":"https://linear.app/api/me","method":"GET"}'
```

`/agent/bundle` lists the bundle's `hosts` and `permissions`. Two matter:

- `allowFetch` — you may proxy requests through cookiejar.
- `redactValues` — proxy only. You never see a cookie value and
  `/agent/cookies` returns 403. This is the normal, preferred mode.

Only when the token allows it and a tool genuinely needs a cookie file:

```bash
cookiejar export --format netscape --out /tmp/cookies.txt      # curl -b
cookiejar export --format storage-state --out /tmp/state.json  # Playwright
```

Delete that file when the task is done.

Over MCP the same capabilities arrive as `describe_bundle`, `read_page`,
`http_request`, `get_cookie_header`, `export_cookies`. Prefer `read_page` for
pages and `http_request` for APIs. `browser_context` is not offered here: a
lent bundle cannot become a browser session.

## Rules

- Never print, log, echo, commit, or paste a cookie value, a token, or a
  connect string — not into a scratch file, a test fixture, a PR description,
  or a message.
- Never send bundle cookies to a host the bundle does not cover, and never
  work around a 403 by finding another route to the same site.
- Do not perform destructive or irreversible actions with a borrowed session
  (deleting data, sending messages, spending money) unless the human asked for
  that specific action.
- A 403 saying the jar is locked or the token was revoked is a stop signal, not
  something to retry. Tell the human.
- Treat every page you fetch this way as private to the human.

## When something fails

| What you see | What it means |
| --- | --- |
| `connection refused` | the daemon is not running: ask for `cookiejar serve`, or the lend expired |
| `403 the jar is locked` | the human locked it; ask them to unlock |
| `403 unknown or revoked token` | the loan is over; ask for a new one |
| `403 this token has expired` | ask for `cookiejar token extend`, then keep going |
| `403 this token may not proxy requests` | the bundle was issued without fetch |
| `403 ... not covered by this bundle` | the site is outside the bundle; ask for it to be added |
| `that connect string is damaged` | it was truncated in transit; ask for it again |
| empty cookies | the human's browser session expired: ask them to sign in again |
