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

## Prompts: `ask()` takes pipes, `askSecret()` is still TTY-only

Check `src/cli/prompt.ts` on the branch you are testing — this behaviour changed:

- **`ask()`** (browser picker, `--pick`, ambiguous-profile chooser, `bundle rm` confirm) reads piped
  stdin and falls back to `''` only on EOF. So `printf '1\n' | cj setup` really does pick browser 1,
  and `cj setup </dev/null` takes the default. Before that fix it returned `''` whenever stdin was not
  a TTY, which made piped tests silently no-op and *look* like passes.
- **`askSecret()`** (every password prompt) is still TTY-only and returns `''` off a TTY. Password
  guards (`<8` chars, mismatch, wrong-password retry) and the no-echo claim must run on a real PTY —
  an `exec`-style `tty: true` session, or a GUI terminal such as `konsole` when you need to *show*
  no-echo.

When in doubt, assert both paths: a piped answer must take effect, and EOF must take the documented
default. Useful deliberate assertions:

- `cj bundle rm <id> </dev/null` → prompt shown, **nothing deleted**; `printf 'y\n' | cj bundle rm <id>`
  → `deleted <id>`.
- `cj bundle add <id> <site> --all </dev/null` (site in two profiles) must refuse with
  `pass --profile <id> to choose a profile` and add nothing.

For the no-echo assertion: type the password, screenshot *before* pressing Enter, and confirm zero
characters (not even asterisks) appear after the prompt.

A command whose stdout you pipe (`cj status | head -4`) also swallows the `Master password:` prompt,
so the terminal looks hung when it is just waiting for input. Set `COOKIEJAR_PASSWORD` when you only
want the output.

## Capturing tokens in scripts

Tokens are `cjr_` + `base64url`, so they can contain `-` and `_`. **Do not** parse them with
`grep -o '^cjr_[A-Za-z0-9]*'` — it truncates silently and you end up testing a garbage token that
403s for the wrong reason (`unknown bundle token`), which can masquerade as a passing security test.

```bash
cj token new $B --label devin --days 30 >/tmp/tok.txt 2>/dev/null
T=$(grep -oE '^cjr_[A-Za-z0-9_-]+' /tmp/tok.txt)   # token
G=$(grep -oE '^[0-9a-f]{12}' /tmp/tok.txt | head -1)  # grant id
```

Bundle ids are **slugs**, not bare hex — `bundle new "agent demo"` yields `agent-demo-96c519`. Parse
them as `cj bundle new "x" | head -1 | awk '{print $2}'`; a `[0-9a-f]{12}` regex matches nothing.

`timeout` cannot resolve a shell alias/function, so `timeout 12 cj mcp` dies with
`No such file or directory`. Use the full `node <repo>/dist/cli.js` path inside `timeout`.

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

MCP: `COOKIEJAR_TOKEN=$T node dist/cli.js mcp` speaks newline-delimited JSON-RPC on stdio — send
`initialize`, then `tools/list`, then `tools/call` for `describe_bundle`, `get_cookie_header`,
`export_cookies`, `http_request`. Feed it from a `{ echo …; sleep 2; echo …; }` block piped into
`timeout 30 node dist/cli.js mcp`; it exits once stdin closes and in-flight calls finish. Tool errors
come back as `result.isError: true` with the daemon's message in `content[0].text`, **not** as a
JSON-RPC `error`, so assert on `isError`.

### Token state crosses processes — test it with `serve` left running

`cookiejar serve` holds the vault decrypted, but `Vault.read()` re-reads the file whenever another
process has replaced it, so terminal edits land live. Both of these used to fail and are worth
re-testing every time:

- A token issued by the CLI **after** the daemon started must work with no restart.
- `cookiejar token revoke` must return 403 on the very next request, and the grant must still read
  `revoked` on disk after the daemon has served more requests (the daemon's `noteUse()` write-back
  used to erase it). `/tmp/revoke-check.sh`-style scripts must capture the token with
  `grep -oE '^cjr_[A-Za-z0-9_-]+'` — `[A-Za-z0-9]*` truncates it and every request 403s for the
  wrong reason.
- Changing the master password while `serve` runs locks the daemon out. Note the **first** request
  after `cookiejar passwd` may come back `500 {"error":"vault is locked"}` rather than a 403:
  `authorize()` checks `vault.unlocked` before `vault.read()`, and `syncFromDisk()` locks *inside*
  `read()`, so a `VaultLockedError` escapes the `AccessDeniedError` branch in `src/server/index.ts`.
  Later requests give the correct 403. Assert the status you actually expect and treat a lone 500 as
  a (minor) defect, not a pass — no cookie values are served either way.

### Browser preference filtering (`--all`)

`sites`, `cookies <site>` and `bundle add` only read the browsers picked in `cookiejar setup`
(`chosenBrowsers()` in `src/cli/commands.ts`); `--all` opts out. `doctor` and `profiles` deliberately
still show everything. Consequences for tests:

- The discriminating check is `sites` vs `sites --all` — with Chrome-only picked, the Firefox-only
  site (`reddit.com`) must be absent from the first and present in the second, and `linear.app` must
  go from `1 cookie` to `2 cookies` across both profiles. If the two outputs are identical, the
  preference is not being enforced.
- **Cross-profile ambiguity tests now need `--all`.** With Chrome-only picked, `bundle add <id>
  linear.app` is unambiguous and just succeeds; only `--all` re-creates the two-profile conflict.
- Because they need the preference, `sites` and `cookies` now **open the vault**, i.e. they prompt
  for the master password. Set `COOKIEJAR_PASSWORD` for scripted runs. With it unset and stdin
  closed they fail cleanly (`could not unlock the jar`, exit 1) after printing
  `wrong master password` three times — noisy but not a hang.

### Proving `set-cookie` stripping properly

`https://github.com/robots.txt` returns no `set-cookie`, so proxying it proves nothing. Use
`https://github.com/` (sends ~3 `set-cookie` headers). Show the direct `curl -D -` count first, then
assert the `/agent/fetch` JSON `headers` object has no `set-cookie` key.

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
`--auto-lock 1` and idle ~70 s; a locked jar then answers
``403 cookiejar is locked; start it with `cookiejar serve` `` and `/health` reports `"unlocked":false`.

## Gotchas that look like bugs but are not

- A cookie seeded with `expires = 0` is a **session** cookie; `isExpired()` (`src/core/bundles.ts`)
  correctly does not flag it `expired`. `_gh_sess` is such a cookie.
- Netscape export prefixes httpOnly cookies with `#HttpOnly_`, so `grep -v '^#'` undercounts. Count
  with `grep -v '^# '` (note the space) or just parse the storage-state/json formats.
- A bundle with 3 selectors can legitimately report fewer unique *hosts*; `hosts` is de-duplicated
  bare domains, not a selector count.

## Things worth re-checking on any new branch

- `setup` says "cookiejar only reads the ones you pick", but the saved preference is not enforced —
  `doctor`/`sites`/`profiles` still read unpicked browsers. Verify whether this has been fixed.
- `src/mcp/server.ts` hardcodes `serverInfo.version`; it drifts from `package.json` after a bump.
- Stale daemons cause confusing cross-test failures. Always
  `pkill -f 'dist/cli.js serve'` before starting one, and confirm the port is free.
