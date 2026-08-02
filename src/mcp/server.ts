import readline from 'node:readline';
import { VERSION } from '../core/version.js';
import { MANAGE_TOOLS, runManageTool } from './manage.js';
import { describeBundle, exportCookies, proxyRequest, type CookieFormat } from '../core/agent.js';
import { writeBrowserState } from '../core/browserstate.js';
import type { Vault } from '../core/vault.js';

/**
 * A dependency-free MCP stdio server. It holds no cookies itself: every tool
 * call goes to the local cookiejar daemon with the bundle token, so the vault
 * has to be unlocked for anything to work.
 */
export interface McpOptions {
  daemonUrl: string;
  /** Absent in manage-only mode, where there is no bundle to borrow. */
  token?: string;
  /**
   * An unlocked vault, for an agent on this machine that is allowed to keep
   * bundles tidy. With it the server also offers the management tools; without
   * it the agent can only use the one bundle its token covers.
   */
  manage?: Vault;
  /**
   * One bundle, straight out of the local vault. An agent on this machine has
   * no business starting a daemon and minting itself a token to reach cookies
   * it could already read, so in this mode there is neither.
   */
  local?: { vault: Vault; bundleId: string };
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: 'describe_bundle',
    description:
      'Describe the cookie bundle this session can use: its name, the hosts it is authenticated for, and what the token is allowed to do.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_cookie_header',
    description:
      'Return the Cookie header value to send with a request to a URL covered by the bundle. Use this when you want to make the request yourself.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute URL the header will be sent to.' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'export_cookies',
    description:
      'Export the bundle as a cookie jar. Formats: "netscape" (curl -b / yt-dlp / python-requests), "storage-state" (Playwright/Puppeteer), "json".',
    inputSchema: {
      type: 'object',
      properties: { format: { type: 'string', enum: ['netscape', 'storage-state', 'json'] } },
      required: ['format'],
      additionalProperties: false,
    },
  },
  {
    name: 'http_request',
    description:
      'Perform an HTTP request against a host in the bundle with its cookies attached, without ever exposing the cookie values. Returns the raw body: for a web page prefer read_page.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        method: { type: 'string', default: 'GET' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        body: { type: 'string' },
        as: { type: 'string', enum: ['html', 'text'], description: '"text" reduces an HTML page to readable text.' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'read_page',
    description:
      'Fetch a page as the signed-in user and return it as readable text with links kept, rather than raw HTML. This is the cheap way to read anything behind a login.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
] as const;

/**
 * Only offered locally: it writes real cookie values to disk for Playwright,
 * which is exactly what a lent, proxy-only bundle must never allow.
 */
const BROWSER_TOOL = {
  name: 'browser_context',
  description:
    'Write a Playwright/Puppeteer storageState file for this bundle and return its path, so you can drive a real browser already signed in as the user. Local bundles only.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: 'Where to write it. Defaults to a 0600 file under the cookiejar home.' } },
    additionalProperties: false,
  },
} as const;

export function runMcpServer(options: McpOptions): void {
  const tools = [
    ...(options.token || options.local ? TOOLS : []),
    ...(options.local ? [BROWSER_TOOL] : []),
    ...(options.manage ? MANAGE_TOOLS : []),
  ];
  const input = options.stdin ?? process.stdin;
  const output = options.stdout ?? process.stdout;
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let inFlight = 0;
  let closed = false;
  const maybeExit = (): void => {
    if (closed && inFlight === 0) process.exit(0);
  };

  const write = (message: unknown): void => {
    output.write(`${JSON.stringify(message)}\n`);
  };

  const call = async (path: string, init?: RequestInit): Promise<string> => {
    const response = await fetch(new URL(path, options.daemonUrl), {
      ...init,
      headers: { ...(init?.headers ?? {}), authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`cookiejar daemon: ${response.status} ${text}`);
    return text;
  };

  /** The same four tools, answered from the vault instead of over the wire. */
  const runLocalTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const { vault, bundleId } = options.local!;
    const bundle = vault.bundle(bundleId);
    switch (name) {
      case 'describe_bundle':
        return JSON.stringify(
          { ...describeBundle(bundle), permissions: { allowFetch: true, redactValues: false }, local: true },
          null,
          2,
        );
      case 'get_cookie_header':
        return JSON.stringify({ cookie: exportCookies(bundle, 'header', String(args.url)) });
      case 'export_cookies':
        return exportCookies(bundle, String(args.format) as CookieFormat);
      case 'browser_context': {
        const file = writeBrowserState(bundle, args.path ? String(args.path) : undefined);
        return JSON.stringify({ storageState: file, use: `chromium.launchPersistentContext / browser.newContext({ storageState: "${file}" })` }, null, 2);
      }
      case 'http_request':
      case 'read_page':
        return JSON.stringify(
          await proxyRequest(bundle, {
            url: String(args.url),
            method: args.method ? String(args.method) : undefined,
            headers: args.headers as Record<string, string> | undefined,
            body: args.body ? String(args.body) : undefined,
            as: name === 'read_page' ? 'text' : (args.as as 'html' | 'text' | undefined),
          }),
          null,
          2,
        );
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  };

  const runTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    if (options.manage && MANAGE_TOOLS.some((tool) => tool.name === name)) {
      return JSON.stringify(await runManageTool(options.manage, name, args), null, 2);
    }
    if (options.local) return runLocalTool(name, args);
    if (!options.token) throw new Error('this cookiejar MCP server has no bundle token; it can only manage bundles');
    switch (name) {
      case 'describe_bundle':
        return call('/agent/bundle');
      case 'get_cookie_header':
        return call(`/agent/cookies?format=header&url=${encodeURIComponent(String(args.url))}`);
      case 'export_cookies':
        return call(`/agent/cookies?format=${encodeURIComponent(String(args.format))}`);
      case 'http_request':
        return call('/agent/fetch', { method: 'POST', body: JSON.stringify(args) });
      case 'read_page':
        return call('/agent/fetch', { method: 'POST', body: JSON.stringify({ url: args.url, as: 'text' }) });
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  };

  rl.on('line', (line) => {
    if (!line.trim()) return;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      return;
    }

    const reply = (result: unknown): void => {
      if (request.id === undefined) return;
      write({ jsonrpc: '2.0', id: request.id, result });
    };
    const fail = (message: string): void => {
      if (request.id === undefined) return;
      write({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message } });
    };

    switch (request.method) {
      case 'initialize':
        reply({
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'cookiejar', version: VERSION },
        });
        return;
      case 'notifications/initialized':
        return;
      case 'ping':
        reply({});
        return;
      case 'tools/list':
        reply({ tools });
        return;
      case 'tools/call': {
        const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        inFlight += 1;
        void runTool(params.name ?? '', params.arguments ?? {})
          .then((text) => reply({ content: [{ type: 'text', text }] }))
          .catch((error: unknown) =>
            reply({ content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true }),
          )
          .finally(() => {
            inFlight -= 1;
            maybeExit();
          });
        return;
      }
      default:
        fail(`unsupported method: ${request.method}`);
    }
  });

  // Finish any tool call already in flight before shutting down.
  rl.on('close', () => {
    closed = true;
    maybeExit();
  });
}
