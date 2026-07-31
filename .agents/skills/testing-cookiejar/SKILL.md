---
name: testing-cookiejar
description: How to build, seed, and manually test the cookiejar CLI and its agent daemon (vault, cookie picking, bundles, agent tokens, /agent/* HTTP API) without touching real browser data.
---

# Testing cookiejar locally

cookiejar is a Node 22 + TypeScript **CLI** (`dist/cli.js`). There is no UI. `cookiejar serve` starts
a loopback daemon that answers bundle tokens on `/agent/*` (plus `/health`) and 404s everything else.
Everything is local; no accounts and no secrets are needed to test it.

## Devin Secrets Needed

None. Testing runs entirely on 127.0.0.1 against seeded fake browser profiles.

## Build

```bash
cd <repo> && npm install && npm run build   # builds dist/
node -v   # must be >= 22.5 (node:sqlite is used to read cookie stores)
```

## NEVER use real browser data — seed fake profiles

```bash
node scripts/seed-demo-profile.mjs /tmp/cjdemo
export HOME=/tmp/cjdemo COOKIEJAR_HOME=/tmp/cjdemo/.cookiejar COOKIEJAR_PASSWORD=demo-password-1
```

This writes a fake Chrome store (`$HOME/.config/google-chrome/Default/Cookies`, plaintext values, 11
cookies over github.com / linear.app / notion.so / stripe.com / …) and a fake Firefox store
(`$HOME/.mozilla/firefox/abcd1234.demo/cookies.sqlite`, 2 cookies incl. a *second* `linear.app
__session`). The overlapping `linear.app` cookie is what makes cross-profile selection testable.

- `HOME=` points the browser readers at the seeded profiles; `COOKIEJAR_HOME=` isolates the vault and
  audit log. `COOKIEJAR_PASSWORD=` skips the password prompt — otherwise every jar command prompts
  on the TTY, which is what you want to test at least once.
- Clean slate: `rm -rf /tmp/cjdemo` then re-seed.
- Sanity check: `node dist/cli.js doctor` prints `✓ Chrome — Personal (chrome:Default) — 11 cookies…`
  and the Firefox profile.

## CLI paths worth exercising

```bash
cj() { node dist/cli.js "$@"; }
echo "" | cj setup                  # browser picker; enter = all
cj status; cj doctor; cj profiles
cj sites; cj sites --filter linear
cj cookies linear.app               # metadata only — grep the output for a seeded value, expect 0
cj bundle new "linear agent"
cj bundle add <id> linear.app --profile chrome:Default        # --pick for interactive, --names a,b
cj bundle <id>; cj bundles
cj token new <id> --label devin --days 7 --proxy-only         # token printed once
cj export --bundle <id> --format netscape|storage-state|json  # no daemon, no token
cj header --bundle <id> --url-target https://linear.app/team
cj share <id> --tunnel https://example.trycloudflare.com
cj activity; cj token revoke <id> <token-id>; cj bundle rm <id> --force
```

Adding a site that exists in two profiles without `--profile` must refuse and list the profiles.

## Agent-side checks

The daemon dies when the spawning shell exits, so start it detached:

```bash
(setsid nohup env HOME=/tmp/cjdemo COOKIEJAR_HOME=/tmp/cjdemo/.cookiejar \
   COOKIEJAR_PASSWORD=demo-password-1 node dist/cli.js serve --port 4088 \
   >/tmp/cj.log 2>&1 </dev/null &)
curl -s 127.0.0.1:4088/health        # {"ok":true,...}
export T=cjr_…
curl -s -H "Authorization: Bearer $T" 127.0.0.1:4088/agent/bundle
curl -s -H "Authorization: Bearer $T" '127.0.0.1:4088/agent/cookies?format=netscape'
curl -s -X POST -H "Authorization: Bearer $T" -H 'content-type: application/json' \
     -d '{"url":"https://github.com/robots.txt"}' 127.0.0.1:4088/agent/fetch
```

MCP: `COOKIEJAR_TOKEN=$T node dist/cli.js mcp` speaks JSON-RPC on stdio — send `initialize`, then
`tools/list`, then a `tools/call` for `describe_bundle`.

Expected refusals (assert the message, not just the status): `unknown bundle token`,
`missing bundle token`, `this token was revoked`, `cookiejar is locked; start it with cookiejar serve`,
`bundle "<name>" holds no cookies for <host>` (out-of-bundle `/agent/fetch`),
`this token cannot read cookie values; use /agent/fetch instead` (a `--proxy-only` grant).
`/agent/fetch` responses strip `set-cookie` — assert that key is absent. `GET /api/bundles` and `/`
must 404: management is CLI-only.

## Audit / vault assertions

`grep -o '"event":"[a-z_]*"' $COOKIEJAR_HOME/audit.log | sort | uniq -c` should cover `unlock`,
`bundle_saved`, `bundle_deleted`, `grant_created`, `grant_revoked`, `bundle_read`, `bundle_fetch`.
Grepping `audit.log` and `vault.json` for the seeded cookie values or `cjr_` must return 0 matches —
that is the core privacy claim.

## Known environment limitations

Real Chromium keyring/Keychain (`v10`/`v11`) decryption and the Safari `Cookies.binarycookies` parser
cannot be exercised on a headless Linux box (no keyring, no Safari). Only the seeded plaintext
Chromium-SQLite and Firefox readers are verifiable here; say so rather than claiming browser support
was proven. Auto-lock is impractical to wait out at the 30-minute default — start the daemon with
`--auto-lock 1` if it matters.
