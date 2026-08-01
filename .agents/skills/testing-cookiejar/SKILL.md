---
name: testing-cookiejar
description: How to build, seed, and manually test the cookiejar CLI, its local UI, its agent daemon and the lend/connect borrowing flow (vault, keyring, cookie picking, bundles, agent tokens, /agent/* HTTP API, MCP) without touching real browser data.
---

# Testing cookiejar locally

cookiejar is a Node 22 + TypeScript CLI (`dist/cli.js`). `cookiejar serve` starts a loopback daemon
that answers bundle tokens on `/agent/*` (plus `/health`). Depending on the branch there may also be
a local UI (`cookiejar ui`) and a one-command lending flow (`cookiejar lend` / `connect` / `fetch`).
Everything is local; no accounts and no secrets are needed to test it.

**Check the surface before planning.** This repo has repeatedly added and removed surfaces: a React
UI existed, was deleted in PR #5 (CLI-only), and a new server-rendered UI plus a Tokens tab returned
in PR #15. Run `node dist/cli.js help` on the branch under test and plan from that, not from memory.

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
export HOME=/tmp/cjdemo COOKIEJAR_HOME=/tmp/cjdemo/.cookiejar
export COOKIEJAR_KEYRING=file          # keyring-backed branches; no Keychain/libsecret on Linux CI
# older, password-protected branches also need: export COOKIEJAR_PASSWORD=demo-password-1
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

## Keyring-backed vaults: nothing should prompt

On branches with `src/core/keyring.ts`, the jar is protected by a random secret in a keyring instead
of a master password, and **`COOKIEJAR_PASSWORD` must stay unset** — setting it silently takes the
old password path and invalidates the whole "nothing prompts" claim.

- `COOKIEJAR_KEYRING=file` forces the file backend (`$COOKIEJAR_HOME/key`, mode 0600). It is required
  on a headless Linux box: `keyring()` otherwise wants `security` (macOS) or `secret-tool`.
- Assert with **stdin closed** (`</dev/null`), never a TTY — that is what proves nothing is waiting on
  input. The first command should print `created …/vault.json — the key is in …/key`.
- Discriminating checks: `vault.json` contains `"protection": "keyring"`; both `vault.json` and `key`
  are mode 0600; `grep -c -F` over `vault.json` for `github`, `localhost`, `user_session`, `bundle`,
  `chrome:Default` and the bundle *name* must all be **0** (it is one AES-GCM blob).
- `passwd` round-trip: `COOKIEJAR_PASSWORD=x cookiejar passwd` → `"protection": "password"` and the
  key file is **gone**; a bare `status` with no password must then *fail* rather than open (that is the
  half that catches a broken transition); `COOKIEJAR_PASSWORD=x cookiejar passwd --none` restores
  keyring protection and the 0600 key. Always re-check `bundles` after both hops — a re-key that drops
  `data` shows up as 0 bundles.
- `reset --force` must delete `vault.json`, `audit.log` **and** the key file.

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

Tokens are `cjr_` + base64url and **connect strings are `cjr1.` + base64url**, so both can contain `-`
and `_`. Use `grep -oE 'cjr1\.[A-Za-z0-9_-]+'` for connect strings. **Do not** parse them with
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

## Lend / connect: use two HOMEs, and make the proxy test falsifiable

`cookiejar lend <bundle> --local --minutes 5` starts a daemon, issues a short proxy-only grant, prints
one `cjr1.…` connect string, and revokes the grant on SIGINT. Without `--local` it downloads and spawns
`cloudflared` — usually impossible/forbidden in CI, so say the tunnel path is **untested** rather than
implying it works.

Model the borrower as a genuinely separate machine: a second `HOME` (`/tmp/cjagent`) with its own
`COOKIEJAR_HOME` and **no vault**. `connect` writes `connection.json` (0600) there; the lender HOME must
never get one. Then `cookiejar fetch <url>` and `cookiejar mcp` work with no flags.

Two traps that make the proxy test prove nothing unless you plan for them:

- `cookieHeaderFor` (`src/core/bundles.ts`) drops `secure` cookies over plain `http://`. The seeded
  profile has only secure cookies, so add a **non-secure fake cookie** for a host you control (e.g.
  `localhost demo_local_session=…`) or the proxied request goes out with an empty cookie header and
  still returns 200.
- Run your own throwaway upstream (a ~20-line node http server) that echoes the `Cookie` header it
  received *and* always sends `set-cookie: …`. Echoing the cookie is how you prove the daemon attached
  the lender's cookie (a broken pass-through prints `signed in as: (none)`), and always setting a
  cookie is how "`set-cookie` is stripped" becomes falsifiable. Public URLs like
  `https://github.com/robots.txt` prove neither.

Adversarial cases that all have distinct messages worth asserting: a truncated `cjr1.…`
(`that connect string is damaged`), a non-`cjr1.` string, a hand-crafted plain-`http://` non-local
connect string (`a connect string must be https unless it points at this machine`), a hand-crafted
string with `e` in the past (`that loan already expired`), a second `lend` on a busy port
(`port 4088 is busy` — and the *first* loan must keep working), `token revoke` mid-loan
(`this token was revoked` on the very next fetch), and `bundle rm --force` under a live loan
(403 `unknown bundle token`). Connect strings are base64url **JSON, not encrypted** — you can craft
any of these with `node -e` over `src/core/connect.ts`'s `{u,t,b,e}` shape.

## Management MCP (`mcp --manage`)

`cookiejar mcp --manage` exposes bundle-management tools with **no** token; plain `cookiejar mcp`
without a token or saved connection must exit 1 with
`A bundle token is required — run cookiejar connect <string>…`.

The manage tools take **`bundleId`**, not `bundle`. Passing the wrong key does not raise a schema
error — the server proceeds and returns `no such bundle: ` with a blank id, which looks like a product
bug but is a caller mistake. Read the `inputSchema` from `tools/list` before writing the call chain:

```bash
python3 -c "import json,sys;[print(t['name'], list(t['inputSchema'].get('properties',{})), t['inputSchema'].get('required')) for t in json.loads(open('out.json').readlines()[i])['result']['tools']]"
```

A good chain in one session: `create_bundle` → `add_site` → `show_bundle` → `rename_bundle` →
`remove_site` → `issue_token` → `list_tokens` → `revoke_token`, then confirm the effects in the CLI
(`bundles`, `tokens`) so you are not just reading an in-memory echo. `issue_token` is the *only* place
a `cjr_` may appear (shown once, by design) — everywhere else, 0 matches.

## The local UI (`cookiejar ui`)

`cookiejar ui` prints `http://127.0.0.1:4088/?k=<sessionKey>`; **the `?k=` is mandatory** — without it
`/` returns 403 and `/api/*` returns `this page lost its session — restart cookiejar ui`. Copy the URL
from the terminal each run (the key is regenerated). Use `--no-open` when driving Chrome yourself.

For the Tokens tab, seed grants in several states first so the table discriminates:

```bash
cj token new $B --label ci-runner   --days 7  --proxy-only >/dev/null
cj token new $B --label laptop-agent --days 30            >/dev/null
cj token new $B --label stale-one    --days -1            >/dev/null   # negative days = already expired
```

Then assert: the row shows the 12-hex **grant id** (never a `cjr_`), state renders as
`live · proxy only` / `live` / `revoked` / `expired`, and clicking **Revoke** both flips the row and
drops the `N live.` subtitle by exactly 1. The check that separates a real revoke from a cosmetic one
is running `cookiejar tokens` in the terminal afterwards and seeing the *same grant id* revoked.

Known nit: the `bundles` one-line summary counts expired-but-unrevoked grants as "live", so it can
disagree with `tokens` / the Tokens tab. Verify whether that is still true before reporting it.

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
- `src/mcp/server.ts` used to hardcode `serverInfo.version`; confirm `initialize` reports the real
  `package.json` version after any bump.
- Confirm the version actually on the branch matches the version the request talks about — they have
  disagreed before (a request to clear "0.2.0" while `package.json` said `0.3.0`).
- Stale daemons cause confusing cross-test failures. Confirm the port is free before starting one, and
  kill leftovers by exact PID (`pgrep -af 'dist/cli.js'`) — a `pkill -f 'dist/cli.js …'` pattern can
  match the shell running it and kill your own session.
- Redact before reporting: a full `cjr1.…` connect string embeds a working token. Screenshots of a
  `lend` / `connect` terminal will contain one, so black it out
  (`convert shot.png -fill black -draw "rectangle x1,y1 x2,y2" out.png`) before embedding it anywhere.
