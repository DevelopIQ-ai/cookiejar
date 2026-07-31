# Security Policy

cookiejar handles bearer credentials — the cookies in a bundle let an agent act as you. Please treat
bugs in it accordingly.

## Reporting a vulnerability

Do **not** open a public issue. Use GitHub's private reporting —
[Report a vulnerability](https://github.com/DevelopIQ-ai/cookiejar/security/advisories/new) — or
email <kush@puffle.ai>.

Please include the version (`cookiejar --version` or the npm version), your OS, and the smallest
reproduction you can manage. Never include real cookie values or `cjr_…` tokens; synthetic data from
`scripts/seed-demo-profile.mjs` is enough for almost everything.

Expect an acknowledgement within a few days. Fixes ship as a patch release and the advisory is
published once the fix is out.

## Supported versions

The latest published version on npm is the only supported one. There are no long-term branches.

## Threat model

What cookiejar is designed to protect against:

- **A stolen `~/.cookiejar/vault.json`.** It is scrypt + AES-256-GCM behind your master password and
  it stores only *which* cookies a bundle uses — profile, domain, names. No cookie values, and only
  hashes of agent tokens.
- **An over-reaching agent.** A token is worth exactly one bundle. `--proxy-only` tokens can make
  authenticated requests through `POST /agent/fetch` but never see a value, and `/agent/fetch`
  refuses any host the bundle does not hold cookies for and strips `Set-Cookie` from responses.
- **A stale grant.** Tokens expire, can be revoked, count their uses, and stop working the moment
  `cookiejar serve` exits or auto-locks.
- **Leaks through output.** Cookie listings, error messages, and `~/.cookiejar/audit.log` are
  metadata only.

What it explicitly does **not** protect against:

- **Local malware or another process running as you.** Anything that can read your browser profile
  can read your cookies directly; cookiejar is not a sandbox.
- **A bundle you chose to over-share.** Cookies are bearer credentials. Scope bundles per site.
- **Whatever an agent does with a token you gave it,** including exfiltrating a non-proxy-only
  cookie value. Prefer `--proxy-only`.
- **Your tunnel.** If you expose the daemon with cloudflared/ngrok/tailscale, that tunnel's security
  is yours to manage. Use short expiries and revoke when done.
- **A weak master password.** It is the only thing between the vault file and your bundle
  definitions.

## Good practice

- One bundle per site or task, not one big bundle.
- `--proxy-only` by default; hand over raw values only when a tool genuinely needs them.
- Short `--days` on tokens, and `cookiejar token revoke` when the work is finished.
- Stop `cookiejar serve` when no agent is working. Check `cookiejar activity` now and then.
