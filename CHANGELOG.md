# Changelog

## 0.3.0

- `cookiejar suggest` groups the sites you are signed into into bundles worth making — travel,
  work, developer infrastructure, finance, shopping, social, AI tools. It takes the cookies that
  look like a session and skips analytics-only sites, prints names only, and writes nothing until
  you accept a category with `cookiejar suggest <category>`.
- The UI is back, and optional: `cookiejar ui` serves the same jar on 127.0.0.1 for browsing sites
  and cookie names, making bundles, accepting suggestions, and issuing or revoking tokens. The page
  is handed only to the browser that opens the link printed in the terminal, cross-origin writes are
  refused, and no cookie value ever reaches it. `cookiejar serve` is unchanged and still agent-only.
- `cookiejar skill` writes `.agents/skills/cookiejar/SKILL.md` into your project so a coding agent
  knows how to use a bundle token, and what it must never do with one. It will not overwrite an
  edited copy without `--force`.
- Nothing needs the vault edited by hand any more: `cookiejar bundle edit` renames a bundle or
  changes its description, `cookiejar tokens [--live]` lists every token the jar handed out,
  `cookiejar token revoke --all [<bundle>]` is a panic switch that cuts every live token off, and
  `cookiejar activity --bundle <id>` filters the audit log.
- `cookiejar setup --browsers chrome,firefox` answers the setup prompt from a script.
- `cookiejar reset [--force]` deletes the jar when the master password is gone. Bundles go with it;
  your cookies never lived there.

## 0.2.0

- **cookiejar is a CLI.** The React app, the Vite build, and the whole `/api/*` surface are gone.
  Everything — browser setup, picking cookies, bundles, tokens, the audit log — is a command.
- `cookiejar serve` replaces `cookiejar ui`: a loopback daemon that answers bundle tokens on
  `/agent/*` and 404s everything else, so a token can no longer reach bundle management.
- `cookiejar setup` asks which browsers you use and explains Safari's Full Disk Access when macOS is
  blocking it. The answer is stored in the encrypted vault, and `sites`, `cookies` and `bundle add`
  read only those browsers unless you pass `--all`.
- `cookiejar token revoke` now cuts a token off on the agent's next request, with no daemon restart,
  and a running `cookiejar serve` can no longer write a stale copy of the vault back over an edit
  made in the terminal. Tokens issued while the daemon runs work immediately too.
- Prompts accept piped answers, so `setup` and `--pick` can be scripted.
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
