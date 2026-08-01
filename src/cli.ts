#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { startServer } from './server/index.js';
import { runMcpServer } from './mcp/server.js';
import { cookieHeaderFor, resolveBundle, toNetscape, toStorageState } from './core/bundles.js';
import { askSecret } from './cli/prompt.js';
import { CliError, daemonHoldsVault, openVault } from './cli/vault.js';
import * as cmd from './cli/commands.js';
import { VERSION } from './core/version.js';

// node:sqlite is how we read cookie stores; its experimental banner is noise here.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name !== 'ExperimentalWarning') console.warn(`${warning.name}: ${warning.message}`);
});

const DEFAULT_PORT = Number(process.env.COOKIEJAR_PORT ?? 4088);
const DEFAULT_URL = process.env.COOKIEJAR_URL ?? `http://127.0.0.1:${DEFAULT_PORT}`;

interface Args {
  command: string;
  /** Positional arguments after the command, e.g. ['add', 'my-bundle', 'linear.app']. */
  rest: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | boolean>();
  const rest: string[] = [];
  const [command = 'help', ...tail] = argv;
  for (let i = 0; i < tail.length; i++) {
    const arg = tail[i];
    if (!arg.startsWith('--')) {
      rest.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split('=', 2);
    if (inline !== undefined) flags.set(name, inline);
    else if (tail[i + 1] && !tail[i + 1].startsWith('--')) flags.set(name, tail[++i]);
    else flags.set(name, true);
  }
  return { command, rest, flags };
}

const flagString = (args: Args, name: string, fallback?: string): string | undefined => {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : fallback;
};

const flagBool = (args: Args, name: string): boolean => args.flags.get(name) === true || args.flags.get(name) === 'true';

const flagNumber = (args: Args, name: string, fallback: number): number => {
  const value = flagString(args, name);
  return value === undefined ? fallback : Number(value);
};

function positional(args: Args, index: number, what: string): string {
  const value = args.rest[index];
  if (!value) throw new CliError(`${what} is required — see cookiejar help`);
  return value;
}

function requireToken(args: Args): string {
  const token = flagString(args, 'token') ?? process.env.COOKIEJAR_TOKEN;
  if (!token) throw new CliError('A bundle token is required. Pass --token or set COOKIEJAR_TOKEN.');
  return token;
}

async function agentGet(args: Args, route: string): Promise<string> {
  const base = flagString(args, 'url', DEFAULT_URL)!;
  const response = await fetch(new URL(route, base), { headers: { authorization: `Bearer ${requireToken(args)}` } });
  const text = await response.text();
  if (!response.ok) throw new CliError(text);
  return text;
}

/**
 * Reads a bundle straight out of the vault, so `export`/`header` work with no
 * daemon and no token: the terminal is a first-class client, not a fallback.
 */
async function localBundleCookies(bundleId: string) {
  const vault = await openVault();
  return resolveBundle(vault.bundle(bundleId)).cookies;
}

const HELP = `cookiejar — local-only cookie bundles for coding agents

A CLI, with an optional local UI (cookiejar ui). Commands that touch the jar
ask for your master password (or read COOKIEJAR_PASSWORD, for scripts).

Setting up
  cookiejar setup [--browsers chrome,firefox]  Pick your browsers; explains Safari's permission
  cookiejar status                       Where the jar is, what is readable, what exists
  cookiejar doctor                       Which browser profiles can be read, and why not
  cookiejar profiles                     Every discovered profile, including empty ones
  cookiejar passwd                       Change the master password
  cookiejar reset [--force]              Delete the jar — for a forgotten password
  cookiejar version                      Print the version

Picking cookies
  cookiejar sites [--profile <id>] [--filter <text>] [--all]
  cookiejar cookies <site> [--profile <id>] [--all] Names only — values are never printed
      Only the browsers you picked in setup are read; --all ignores that.

Bundles
  cookiejar suggest [<category>] [--all] [--yes]   Bundles worth making, from what you are signed into
  cookiejar bundles                                List bundles
  cookiejar bundle <id>                            Selectors, live cookies, tokens
  cookiejar bundle new <name> [--description <text>]
  cookiejar bundle edit <id> [--name <name>] [--description <text>]
  cookiejar bundle add <id> <site> [--profile <id>] [--names a,b] [--pick] [--all]
  cookiejar bundle remove <id> <site> [--profile <id>]
  cookiejar bundle rm <id> [--force]

Giving a bundle to an agent
  cookiejar token new <bundle> [--label <who>] [--days 30] [--proxy-only] [--no-fetch]
  cookiejar tokens [--live]                        Every token this jar handed out
  cookiejar token revoke <bundle> <token-id>
  cookiejar token revoke --all [<bundle>]          Cut every live token off at once
  cookiejar share <bundle> [--tunnel <url>]        MCP + curl config, local and cloud
  cookiejar activity [--limit 50] [--bundle <id>]  Audit log

Serving agents
  cookiejar serve [--port ${DEFAULT_PORT}] [--auto-lock <minutes>]
      Answer bundle tokens on 127.0.0.1 (MCP over a tunnel, /agent/fetch).
      Only /agent/* is served: nothing here can change a bundle.

The optional UI
  cookiejar ui [--port ${DEFAULT_PORT}] [--no-open] [--auto-lock <minutes>]
      The same jar in a browser: sites, cookie names, bundles, tokens,
      suggested bundles. Loopback only, and it never shows a cookie value.

Teaching an agent
  cookiejar skill [--dir <path>] [--force] [--print]
      Write .agents/skills/cookiejar/SKILL.md into this project

Being an agent
  cookiejar export [--bundle <id> | --token <token>] [--format netscape|storage-state|json] [--out <file>]
  cookiejar header --url-target <url> [--bundle <id> | --token <token>]
  cookiejar mcp [--token <token>] [--url ${DEFAULT_URL}]
`;

/** Best effort: the URL is printed either way. */
function openInBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    spawn(command, [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // No desktop here; the printed link is enough.
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION);
      return;
    case 'serve': {
      const port = flagNumber(args, 'port', DEFAULT_PORT);
      const autoLock = flagNumber(args, 'auto-lock', 30);
      const vault = await openVault();
      const { url } = await startServer({ port, vault, autoLockMinutes: autoLock });
      console.log(`cookiejar is answering agent tokens at ${url}`);
      console.log(`auto-lock: ${autoLock ? `${autoLock} idle minutes` : 'off'}  ·  stop it to cut every agent off`);
      return;
    }
    case 'ui': {
      const port = flagNumber(args, 'port', DEFAULT_PORT);
      const autoLock = flagNumber(args, 'auto-lock', 30);
      const vault = await openVault();
      // The key never leaves the terminal until the browser trades it for a
      // session cookie, so an unrelated page on this machine cannot get in.
      const sessionKey = crypto.randomBytes(24).toString('base64url');
      const { url } = await startServer({ port, vault, autoLockMinutes: autoLock, ui: { sessionKey } });
      const entry = `${url}/?k=${sessionKey}`;
      console.log(`cookiejar is at ${entry}`);
      console.log(`agent tokens are answered here too  ·  auto-lock: ${autoLock ? `${autoLock} idle minutes` : 'off'}`);
      console.log('stop it (or lock the jar in the UI) to cut every agent off');
      if (!flagBool(args, 'no-open')) openInBrowser(entry);
      return;
    }
    case 'suggest': {
      await cmd.suggest(await openVault(), {
        categoryId: args.rest[0],
        all: flagBool(args, 'all'),
        yes: flagBool(args, 'yes'),
      });
      return;
    }
    case 'skill': {
      cmd.installSkill({ dir: flagString(args, 'dir'), force: flagBool(args, 'force'), print: flagBool(args, 'print') });
      return;
    }
    case 'mcp': {
      runMcpServer({ daemonUrl: flagString(args, 'url', DEFAULT_URL)!, token: requireToken(args) });
      return;
    }
    case 'setup': {
      await cmd.setup(await openVault(), flagString(args, 'browsers'));
      return;
    }
    case 'reset': {
      await cmd.reset(flagBool(args, 'force'));
      return;
    }
    case 'status': {
      cmd.status(await openVault(), DEFAULT_URL, await daemonHoldsVault(DEFAULT_URL));
      return;
    }
    case 'doctor': {
      cmd.doctor();
      return;
    }
    case 'profiles': {
      cmd.profiles();
      return;
    }
    case 'passwd': {
      const current = process.env.COOKIEJAR_PASSWORD ?? (await askSecret('Current master password: '));
      await cmd.changePassword(await openVault(), current);
      return;
    }
    case 'sites': {
      cmd.listSites(await openVault(), {
        profileId: flagString(args, 'profile'),
        filter: flagString(args, 'filter'),
        all: flagBool(args, 'all'),
      });
      return;
    }
    case 'cookies': {
      cmd.listCookies(await openVault(), positional(args, 0, 'a site'), {
        profileId: flagString(args, 'profile'),
        all: flagBool(args, 'all'),
      });
      return;
    }
    case 'bundles': {
      cmd.listBundles(await openVault());
      return;
    }
    case 'bundle': {
      const sub = positional(args, 0, 'a bundle id or subcommand');
      if (sub === 'new') {
        await cmd.newBundle(await openVault(), positional(args, 1, 'a name'), flagString(args, 'description'));
        return;
      }
      if (sub === 'add') {
        await cmd.bundleAdd(await openVault(), positional(args, 1, 'a bundle id'), positional(args, 2, 'a site'), {
          profileId: flagString(args, 'profile'),
          names: flagString(args, 'names')?.split(',').map((name) => name.trim()).filter(Boolean),
          pick: flagBool(args, 'pick'),
          all: flagBool(args, 'all'),
        });
        return;
      }
      if (sub === 'remove') {
        cmd.bundleRemove(
          await openVault(),
          positional(args, 1, 'a bundle id'),
          positional(args, 2, 'a site'),
          flagString(args, 'profile'),
        );
        return;
      }
      if (sub === 'edit') {
        cmd.editBundle(await openVault(), positional(args, 1, 'a bundle id'), {
          name: flagString(args, 'name'),
          description: flagString(args, 'description'),
        });
        return;
      }
      if (sub === 'rm') {
        await cmd.bundleDelete(await openVault(), positional(args, 1, 'a bundle id'), flagBool(args, 'force'));
        return;
      }
      cmd.showBundle(await openVault(), sub);
      return;
    }
    case 'token': {
      const sub = positional(args, 0, 'new or revoke');
      if (sub === 'new') {
        cmd.newGrant(await openVault(), positional(args, 1, 'a bundle id'), {
          label: flagString(args, 'label'),
          days: flagNumber(args, 'days', 30),
          allowFetch: !flagBool(args, 'no-fetch'),
          redactValues: flagBool(args, 'proxy-only'),
        });
        return;
      }
      if (sub === 'revoke') {
        const all = args.flags.get('all'); // --all <bundle> parses the id as the flag's value
        if (all !== undefined) {
          cmd.revokeAll(await openVault(), typeof all === 'string' ? all : args.rest[1]);
          return;
        }
        cmd.revoke(await openVault(), positional(args, 1, 'a bundle id'), positional(args, 2, 'a token id'));
        return;
      }
      throw new CliError('use: cookiejar token new <bundle> | cookiejar token revoke <bundle> <token-id> | cookiejar token revoke --all');
    }
    case 'tokens': {
      cmd.listGrants(await openVault(), { live: flagBool(args, 'live') });
      return;
    }
    case 'share': {
      cmd.share(await openVault(), positional(args, 0, 'a bundle id'), {
        tunnel: flagString(args, 'tunnel'),
        port: DEFAULT_PORT,
      });
      return;
    }
    case 'activity': {
      cmd.activity(flagNumber(args, 'limit', 50), flagString(args, 'bundle'));
      return;
    }
    case 'export': {
      const format = flagString(args, 'format', 'netscape')!;
      const bundleId = flagString(args, 'bundle');
      let body: string;
      if (bundleId) {
        const cookies = await localBundleCookies(bundleId);
        body =
          format === 'storage-state'
            ? toStorageState(cookies)
            : format === 'json'
              ? JSON.stringify(cookies, null, 2)
              : toNetscape(cookies);
      } else {
        body = await agentGet(args, `/agent/cookies?format=${encodeURIComponent(format)}`);
      }
      const out = flagString(args, 'out');
      if (out) {
        fs.writeFileSync(out, body, { mode: 0o600 });
        console.log(`wrote ${out}`);
      } else {
        process.stdout.write(body);
      }
      return;
    }
    case 'header': {
      const target = flagString(args, 'url-target');
      if (!target) throw new CliError('--url-target <url> is required');
      const bundleId = flagString(args, 'bundle');
      if (bundleId) {
        console.log(cookieHeaderFor(await localBundleCookies(bundleId), target));
        return;
      }
      const body = await agentGet(args, `/agent/cookies?format=header&url=${encodeURIComponent(target)}`);
      console.log((JSON.parse(body) as { cookie: string }).cookie);
      return;
    }
    default:
      console.log(HELP);
      process.exit(args.command === 'help' || args.command === '--help' ? 0 : 2);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
