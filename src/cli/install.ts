/**
 * Wiring cookiejar into whatever agent the user already runs.
 *
 * Every client wants the same three facts — a command, its arguments, a name —
 * in a different file and a different shape, and getting one comma wrong fails
 * silently at the next launch. Writing it is a five-line job for us and a
 * fifteen-minute one for a person.
 */
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { CliError } from './vault.js';

export const CLIENTS = ['claude', 'cursor', 'codex', 'vscode'] as const;
export type Client = (typeof CLIENTS)[number];

export const isClient = (value: string): value is Client => (CLIENTS as readonly string[]).includes(value);

interface Target {
  /** Where the config lives, and whether that is a project or the whole machine. */
  file: (dir: string) => string;
  scope: 'project' | 'machine';
  /** Where in the JSON document the servers live; TOML clients use `toml`. */
  key?: string;
  toml?: boolean;
  note?: string;
}

const TARGETS: Record<Client, Target> = {
  claude: { file: (dir) => path.join(dir, '.mcp.json'), scope: 'project', key: 'mcpServers', note: 'Claude Code reads .mcp.json from the project root.' },
  cursor: { file: (dir) => path.join(dir, '.cursor', 'mcp.json'), scope: 'project', key: 'mcpServers' },
  vscode: { file: (dir) => path.join(dir, '.vscode', 'mcp.json'), scope: 'project', key: 'servers' },
  codex: { file: () => path.join(homedir(), '.codex', 'config.toml'), scope: 'machine', toml: true, note: 'Codex keeps MCP servers in ~/.codex/config.toml, not per project.' },
};

export interface InstallOptions {
  client: Client;
  /** The bundle the agent gets. Omitted means management tools only. */
  bundleId?: string;
  dir?: string;
  name?: string;
}

export interface Installed {
  file: string;
  name: string;
  created: boolean;
  note?: string;
}

const commandFor = (bundleId?: string): { command: string; args: string[] } => ({
  command: 'npx',
  args: ['-y', '@puffle/cookiejar', 'mcp', ...(bundleId ? ['--bundle', bundleId] : []), '--manage'],
});

function installToml(target: Target, name: string, bundleId?: string): Installed {
  const file = target.file('');
  const { command, args } = commandFor(bundleId);
  const created = !fs.existsSync(file);
  const existing = created ? '' : fs.readFileSync(file, 'utf8');
  const header = `[mcp_servers.${name}]`;
  if (existing.includes(header)) {
    throw new CliError(`${file} already has ${header} — edit it by hand, or pass --name <other>`);
  }
  const block = `\n${header}\ncommand = "${command}"\nargs = [${args.map((arg) => `"${arg}"`).join(', ')}]\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, existing.trimEnd() + (existing.trim() ? '\n' : '') + block, { mode: 0o600 });
  return { file, name, created, note: target.note };
}

export function installMcpClient(options: InstallOptions): Installed {
  const target = TARGETS[options.client];
  const name = options.name ?? 'cookiejar';
  if (target.toml) return installToml(target, name, options.bundleId);

  const file = target.file(options.dir ?? process.cwd());
  const created = !fs.existsSync(file);
  let document: Record<string, unknown> = {};
  if (!created) {
    try {
      document = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      throw new CliError(`${file} is not valid JSON — fix or move it first`);
    }
  }
  const key = target.key!;
  const servers = (document[key] ?? {}) as Record<string, unknown>;
  servers[name] = commandFor(options.bundleId);
  document[key] = servers;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`);
  return { file, name, created, note: target.note };
}
