#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { startServer } from './server/index.js';
import { runMcpServer } from './mcp/server.js';
import { cookieHeaderFor, resolveBundle, toNetscape, toStorageState } from './core/bundles.js';
import { CliError, daemonHoldsVault, openVault } from './cli/vault.js';
import * as cmd from './cli/commands.js';
import { lend } from './cli/lend.js';
import { CLIENTS, installMcpClient, isClient } from './cli/install.js';
import { loadConnection } from './core/connect.js';
import { readable } from './core/readable.js';
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

/**
 * A refused request is nearly always an expired loan, and "403" alone sends an
 * agent hunting for a bug that is not there.
 */
function expiredHint(status: number, body: string): string {
  if (status !== 403) return body;
  if (/expired/i.test(body)) {
    return `${body}\nAsk the lender for "cookiejar token extend" — or a fresh cookiejar lend — then run cookiejar connect again.`;
  }
  if (/revoked|unknown bundle token/i.test(body)) {
    return `${body}\nThe lender ended this loan. Nothing on your side will bring it back.`;
  }
  return body;
}

/** A token and address from a flag, the environment, or a bundle lent to us. */
function borrowed(args: Args): { url: string; token?: string } {
  const saved = loadConnection();
  return {
    url: flagString(args, 'url') ?? process.env.COOKIEJAR_URL ?? saved?.url ?? DEFAULT_URL,
    token: flagString(args, 'token') ?? process.env.COOKIEJAR_TOKEN ?? saved?.token,
  };
}

function requireToken(args: Args): string {
  const { token } = borrowed(args);
  if (!token) {
    throw new CliError('A bundle token is required — run cookiejar connect <string>, pass --token, or set COOKIEJAR_TOKEN.');
  }
  return token;
}

async function agentGet(args: Args, route: string): Promise<string> {
  const base = borrowed(args).url;
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

A CLI, with an optional local UI (cookiejar ui). The jar's key lives in your
OS keyring, so nothing asks you for a password unless you set one.

Setting up
  cookiejar setup [--browsers chrome,firefox]  Pick your browsers; explains Safari's permission
  cookiejar status                       Where the jar is, what is readable, what exists
  cookiejar doctor                       Which browser profiles can be read, and why not
  cookiejar profiles                     Every discovered profile, including empty ones
  cookiejar passwd                       Put a master password on the jar
  cookiejar passwd --none                Keep the key in the OS keyring: no prompts
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

Lending a bundle to an agent somewhere else
  cookiejar lend <bundle> [--minutes 60] [--values] [--local]
      Serve it, tunnel it, mint a short proxy-only token, print one string.
      Ctrl-C revokes the token and takes the address down.
  cookiejar token extend <bundle> [<token-id>] [--minutes 30]
      Give a running loan more time; the agent needs no reconnect
  cookiejar tail [--bundle <id>]        Watch what an agent is doing, live
  cookiejar connect <string>            On the agent's side: check it and remember it
  cookiejar fetch <url> [--text|--json] [--method POST] [--data <body>]
      Request a site as the lender. --text strips a page to readable text.
  cookiejar disconnect                  Forget a bundle lent to this machine

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

Agents on this machine
  cookiejar mcp --bundle <id> [--manage]
      Serve one bundle over MCP straight from the jar: no daemon, no token.
      --manage also lets the agent edit bundles and issue tokens.
  cookiejar mcp --install claude|cursor|codex|vscode [--bundle <id>]
      Write that client's MCP config for you
  cookiejar browser <bundle> [--out <file>]
      A Playwright storageState file, for an agent that must click things

Being an agent elsewhere
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
      const install = flagString(args, 'install');
      const bundleId = flagString(args, 'bundle');
      if (install) {
        if (!isClient(install)) throw new CliError(`--install takes one of: ${CLIENTS.join(', ')}`);
        // Fail before writing a config that points at a bundle which is not there.
        if (bundleId) (await openVault()).bundle(bundleId);
        const done = installMcpClient({ client: install, bundleId, dir: flagString(args, 'dir'), name: flagString(args, 'name') });
        console.log(`${done.created ? 'wrote' : 'updated'} ${done.file} — MCP server "${done.name}"`);
        if (done.note) console.log(done.note);
        console.log(bundleId ? `it serves the ${bundleId} bundle; restart the client to pick it up` : 'it can manage bundles; add --bundle <id> to also use one');
        return;
      }
      const manage = flagBool(args, 'manage');
      const { url, token } = borrowed(args);
      if (!manage && !bundleId && !token) requireToken(args);
      const vault = manage || bundleId ? await openVault() : undefined;
      if (bundleId) vault!.bundle(bundleId); // a bad id should fail now, not on the first tool call
      runMcpServer({
        daemonUrl: url,
        token: bundleId ? undefined : token,
        manage: manage ? vault : undefined,
        local: bundleId ? { vault: vault!, bundleId } : undefined,
      });
      return;
    }
    case 'browser': {
      cmd.browserHandoff(await openVault(), positional(args, 0, 'a bundle id'), flagString(args, 'out'));
      return;
    }
    case 'tail': {
      cmd.tail(flagString(args, 'bundle'), {
        onStop: (stop) => {
          process.on('SIGINT', () => {
            stop();
            process.exit(0);
          });
        },
      });
      return;
    }
    case 'lend': {
      await lend(await openVault(), positional(args, 0, 'a bundle id'), {
        minutes: flagNumber(args, 'minutes', 60),
        port: flagNumber(args, 'port', DEFAULT_PORT),
        values: flagBool(args, 'values'),
        local: flagBool(args, 'local'),
        label: flagString(args, 'label'),
      });
      return;
    }
    case 'connect': {
      await cmd.connect(positional(args, 0, 'a connect string'), { save: !flagBool(args, 'no-save') });
      return;
    }
    case 'disconnect': {
      cmd.disconnect();
      return;
    }
    case 'fetch': {
      const target = positional(args, 0, 'a url');
      const asText = flagBool(args, 'text');
      const { url } = borrowed(args);
      const response = await fetch(new URL('/agent/fetch', url), {
        method: 'POST',
        headers: { authorization: `Bearer ${requireToken(args)}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          url: target,
          method: flagString(args, 'method', 'GET'),
          body: flagString(args, 'data'),
          as: asText ? 'text' : undefined,
        }),
      });
      const text = await response.text();
      if (!response.ok) throw new CliError(expiredHint(response.status, text));
      const result = JSON.parse(text) as {
        status: number;
        body: string;
        title?: string;
        hint?: string;
        extracted?: { from: number; to: number };
      };
      if (result.status >= 400) console.error(`upstream returned ${result.status}`);
      if (result.hint) console.error(`hint: ${result.hint}`);
      // An older lender does not know --text, so fall back to extracting here.
      const body = asText && !result.extracted ? readable(result.body).text : result.body;
      if (asText && result.title) console.error(`title: ${result.title}`);
      if (flagBool(args, 'json')) {
        try {
          console.log(JSON.stringify(JSON.parse(body) as unknown, null, 2));
          return;
        } catch {
          console.error('that response is not JSON; printing it as it came');
        }
      }
      process.stdout.write(body.endsWith('\n') ? body : `${body}\n`);
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
      // openVault has already proved we can open the jar, so nothing asks twice.
      const vault = await openVault();
      if (flagBool(args, 'none')) cmd.useKeyring(vault);
      else await cmd.setPassword(vault);
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
      if (sub === 'extend') {
        cmd.extendGrant(
          await openVault(),
          positional(args, 1, 'a bundle id'),
          args.rest[2],
          flagNumber(args, 'minutes', 30),
        );
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
      throw new CliError(
        'use: cookiejar token new <bundle> | cookiejar token extend <bundle> [<token-id>] | cookiejar token revoke <bundle> <token-id> | cookiejar token revoke --all',
      );
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
