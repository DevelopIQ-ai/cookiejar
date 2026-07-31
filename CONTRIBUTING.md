# Contributing

Thanks for looking. cookiejar is deliberately small: zero runtime dependencies, plain Node, and a
CLI that never leaves your machine. Changes that keep it that way are the easiest to merge.

## Getting started

Node 22.5+ is required (the browser readers use the built-in `node:sqlite`).

```bash
git clone https://github.com/DevelopIQ-ai/cookiejar
cd cookiejar
npm install
npm run dev -- doctor
```

Never test against your real cookies. Seed a fake browser profile instead:

```bash
node scripts/seed-demo-profile.mjs /tmp/cookiejar-demo
HOME=/tmp/cookiejar-demo COOKIEJAR_HOME=/tmp/cookiejar-demo/.cookiejar npm run dev -- doctor
```

## Before you open a PR

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

CI runs the same four on every push. Tests drive the real CLI and the real daemon end to end, so add
one for whatever you changed — `test/cli.test.ts` for commands, `test/server.test.ts` for `/agent/*`.

## Things to keep true

These are the invariants the project exists for; a PR that breaks one needs a very good reason.

- **The vault stores selectors, never cookie values.** Values are read live from the browser on
  every access.
- **Nothing prints a cookie value unless the user asked for it.** Listings, errors, and
  `~/.cookiejar/audit.log` are metadata only.
- **The daemon binds to loopback and serves `/agent/*` only.** Management belongs in the CLI, where
  it is behind the master password.
- **No runtime dependencies.** `dependencies` in `package.json` stays empty. Dev dependencies are
  fine.
- **No network calls** other than the ones an agent explicitly proxies through `/agent/fetch`. No
  telemetry, no update checks.

## Adding a browser

Browser readers live in `src/core/browsers/` and each export a reader that returns `Cookie[]` plus
its profile discovery. Add the family to `src/core/browsers/index.ts` and `BrowserId` in
`src/core/types.ts`. Include a test with a synthetic store — see `test/chromium.test.ts` and
`test/safari.test.ts` — so the parser is covered without anyone's real data.

## Reporting bugs

Please include `cookiejar doctor` output and your OS and browser versions. Redact anything that
looks like a domain you would rather not share. Never paste a cookie value or a `cjr_…` token into
an issue.

Security issues go to [SECURITY.md](SECURITY.md), not the issue tracker.
