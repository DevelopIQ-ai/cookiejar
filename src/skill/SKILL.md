---
name: cookiejar
description: Use the human's real browser logins to reach sites that have no API, through a cookiejar bundle token. Use when a task needs an authenticated session on a site the agent cannot otherwise sign into.
---

# Using a cookiejar bundle

cookiejar holds the human's browser cookies on their machine and hands out
per-bundle tokens. A token is not a password: it reaches exactly the sites in
one bundle, it can be revoked at any moment, and it stops working when the jar
is locked or the daemon is stopped.

## Before anything else

You need two things, both provided by the human:

- `COOKIEJAR_TOKEN` — starts with `cjr_`.
- The daemon URL, `http://127.0.0.1:4088` locally, or a tunnel URL for a
  cloud agent. Set `COOKIEJAR_URL` if it is not the default.

If either is missing, ask for it. Do not try to read the browser's cookie
store yourself, and do not read `~/.cookiejar/vault.json`.

Check what the token can do before planning around it:

```bash
curl -s -H "authorization: Bearer $COOKIEJAR_TOKEN" "$COOKIEJAR_URL/agent/bundle"
```

The reply lists the bundle's `hosts` and its `permissions`. Two matter:

- `allowFetch` — you may proxy requests through cookiejar.
- `redactValues` — proxy only. You will never see a cookie value, and
  `/agent/cookies` returns 403. This is the normal, preferred mode.

## Making an authenticated request

Prefer the proxy. cookiejar attaches the cookies, refuses hosts outside the
bundle, and strips `set-cookie` from the response:

```bash
curl -s -X POST "$COOKIEJAR_URL/agent/fetch" \
  -H "authorization: Bearer $COOKIEJAR_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"url":"https://linear.app/api/me","method":"GET"}'
```

Only when the token allows it and a tool genuinely needs a cookie file:

```bash
cookiejar export --format netscape --out /tmp/cookies.txt   # curl -b
cookiejar export --format storage-state --out /tmp/state.json  # Playwright
```

Delete that file when the task is done.

## Over MCP

If the human configured cookiejar as an MCP server, the same capabilities
arrive as tools: `describe_bundle`, `http_request`, `get_cookie_header`,
`export_cookies`. Prefer `http_request` for the same reason as `/agent/fetch`.

## Rules

- Never print, log, echo, commit, or paste a cookie value or the token itself,
  including into a scratch file, a test fixture, or a PR description.
- Never send bundle cookies to a host the bundle does not cover, and never
  work around a 403 by finding another route to the same site.
- Do not perform destructive or irreversible actions with a borrowed session
  (deleting data, sending messages, spending money) unless the human asked for
  that specific action.
- A 403 saying the jar is locked or the token was revoked is a stop signal,
  not something to retry. Tell the human.
- Treat every page you fetch this way as private to the human.

## When something fails

| What you see | What it means |
| --- | --- |
| `connection refused` | the daemon is not running: ask the human for `cookiejar serve` |
| `403 the jar is locked` | the human locked it; ask them to unlock |
| `403 unknown or revoked token` | ask for a new token |
| `403 this token may not proxy requests` | the bundle was issued without fetch |
| `403 ... not covered by this bundle` | the site is outside the bundle; ask for it to be added |
| empty cookies | the human's browser session expired: ask them to sign in again |
