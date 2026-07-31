# cookiejar

**Local-only cookie bundles for coding agents.**

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

- **Local only.** No account, no cloud, no telemetry. The server binds to `127.0.0.1` and the only
  outbound requests it ever makes are the ones an agent explicitly proxies.
- **Password protected.** Bundle definitions live in `~/.cookiejar/vault.json`, encrypted with
  scrypt + AES-256-GCM. Agent tokens only work while the jar is unlocked.
- **Values are never stored.** A bundle records *which* cookies to use. The values are read live from
  the browser on every access, so re-logging in the browser is all it takes to refresh an agent, and a
  stolen vault file leaks nothing but bundle names.
- **Per-bundle tokens.** Expiry, revocation, an access counter, and an append-only audit log. A token
  can be marked *proxy only*, so the agent can make authenticated requests but never sees a cookie.

## Install

Requires Node 22.5+ (for the built-in SQLite reader).

```bash
npm install -g @puffle/cookiejar
cookiejar ui --open
```

Or from source:

```bash
git clone https://github.com/DevelopIQ-ai/cookiejar
cd cookiejar
npm install && npm run build
node dist/cli.js ui --open
```

Open http://127.0.0.1:4088, choose a master password, and pick your cookies.

## Using a bundle from an agent

Issue a token in **Bundles → Agent access**, then give the agent one of these.

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

**HTTP** (the daemon, `Authorization: Bearer cjr_…`)

| Endpoint | Purpose |
| --- | --- |
| `GET /agent/bundle` | Name, hosts, permissions — no secrets |
| `GET /agent/cookies?format=netscape\|storage-state\|json` | The jar |
| `GET /agent/cookies?format=header&url=…` | One `Cookie` header |
| `POST /agent/fetch` | Proxy a request with the bundle's cookies attached |

`POST /agent/fetch` is the safest option: cookies never leave the machine, and the request is refused
unless the target host is one the bundle actually holds cookies for.

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
- An agent token is worth exactly one bundle, only while the app is unlocked, and only until you hit
  **Revoke** (or the jar auto-locks after 30 idle minutes).
- Every access is appended to `~/.cookiejar/audit.log` with the bundle, token label, and what was
  asked for. Values are never logged.
- Prefer *proxy only* tokens and per-site bundles. Cookies are bearer credentials: anything you put in
  a bundle, the agent can act as you with.
- `Set-Cookie` responses from proxied requests are dropped, so an agent cannot rewrite your session.

## Development

```bash
npm run dev            # daemon with tsx
npm --prefix ui run dev   # Vite UI on :4089, proxying the daemon
npm test               # node:test, includes an end-to-end daemon test
npm run lint && npm run typecheck
node scripts/seed-demo-profile.mjs /tmp/cookiejar-demo   # fake browser data for UI work
```

Layout: `src/core` (crypto, vault, browser readers, bundle resolution), `src/server` (local HTTP API),
`src/mcp` (stdio MCP server), `ui` (React app), `test`.

MIT licensed. Issues and PRs welcome.
