import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/**
 * The parts that exist so an agent has a bearable time: a page as text rather
 * than 200KB of markup, one bundle over MCP with no daemon and no token, a
 * Playwright handoff, and a loan that can be given more time instead of dying
 * mid-task.
 */

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cookiejar-dx-'));
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');

const PAGE = `<!doctype html><html><head><title>Your issues</title>
<style>.a{color:red}</style><script>window.__DATA__={"noise":"${'x'.repeat(4000)}"}</script></head>
<body><nav><a href="/home">Home</a></nav>
<h1>Assigned to you</h1>
<ul><li><a href="/issue/7">Ship the thing</a> &mdash; due Friday</li>
<li>Nothing else</li></ul>
<script>console.log('more noise')</script></body></html>`;

function seed(): void {
  const dir = path.join(home, '.config', 'google-chrome', 'Default');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'Cookies'));
  db.exec(`CREATE TABLE cookies (
    host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
    expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER)`);
  db.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    '.localhost',
    'session',
    'dx-secret-value',
    new Uint8Array(0),
    '/',
    0,
    0,
    1,
    1,
  );
  db.close();
}

seed();
process.env.HOME = home;
process.env.COOKIEJAR_HOME = path.join(home, '.cookiejar');
process.env.COOKIEJAR_KEYRING = 'file';

const env = (): NodeJS.ProcessEnv => ({
  ...process.env,
  HOME: home,
  COOKIEJAR_HOME: path.join(home, '.cookiejar'),
  COOKIEJAR_KEYRING: 'file',
  COOKIEJAR_PASSWORD: undefined,
  COOKIEJAR_TOKEN: undefined,
  COOKIEJAR_URL: undefined,
});

const run = (...args: string[]): string =>
  execFileSync(process.execPath, ['--import', 'tsx', cli, ...args], { encoding: 'utf8', env: env() });

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test('a page comes back as text an agent can afford to read', async () => {
  const { readable, htmlToText } = await import('../src/core/readable.js');
  const page = readable(PAGE);

  assert.equal(page.title, 'Your issues');
  assert.match(page.text, /# Assigned to you/);
  assert.match(page.text, /\[Ship the thing\]\(\/issue\/7\)/, 'links survive, so the agent can navigate');
  assert.match(page.text, /— due Friday/, 'entities are decoded');
  assert.doesNotMatch(page.text, /__DATA__|console\.log|color:red/, 'script and style are gone');
  assert.ok(page.text.length * 10 < page.originalBytes, `expected a big reduction, got ${page.text.length}/${page.originalBytes}`);

  // A truncated page (an unclosed script at the cut) must not leak its source.
  assert.doesNotMatch(htmlToText('<p>hi</p><script>var a = "secret"'), /secret/);
});

test('an unauthorized API says why, instead of just 401', async () => {
  const { authHint } = await import('../src/core/hints.js');
  assert.match(authHint(new URL('https://api.github.com/user'), 401, '{}')!, /personal access token/);
  assert.match(authHint(new URL('https://api.other.dev/v1/me'), 401, '{}')!, /API key/);
  assert.equal(authHint(new URL('https://github.com/'), 200, 'fine'), undefined);
  assert.equal(authHint(new URL('https://github.com/x'), 404, 'nope'), undefined);
});

test('one bundle over MCP, with no daemon and no token', async () => {
  run('setup', '--browsers', 'chrome');
  const bundleId = /created (\S+)/.exec(run('bundle', 'new', 'local agent'))![1];
  run('bundle', 'add', bundleId, 'localhost', '--names', 'session');

  const site = spawn(process.execPath, [
    '-e',
    `require('http').createServer((q, s) => {
       s.writeHead(200, { 'content-type': 'text/html' });
       s.end(${JSON.stringify(PAGE)} + '<p>cookie: ' + (q.headers.cookie || 'none') + '</p>');
     }).listen(0, function () { console.log(this.address().port); });`,
  ]);
  const port = await new Promise<string>((resolve) =>
    site.stdout.once('data', (chunk: Buffer) => resolve(chunk.toString().trim())),
  );

  const mcp = spawn(process.execPath, ['--import', 'tsx', cli, 'mcp', '--bundle', bundleId], { env: env() });
  const replies: Record<string, unknown>[] = [];
  mcp.stdout.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) replies.push(JSON.parse(line) as Record<string, unknown>);
  });
  const send = (id: number, method: string, params?: unknown): Promise<Record<string, unknown>> => {
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 20_000;
      const poll = setInterval(() => {
        const found = replies.find((reply) => reply.id === id);
        if (found) {
          clearInterval(poll);
          resolve(found);
        } else if (Date.now() > deadline) {
          clearInterval(poll);
          reject(new Error(`no reply to ${method}`));
        }
      }, 25);
    });
  };
  const text = (reply: Record<string, unknown>): string =>
    ((reply.result as { content: { text: string }[] }).content[0].text);

  await send(1, 'initialize');
  const listed = (await send(2, 'tools/list')).result as { tools: { name: string }[] };
  const names = listed.tools.map((tool) => tool.name);
  assert.ok(names.includes('read_page'), 'read_page is offered');
  assert.ok(names.includes('browser_context'), 'the browser handoff is local-only, and this is local');

  const described = JSON.parse(text(await send(3, 'tools/call', { name: 'describe_bundle', arguments: {} }))) as {
    hosts: string[];
    local: boolean;
  };
  assert.deepEqual(described.hosts, ['localhost']);
  assert.equal(described.local, true);

  const page = JSON.parse(
    text(await send(4, 'tools/call', { name: 'read_page', arguments: { url: `http://localhost:${port}/` } })),
  ) as { title: string; body: string; extracted: { from: number; to: number } };
  assert.equal(page.title, 'Your issues');
  assert.match(page.body, /cookie: session=dx-secret-value/, 'the local agent is signed in');
  assert.doesNotMatch(page.body, /__DATA__/);
  assert.ok(page.extracted.to < page.extracted.from / 5);

  const outside = await send(5, 'tools/call', { name: 'read_page', arguments: { url: 'https://example.com/' } });
  assert.match(text(outside), /holds no cookies for example.com/, 'the fence applies locally too');

  const handed = JSON.parse(text(await send(6, 'tools/call', { name: 'browser_context', arguments: {} }))) as {
    storageState: string;
  };
  const state = JSON.parse(fs.readFileSync(handed.storageState, 'utf8')) as { cookies: { name: string }[] };
  assert.deepEqual(state.cookies.map((cookie) => cookie.name), ['session']);
  assert.equal(fs.statSync(handed.storageState).mode & 0o777, 0o600, 'a real session on disk is 0600');

  mcp.stdin.end();
  await new Promise<void>((done) => mcp.on('exit', () => done()));
  site.kill();

  // The same handoff from the terminal, with a snippet the human can run.
  const printed = run('browser', bundleId);
  assert.match(printed, /storageState/);
  assert.match(printed, /1 cookies, real values/);
  assert.doesNotMatch(printed, /dx-secret-value/, 'the value goes in the file, not the terminal');
});

test('a client config is written, not explained', () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'cookiejar-project-'));
  const bundleId = run('bundles').trim().split(/\s+/)[0];

  run('mcp', '--install', 'claude', '--bundle', bundleId, '--dir', project);
  const config = JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8')) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  assert.deepEqual(config.mcpServers.cookiejar.args, ['-y', '@puffle/cookiejar', 'mcp', '--bundle', bundleId, '--manage']);

  // An existing config keeps its other servers.
  fs.writeFileSync(path.join(project, '.cursor-seed.json'), '');
  fs.mkdirSync(path.join(project, '.cursor'), { recursive: true });
  fs.writeFileSync(path.join(project, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  run('mcp', '--install', 'cursor', '--bundle', bundleId, '--dir', project);
  const cursor = JSON.parse(fs.readFileSync(path.join(project, '.cursor', 'mcp.json'), 'utf8')) as {
    mcpServers: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(cursor.mcpServers).sort(), ['cookiejar', 'other']);

  assert.throws(() => run('mcp', '--install', 'emacs'), /--install takes one of/);
  assert.throws(() => run('mcp', '--install', 'claude', '--bundle', 'nope', '--dir', project), /no such bundle/);
  fs.rmSync(project, { recursive: true, force: true });
});

test('a loan can be given more time instead of dying mid-task', () => {
  const bundleId = run('bundles').trim().split(/\s+/)[0];
  run('token', 'new', bundleId, '--label', 'cloud', '--days', '1', '--proxy-only');

  const extended = run('token', 'extend', bundleId, '--minutes', '30');
  assert.match(extended, /now runs until/);
  assert.match(extended, /no reconnect needed/);
  assert.match(run('activity'), /grant_extended/);

  assert.throws(() => run('token', 'extend', bundleId, '--minutes', '0'), /positive number/);
  assert.throws(() => run('token', 'extend', bundleId, 'ffffffffffff'), /no live token/);
});
