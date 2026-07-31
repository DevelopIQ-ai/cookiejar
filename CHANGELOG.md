# Changelog

## 0.2.0

- **cookiejar is a CLI.** The React app, the Vite build, and the whole `/api/*` surface are gone.
  Everything — browser setup, picking cookies, bundles, tokens, the audit log — is a command.
- `cookiejar serve` replaces `cookiejar ui`: a loopback daemon that answers bundle tokens on
  `/agent/*` and 404s everything else, so a token can no longer reach bundle management.
- `cookiejar setup` asks which browsers you use and explains Safari's Full Disk Access when macOS is
  blocking it. The answer is stored in the encrypted vault.
- `cookiejar export --bundle <id>` and `header --bundle <id>` read the vault directly — a local
  script needs neither a daemon nor a token.
- `cookiejar share <id> [--tunnel <url>]` prints the MCP and `curl` config for handing a bundle to a
  local or cloud agent.
- Chrome profiles with no cookie table no longer error, and profiles with zero readable cookies are
  hidden from listings; blocked profiles are reported as something to fix.
- Added `cookiejar version`, plus contributor, security, and issue-template docs.

## 0.1.0

- First release: read cookies live from Chrome/Chromium/Brave/Edge/Arc, Firefox, and Safari; group
  them into bundles in a scrypt + AES-256-GCM vault that stores selectors, never values; per-bundle
  tokens with expiry, revocation, use counts, an audit log, and a proxy-only mode; MCP, CLI, and
  HTTP access for agents.
