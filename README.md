# cookiejar

[![npm](https://img.shields.io/npm/v/@puffle/cookiejar)](https://www.npmjs.com/package/@puffle/cookiejar)
[![CI](https://github.com/DevelopIQ-ai/cookiejar/actions/workflows/ci.yml/badge.svg)](https://github.com/DevelopIQ-ai/cookiejar/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Local-only cookie bundles for coding agents. A CLI, nothing else.**

You are already logged into Linear, GitHub, Notion, your admin panels. Your agent is not, and a lot of those things have no MCP server. **cookiejar** lets you pick the exact cookies you are willing to share, group them into a named **bundle**, and hand that bundle to an agent with a short-lived, revocable token — without the agent (or anyone else) getting a copy of your whole browser.

```
   browsers                cookiejar                     agents
┌──────────────┐      ┌──────────────────┐        ┌────────────────────┐
│ Chrome       │      │  ~/.cookiejar    │        │  Devin / Claude    │
│ Safari       │─────▶│  bundles, tokens │◀──MCP──│  Codex / curl      │
│ Firefox …    │ live │  (encrypted)     │  HTTP  │                    │
└──────────────┘ read └──────────────────┘        └────────────────────┘
             everything stays on 127.0.0.1
```

Three things it does **not** do: it doesn't run in the cloud (the daemon only binds to `127.0.0.1`), it doesn't store cookie values in its vault (it stores only *which* cookies belong in each bundle), and it doesn't make outbound requests except when an agent explicitly asks it to proxy one.

## Setup in two commands

Requires Node 22.5+ (for the built-in SQLite reader).

```bash
npm install -g @puffle/cookiejar
cookiejar setup
```

Or from source:

```bash
git clone https://github.com/DevelopIQ-ai/cookiejar
cd cookiejar
npm install && npm run build
node dist/cli.js setup
```

`setup` asks which browsers you use and explains Safari's Full Disk Access if you pick it. The jar's key lives in your OS keyring (macOS Keychain, libsecret on Linux), so nothing asks you for a password in normal use — the file on disk is still encrypted. `cookiejar passwd` puts a master password on it if you want one, and `cookiejar passwd --none` moves the key back to the keyring.

## A whole minute

```console
$ cookiejar setup
Which browsers do you use? cookiejar only reads the ones you pick.

  1. Chrome
  2. Firefox

Numbers, comma separated (enter = all):
Saved: Chrome, Firefox.

$ cookiejar sites
github.com              3 cookies  chrome:Default
linear.app              2 cookies  chrome:Default firefox:abcd1234.demo
notion.so               2 cookies  chrome:Default

$ cookiejar cookies linear.app          # names and flags only, never a value
__session  .linear.app  chrome:Default         httpOnly secure
__session  .linear.app  firefox:abcd1234.demo  httpOnly secure

$ cookiejar bundle new "linear agent"
created linear-agent-1d247f

$ cookiejar bundle add linear-agent-1d247f linear.app --profile chrome:Default
linear-agent-1d247f: added linear.app from chrome:Default (1 cookie, tracking all)

$ cookiejar token new linear-agent-1d247f --label devin --days 7 --proxy-only
cjr_····························

6ca24d828102 · devin · expires Fri Aug 07 2026 · proxy only, values stay here
This is the only time the token is shown. It only works while cookiejar serve is running.

$ cookiejar serve
cookiejar is answering agent tokens at http://127.0.0.1:4088
auto-lock: 30 idle minutes  ·  stop it to cut every agent off
```

## What it does

| | |
| --- | --- |
| **Reads live from your browsers** | Chrome, Chromium, Brave, Edge, Arc, Firefox, and Safari on macOS. It copies the locked SQLite store to a temp file first and never writes back. |
| **Stores selectors, not values** | The vault holds only profile + domain + cookie names. Values are read fresh every time, so re-logging in the browser refreshes every agent, and a stolen vault file leaks nothing but bundle names. |
| **Bundles by site** | Pick the cookies an agent actually needs and name the bundle. Add, rename, or remove selectors from the terminal. |
| **Suggested bundles** | `cookiejar suggest` reads what you are signed into and proposes bundles worth making — travel, work, finance, dev, shopping, social, AI — taking the cookies that look like a session and skipping analytics-only sites. Nothing is written until you accept. |
| **An optional UI** | `cookiejar ui` opens the same jar in a browser on 127.0.0.1: sites, cookie names, bundles, tokens, suggestions. Everything it can do, the terminal can do. It never shows a cookie value either. |
| **A skill for your agent** | `cookiejar skill` writes `.agents/skills/cookiejar/SKILL.md` into your project, so a coding agent knows how to use a token, and what it must never do with one. |
| **Per-bundle tokens** | Each token is tied to one bundle, with expiry, a label, use count, and an append-only audit log. `cookiejar tokens` (or the Tokens tab) shows every one you ever handed out; revoke one, or revoke every live token at once. |
| **One-command lending** | `cookiejar lend <bundle> --minutes 60` serves the bundle, tunnels it over HTTPS, mints a short proxy-only token, and prints a single string for a cloud agent. Ctrl-C revokes it. |
| **Proxy-only mode** | The agent can make authenticated requests through `POST /agent/fetch` but never sees a cookie value. |
| **MCP, CLI, and HTTP agents** | `cookiejar mcp --install claude\|cursor\|codex\|vscode` wires a local agent to one bundle with no daemon and no token; tools for `read_page`, `http_request`, `describe_bundle`, `get_cookie_header`, `export_cookies`, `browser_context`; `cookiejar export` and `header` for shell scripts; a plain REST API when `cookiejar serve` is running. |
| **Pages, not markup** | `read_page` / `cookiejar fetch --text` reduces a logged-in page to readable text with its links, so an agent spends a couple of thousand tokens instead of a couple of hundred thousand. |
| **Cuts access instantly** | Stop the daemon, revoke a token, lock the jar, or let it auto-lock after 30 idle minutes — every agent loses access on its next request, no restart needed. |

## Use it with real cookies

```bash
cookiejar doctor        # see what can be read on this machine, and why not
cookiejar sites         # list sites you have cookies for
cookiejar cookies <site> --all   # names and flags; --all reads every browser
```

Let it propose the bundles for you, then accept the ones you want:

```bash
cookiejar suggest                 # travel, work, finance … grouped from your logins
cookiejar suggest travel          # review that one, then confirm to create it
```

Or create a bundle, add a site, and issue a token by hand:

```bash
cookiejar bundle new "linear agent"
cookiejar bundle add linear-agent-1d247f linear.app --pick   # tick cookies interactively
cookiejar token new linear-agent-1d247f --label devin --days 7
```

For scripts: `cookiejar setup --browsers chrome,firefox` and `COOKIEJAR_PASSWORD=…`.

## If you would rather click

```bash
cookiejar ui        # opens http://127.0.0.1:4088
```

The UI is optional and loopback-only. It serves the page just once, to the
browser that opens the link printed in your terminal, and refuses any request
from another origin. Cookie values never reach it — the same names and flags
the CLI prints, and nothing more. Agent tokens are answered on the same port,
so `cookiejar ui` also does the job of `cookiejar serve`.

## Teach your agent to use it

```bash
cookiejar skill     # writes .agents/skills/cookiejar/SKILL.md
```

Commit that file and any coding agent that reads skills will know how to call
`/agent/fetch`, when to prefer a proxy-only token, and that it must never log a
cookie value.

## Point a coding agent on this machine at it

No daemon, no token: the jar is already here, so one command wires it into your
client.

```bash
cookiejar mcp --install claude --bundle work-3f9a   # or cursor, codex, vscode
```

That writes the config (`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, or
`~/.codex/config.toml`, leaving anything already in it alone) pointing at:

```json
{
  "mcpServers": {
    "cookiejar": {
      "command": "npx",
      "args": ["-y", "@puffle/cookiejar", "mcp", "--bundle", "work-3f9a", "--manage"]
    }
  }
}
```

Tools: `read_page`, `http_request`, `describe_bundle`, `get_cookie_header`,
`export_cookies`, `browser_context`, plus the bundle-upkeep tools from
`--manage`. The agent gets that one bundle — not the jar.

`read_page` returns a page as readable text with links kept, usually a tenth to
a fiftieth of the HTML. `browser_context` writes a Playwright `storageState`
file (0600, under `~/.cookiejar`) and returns its path, so an agent that needs
to *click* something drives a browser already signed in:

```bash
cookiejar browser work-3f9a     # the same handoff, with a snippet to run
```

That file holds real cookie values, which is why it is local-only and never
offered to a lent bundle.

## Point an agent somewhere else at it

Start the daemon:

```bash
cookiejar serve
```

**MCP (Devin, Claude Code, Cursor, Codex …)**

```json
{
  "mcpServers": {
    "cookiejar-ticket-triage": {
      "command": "npx",
      "args": ["-y", "@puffle/cookiejar", "mcp"],
      "env": { "COOKIEJAR_TOKEN": "cjr_…" }
    }
  }
}
```

**CLI**

```bash
export COOKIEJAR_TOKEN=cjr_…
cookiejar export --format netscape --out cookies.txt   # curl -b cookies.txt …
cookiejar export --format storage-state                # Playwright / Puppeteer
cookiejar header --url-target https://linear.app/team  # a single Cookie header
```

**HTTP** (`cookiejar serve`, `Authorization: Bearer cjr_…`)

| Endpoint | Purpose |
| --- | --- |
| `GET /agent/bundle` | Name, hosts, permissions — no secrets |
| `GET /agent/cookies?format=netscape\|storage-state\|json` | The jar |
| `GET /agent/cookies?format=header&url=…` | One `Cookie` header |
| `POST /agent/fetch` | Proxy a request with the bundle's cookies attached |

`POST /agent/fetch` is the safest option: cookies never leave the machine, and the request is refused unless the target host is one the bundle actually holds cookies for.

## Handing a bundle to an agent in the cloud

The daemon listens on loopback, so an agent on someone else's machine cannot
reach it. `cookiejar lend` does the whole handover in one command:

```console
$ cookiejar lend work-3f9a --minutes 60

work is lent for 60 minutes, proxy only. Give the agent this:

  cjr1.eyJ1IjoiaHR0cHM6Ly9mcm9zdC1wYW5kYS05eDIudHJ5Y2xvdWRmbGFyZS5jb20i…

It runs: cookiejar connect <that string>
The agent can make requests as you, but never sees a cookie value.
Ctrl-C revokes it now. Otherwise it dies on its own in 60 minutes.
```

That serves the bundle, starts a Cloudflare quick tunnel (fetching a pinned,
checksum-verified `cloudflared` once if you do not have it), and mints a
proxy-only token that expires. The agent runs:

```console
$ cookiejar connect cjr1.…
connected to "work" · about 60 minutes left
hosts   github.com, linear.app
cookies 7, values hidden (proxy only)

$ cookiejar fetch https://linear.app/api/me --json    # pretty-printed JSON
$ cookiejar fetch https://linear.app/team/x --text    # the page as readable text
```

While it is out, `cookiejar tail` shows every request the borrower makes as it
happens, and `cookiejar token extend work-3f9a --minutes 30` buys a loan more
time — the agent picks it up on its next request, with nothing to reconnect.
When a host answers 401 with the cookies attached, the reply carries a `hint`
explaining that some sites serve their website from cookies and their API from
an API key, so an agent stops retrying a bundle that was never at fault.

The connect string is the only thing you send, and it is a credential: it
carries a bearer token. Ctrl-C on the lending terminal revokes the token and
takes the address down; so does `cookiejar token revoke --all`.

Pass `--local` to skip the tunnel (an agent on this machine), or `--values` if
the agent genuinely needs the raw cookies instead of proxied requests.

The blunt alternative is still there: `cookiejar export --format storage-state
--out state.json` and upload it — simplest, but the cookie values leave your
machine and go stale on the next re-login.

### Letting an agent look after the bundle

An agent running on *your* machine can keep a bundle tidy for you:

```bash
cookiejar mcp --manage
```

On top of the usual bundle tools that adds `list_sites`, `list_cookies`,
`suggest_bundles`, `create_bundle`, `add_site`, `remove_site`, `rename_bundle`,
`show_bundle`, `list_tokens`, `issue_token` and `revoke_token`, so "add my
Figma login to the work bundle and lend it to the cloud for an hour" is one
sentence. None of those tools return a cookie value.

## Prompt for coding agents

Copy the block below into Claude Code / Cursor / Devin and tell it which site you want to act on. It will install cookiejar, create a demo jar with fake browser data (no real cookies touched), issue a token, and verify the daemon serves it.

````text
Set up @puffle/cookiejar (https://github.com/DevelopIQ-ai/cookiejar) on this machine for me.

1. Check `node -v` is >= 22.5 — cookiejar uses `node:sqlite`. If older, install Node 22.
2. Install: `npm install -g @puffle/cookiejar`
3. Seed a fake profile so no real browser data is touched:
       curl -L https://raw.githubusercontent.com/DevelopIQ-ai/cookiejar/main/scripts/seed-demo-profile.mjs -o /tmp/seed.mjs
       node /tmp/seed.mjs /tmp/cjdemo
   Then run all cookiejar commands with `HOME=/tmp/cjdemo COOKIEJAR_HOME=/tmp/cjdemo/.cookiejar COOKIEJAR_PASSWORD=demo-password-1`.
4. Set up the jar: `cookiejar setup --browsers chrome`
5. List sites: `cookiejar sites` — confirm you see `example.com`.
6. Create a bundle for `example.com`:
       BUNDLE=$(cookiejar bundle new "demo")
       cookiejar bundle add "$BUNDLE" example.com --profile chrome:Default
7. Issue a token: `cookiejar token new "$BUNDLE" --label test --days 1`
8. Start the daemon: `cookiejar serve --auto-lock=0` and in another shell verify:
       curl -s http://127.0.0.1:4088/agent/bundle -H "authorization: Bearer <token>"
9. Stop the daemon and report back the bundle name, the token, and the response.

Rules: do not point at or read any real browser profile, do not log any cookie value, and do not put an agent token in a file you commit.
````

## Browser support

| Browser | macOS | Linux | Notes |
| --- | --- | --- | --- |
| Chrome, Chromium, Brave, Edge, Arc | ✅ | ✅ | Key from the login Keychain / keyring |
| Firefox | ✅ | ✅ | Plaintext store |
| Safari | ✅ | — | Needs **Full Disk Access** for your terminal |
| Windows Chromium | — | — | App-bound (`v20`) cookies are not supported yet |

`cookiejar doctor` prints what can and cannot be read on this machine, and why.

## Security model

- The vault protects bundle *definitions*, not cookie values — values live in your browser only.
- An agent token is worth exactly one bundle, only while `cookiejar serve` is running, and only until `cookiejar token revoke` (or the daemon auto-locks). Revoking takes effect on the agent's next request — the daemon does not need restarting.
- Every access is appended to `~/.cookiejar/audit.log` with the bundle, token label, and what was asked for. Values are never logged.
- Prefer *proxy only* tokens and per-site bundles. Cookies are bearer credentials: anything you put in a bundle, the agent can act as you with.
- `Set-Cookie` responses from proxied requests are dropped, so an agent cannot rewrite your session.

## Development

```bash
npm run dev -- doctor    # the CLI through tsx
npm test                 # node:test; drives the real binary end to end
npm run lint && npm run typecheck
HOME=/tmp/cookiejar-demo node scripts/seed-demo-profile.mjs /tmp/cookiejar-demo   # fake browser data
```

Layout: `src/core` (crypto, vault, browser readers, bundle resolution, bundle/grant management), `src/cli` (commands and prompts), `src/server` (the agent daemon), `src/mcp` (stdio MCP server), `test`.

## Contributing

Issues and PRs welcome — read [CONTRIBUTING.md](CONTRIBUTING.md) for the setup, the checks CI runs, and the invariants a change has to keep (no values in the vault, no values in output, no runtime dependencies, loopback only). Please report vulnerabilities privately: [SECURITY.md](SECURITY.md).

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

MIT licensed.
