# cookiejar

[![npm](https://img.shields.io/npm/v/@puffle/cookiejar)](https://www.npmjs.com/package/@puffle/cookiejar)
[![CI](https://github.com/DevelopIQ-ai/cookiejar/actions/workflows/ci.yml/badge.svg)](https://github.com/DevelopIQ-ai/cookiejar/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Local-only cookie bundles for coding agents. A CLI, nothing else.**

You are already logged into GitHub, Linear, Notion, your admin panels. Your agent is not, and half of
those things have no MCP server. cookiejar lets you pick the exact cookies you are willing to share,
group them into a **bundle**, and hand that bundle to an agent with a revocable token — without the
agent (or anyone else) getting a copy of your whole browser.

```
   browsers                cookiejar                     agents
┌──────────────┐      ┌──────────────────┐        ┌────────────────────┐
│ Chrome       │      │  ~/.cookiejar    │        │  Devin / Claude    │
│ Safari       │─────▶│  bundles, tokens │◀──MCP──│  Codex / curl      │
│ Firefox …    │ live │  (encrypted)     │  HTTP  │                    │
└──────────────┘ read └──────────────────┘        └────────────────────┘
             everything stays on 127.0.0.1
```

- **Local only.** No account, no cloud, no telemetry. The agent daemon binds to `127.0.0.1` and the
  only outbound requests it ever makes are the ones an agent explicitly proxies.
- **Password protected.** Bundle definitions live in `~/.cookiejar/vault.json`, encrypted with
  scrypt + AES-256-GCM. Agent tokens only work while `cookiejar serve` is holding the jar open.
- **Values are never stored.** A bundle records *which* cookies to use. The values are read live from
  the browser on every access, so re-logging in the browser is all it takes to refresh an agent, and a
  stolen vault file leaks nothing but bundle names.
- **Per-bundle tokens.** Expiry, revocation, an access counter, and an append-only audit log. A token
  can be marked *proxy only*, so the agent can make authenticated requests but never sees a cookie.

## Install

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

## A whole session

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

## Walkthrough

`setup` asks which browsers you use (and explains Safari's Full Disk Access if you pick it), then
creates the encrypted jar. Everything after that is a command; anything touching the jar asks for
your master password, or reads `COOKIEJAR_PASSWORD` for scripts.

```bash
cookiejar doctor                                 # what can be read here, and why not
cookiejar sites                                  # every site you have cookies for
cookiejar cookies linear.app                     # names only — values are never printed

cookiejar bundle new "linear agent"
cookiejar bundle add linear-agent-9f0b73 linear.app --pick   # tick cookies, terminal style
cookiejar bundle linear-agent-9f0b73             # selectors, live contents, tokens

cookiejar token new linear-agent-9f0b73 --label devin --days 7 --proxy-only
cookiejar share linear-agent-9f0b73              # MCP + curl config, local and cloud
cookiejar token revoke linear-agent-9f0b73 1b027f6ab46c
cookiejar activity                               # audit log
```

`cookiejar export --bundle <id>` and `cookiejar header --bundle <id>` read the jar directly, so a
local script needs neither a daemon nor a token. Run `cookiejar help` for the full list.

## Using a bundle from an agent

Agents talk to `cookiejar serve`, a loopback daemon that answers bundle tokens and nothing else — it
serves `/agent/*` only, so a token can never create or change a bundle. Start it and leave it
running while an agent works; stopping it (or `--auto-lock`, 30 idle minutes by default) cuts every
agent off at once.

```bash
cookiejar serve
```

Then give the agent one of these.

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

Tools: `describe_bundle`, `get_cookie_header`, `export_cookies`, `http_request`.

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

`POST /agent/fetch` is the safest option: cookies never leave the machine, and the request is refused
unless the target host is one the bundle actually holds cookies for.

## Handing a bundle to an agent in the cloud

The daemon listens on loopback, so a remote agent needs one of two things.

1. **Tunnel it (recommended).** Issue a `--proxy-only` token, expose the daemon
   (`cloudflared tunnel --url http://127.0.0.1:4088`, `tailscale funnel 4088`, `ngrok http 4088`),
   and give the agent the tunnel URL plus the token — as MCP
   (`npx -y @puffle/cookiejar mcp --url https://…`) or straight `POST /agent/fetch`. Values stay on
   your machine; revoking the token or stopping the daemon cuts access instantly.
   `cookiejar share <bundle> --tunnel <url>` prints the exact commands.
2. **Export it.** `cookiejar export --format storage-state --out state.json` and upload that to the
   agent. Simplest, but the cookie values leave your machine and go stale on your next re-login.

## Browser support

| Browser | macOS | Linux | Notes |
| --- | --- | --- | --- |
| Chrome, Chromium, Brave, Edge, Arc | ✅ | ✅ | Key from the login Keychain / keyring |
| Firefox | ✅ | ✅ | Plaintext store |
| Safari | ✅ | — | Needs **Full Disk Access** for your terminal |
| Windows Chromium | — | — | App-bound (`v20`) cookies are not supported yet |

`cookiejar doctor` prints what can and cannot be read on this machine, and why.

Browsers hold a lock on their cookie stores, so cookiejar reads from a temporary copy (including the
WAL) and never writes to them.

## Security model

- The vault protects bundle *definitions*, not cookie values — values live in your browser only.
- An agent token is worth exactly one bundle, only while `cookiejar serve` is running, and only until
  `cookiejar token revoke` (or the daemon auto-locks after 30 idle minutes).
- Every access is appended to `~/.cookiejar/audit.log` with the bundle, token label, and what was
  asked for. Values are never logged.
- Prefer *proxy only* tokens and per-site bundles. Cookies are bearer credentials: anything you put in
  a bundle, the agent can act as you with.
- `Set-Cookie` responses from proxied requests are dropped, so an agent cannot rewrite your session.

## Development

```bash
npm run dev -- doctor    # the CLI through tsx
npm test                 # node:test; drives the real binary end to end
npm run lint && npm run typecheck
HOME=/tmp/cookiejar-demo node scripts/seed-demo-profile.mjs /tmp/cookiejar-demo   # fake browser data
```

Layout: `src/core` (crypto, vault, browser readers, bundle resolution, bundle/grant management),
`src/cli` (commands and prompts), `src/server` (the agent daemon), `src/mcp` (stdio MCP server),
`test`.

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the setup, the checks CI runs,
and the invariants a change has to keep (no values in the vault, no values in output, no runtime
dependencies, loopback only). Please report vulnerabilities privately: [SECURITY.md](SECURITY.md).
By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

MIT licensed.
