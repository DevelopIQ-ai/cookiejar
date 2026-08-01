import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { ensureConfigDir } from './paths.js';

/**
 * A throwaway public https address for the loopback daemon, so a coding agent
 * that is not on this machine can reach it. Nothing about the tunnel grants
 * access: the bearer token still does, and it still expires.
 */
export interface Tunnel {
  url: string;
  stop(): void;
}

const TRYCLOUDFLARE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/**
 * One pinned cloudflared release with the digest of every asset we will run.
 * A tunnel binary that changes under us is a supply-chain hole, so "latest" is
 * deliberately not used and a mismatch is fatal.
 */
const CLOUDFLARED_VERSION = '2025.7.0';
const CLOUDFLARED_SHA256: Record<string, string> = {
  'cloudflared-darwin-amd64.tgz': '5521eee928d60124b5849e3f3cc97690e2ee16fe2bf085e0291b8ad5df01f735',
  'cloudflared-darwin-arm64.tgz': 'bd5804fe4c9d235414f4db3e6359a0401824dab5692f8fa5040ba2298b1aecaf',
  'cloudflared-linux-amd64': '51e3909335fd7ba2ed5c696b0a6fb7d4a74f6a15bf36615cea0fccba620cfb3f',
  'cloudflared-linux-arm64': 'db86f73e07133ca3e0e63b8158dbaacf39f5dd4458260cb95ccf12b35c1b6cd9',
};

const INSTALL_HINT =
  process.platform === 'darwin'
    ? 'brew install cloudflared'
    : 'see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';

const onPath = (command: string): string | null => {
  const found = spawnSync(process.platform === 'win32' ? 'where' : 'sh', process.platform === 'win32' ? [command] : ['-c', `command -v ${command}`], {
    encoding: 'utf8',
  });
  return found.status === 0 ? found.stdout.trim().split('\n')[0] : null;
};

function assetName(): string {
  const arch = os.arch() === 'arm64' ? 'arm64' : 'amd64';
  if (process.platform === 'darwin') return `cloudflared-darwin-${arch}.tgz`;
  if (process.platform === 'linux') return `cloudflared-linux-${arch}`;
  throw new Error(`cookiejar cannot fetch cloudflared for ${process.platform} — install it yourself (${INSTALL_HINT})`);
}

/**
 * Uses cloudflared if it is installed, and otherwise fetches the pinned
 * release into ~/.cookiejar/bin once, refusing anything whose digest does not
 * match. Handing a bundle to a cloud agent should not start with an install,
 * but it also should not run whatever the network hands back.
 */
export async function ensureCloudflared(log: (line: string) => void = () => {}): Promise<string> {
  const installed = onPath('cloudflared');
  if (installed) return installed;

  const dir = path.join(ensureConfigDir(), 'bin');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const binary = path.join(dir, `cloudflared-${CLOUDFLARED_VERSION}`);
  if (fs.existsSync(binary)) return binary;

  const asset = assetName();
  const expected = CLOUDFLARED_SHA256[asset];
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset}`;
  log(`fetching cloudflared ${CLOUDFLARED_VERSION} (once) — ${url}`);

  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`could not download cloudflared (${response.status}) — install it yourself: ${INSTALL_HINT}`);
  }
  const body = Buffer.from(await response.arrayBuffer());
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  if (digest !== expected) {
    throw new Error(`the cloudflared download does not match its pinned checksum — refusing to run it (${INSTALL_HINT})`);
  }

  // Staged beside the target, then renamed, so a half-written binary is never
  // runnable and the rename stays on one filesystem.
  const staging = fs.mkdtempSync(path.join(dir, 'staging-'));
  try {
    let unpacked: string;
    if (asset.endsWith('.tgz')) {
      const archive = path.join(staging, asset);
      fs.writeFileSync(archive, body);
      const untar = spawnSync('tar', ['-xzf', archive, '-C', staging], { encoding: 'utf8' });
      if (untar.status !== 0) throw new Error(`could not unpack cloudflared: ${untar.stderr}`);
      unpacked = path.join(staging, 'cloudflared');
    } else {
      unpacked = path.join(staging, 'cloudflared');
      fs.writeFileSync(unpacked, body);
    }
    fs.chmodSync(unpacked, 0o700);
    fs.renameSync(unpacked, binary);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return binary;
}

/** Starts a quick tunnel and resolves once cloudflared prints its public URL. */
export async function startTunnel(port: number, log: (line: string) => void = () => {}): Promise<Tunnel> {
  const binary = await ensureCloudflared(log);
  const child: ChildProcess = spawn(binary, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const stop = (): void => {
    child.kill('SIGTERM');
  };

  return new Promise<Tunnel>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        stop();
        reject(new Error('cloudflared did not produce a URL in 45s'));
      });
    }, 45_000);

    const scan = (chunk: Buffer): void => {
      const found = TRYCLOUDFLARE.exec(chunk.toString());
      if (found) finish(() => resolve({ url: found[0], stop }));
    };

    child.stdout?.on('data', scan);
    child.stderr?.on('data', scan);
    child.on('error', (error) => finish(() => reject(error)));
    child.on('exit', (code) => finish(() => reject(new Error(`cloudflared exited with code ${code}`))));
  });
}
