#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server/index.js';
import { runMcpServer } from './mcp/server.js';
import { readAllProfiles } from './core/browsers/index.js';
import { bareDomain } from './core/bundles.js';

// node:sqlite is how we read cookie stores; its experimental banner is noise here.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name !== 'ExperimentalWarning') console.warn(`${warning.name}: ${warning.message}`);
});

const DEFAULT_PORT = Number(process.env.COOKIEJAR_PORT ?? 4088);
const DEFAULT_URL = process.env.COOKIEJAR_URL ?? `http://127.0.0.1:${DEFAULT_PORT}`;

interface Args {
  command: string;
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | boolean>();
  const [command = 'ui', ...rest] = argv;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) continue;
    const [name, inline] = arg.slice(2).split('=', 2);
    if (inline !== undefined) flags.set(name, inline);
    else if (rest[i + 1] && !rest[i + 1].startsWith('--')) flags.set(name, rest[++i]);
    else flags.set(name, true);
  }
  return { command, flags };
}

const flagString = (args: Args, name: string, fallback?: string): string | undefined => {
  const value = args.flags.get(name);
  return typeof value === 'string' ? value : fallback;
};

function openBrowser(url: string): void {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(opener, [url], () => {
    // Opening a browser is a convenience; the URL is printed regardless.
  });
}

function uiDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.join(here, 'ui'), path.join(here, '..', 'ui', 'dist'), path.join(here, '..', 'dist', 'ui')]) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return path.join(here, 'ui');
}

function requireToken(args: Args): string {
  const token = flagString(args, 'token') ?? process.env.COOKIEJAR_TOKEN;
  if (!token) {
    console.error('A bundle token is required. Pass --token or set COOKIEJAR_TOKEN.');
    process.exit(2);
  }
  return token;
}

async function agentGet(args: Args, path: string): Promise<string> {
  const base = flagString(args, 'url', DEFAULT_URL)!;
  const response = await fetch(new URL(path, base), { headers: { authorization: `Bearer ${requireToken(args)}` } });
  const text = await response.text();
  if (!response.ok) {
    console.error(text);
    process.exit(1);
  }
  return text;
}

const HELP = `cookiejar — local-only cookie bundles for coding agents

Usage:
  cookiejar ui [--port ${DEFAULT_PORT}] [--open] [--auto-lock <minutes>]
      Start the local app (127.0.0.1 only) to manage cookies and bundles.

  cookiejar mcp [--token <token>] [--url ${DEFAULT_URL}]
      Speak MCP over stdio so an agent can use one bundle. Token via
      --token or COOKIEJAR_TOKEN.

  cookiejar export [--format netscape|storage-state|json] [--out <file>]
      Write a bundle's cookies to a jar file.

  cookiejar header --url-target <url>
      Print the Cookie header for a URL covered by the bundle.

  cookiejar doctor
      Show which browser profiles cookiejar can read on this machine.
`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case 'ui': {
      const port = Number(flagString(args, 'port', String(DEFAULT_PORT)));
      const autoLock = Number(flagString(args, 'auto-lock', '30'));
      const { url } = await startServer({ port, uiDir: uiDir(), autoLockMinutes: autoLock });
      console.log(`cookiejar is running at ${url}`);
      console.log(`vault: ${process.env.COOKIEJAR_HOME ?? '~/.cookiejar'}  ·  auto-lock: ${autoLock || 'off'}`);
      if (args.flags.get('open')) openBrowser(url);
      return;
    }
    case 'mcp': {
      runMcpServer({ daemonUrl: flagString(args, 'url', DEFAULT_URL)!, token: requireToken(args) });
      return;
    }
    case 'export': {
      const format = flagString(args, 'format', 'netscape')!;
      const body = await agentGet(args, `/agent/cookies?format=${encodeURIComponent(format)}`);
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
      if (!target) {
        console.error('--url-target <url> is required');
        process.exit(2);
      }
      const body = await agentGet(args, `/agent/cookies?format=header&url=${encodeURIComponent(target)}`);
      console.log((JSON.parse(body) as { cookie: string }).cookie);
      return;
    }
    case 'doctor': {
      const reads = readAllProfiles();
      if (reads.length === 0) console.log('No browser profiles found.');
      for (const read of reads) {
        const sites = new Set(read.cookies.map((c) => bareDomain(c.domain))).size;
        console.log(
          read.error
            ? `✗ ${read.profile.label} (${read.profile.id})\n    ${read.error}`
            : `✓ ${read.profile.label} (${read.profile.id}) — ${read.cookies.length} cookies across ${sites} sites`,
        );
      }
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
