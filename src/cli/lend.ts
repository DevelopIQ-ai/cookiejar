import { encodeConnection } from '../core/connect.js';
import { grantId, issueGrant, revokeGrant } from '../core/manage.js';
import { startTunnel, type Tunnel } from '../core/tunnel.js';
import { startServer } from '../server/index.js';
import type { Vault } from '../core/vault.js';
import { CliError } from './vault.js';

export interface LendOptions {
  minutes: number;
  port: number;
  /** Let the agent read the cookie values, instead of only making requests through them. */
  values?: boolean;
  /** Skip the tunnel: the agent is on this machine. */
  local?: boolean;
  label?: string;
}

const minutesLeft = (until: number): number => Math.max(0, Math.ceil((until - Date.now()) / 60_000));

/**
 * The whole handover in one command: serve the bundle, put it behind a public
 * https address, mint a short proxy-only token, and print the single string an
 * agent needs. Ctrl-C revokes the token and takes the address down, so nothing
 * is left open by accident.
 */
export async function lend(vault: Vault, bundleId: string, opts: LendOptions): Promise<void> {
  const bundle = vault.bundle(bundleId);
  if (bundle.selectors.length === 0) {
    throw new CliError(`${bundleId} has no sites yet — cookiejar bundle add ${bundleId} <site>`);
  }
  if (!Number.isFinite(opts.minutes) || opts.minutes <= 0) throw new CliError('--minutes must be a positive number');

  const { url: localUrl, close } = await startServer({ port: opts.port, vault, autoLockMinutes: 0 }).catch(
    (error: NodeJS.ErrnoException) => {
      throw error.code === 'EADDRINUSE'
        ? new CliError(`port ${opts.port} is busy — another cookiejar is running, or pass --port`)
        : error;
    },
  );

  let tunnel: Tunnel | null = null;
  if (!opts.local) {
    console.log('opening a tunnel…');
    try {
      tunnel = await startTunnel(opts.port, (line) => console.log(line));
    } catch (error) {
      // No address means no loan: do not leave the daemon serving for nothing.
      await close();
      throw error;
    }
  }
  const publicUrl = tunnel?.url ?? localUrl;

  const { token, grant } = issueGrant(vault, bundleId, {
    label: opts.label ?? 'lent agent',
    expiresInDays: opts.minutes / 1440,
    allowFetch: true,
    redactValues: !opts.values,
  });
  const id = grantId(grant);
  const until = Date.now() + opts.minutes * 60_000;

  console.log(`\n${bundle.name} is lent for ${opts.minutes} minutes${opts.values ? '' : ', proxy only'}. Give the agent this:\n`);
  console.log(`  ${encodeConnection({ url: publicUrl, token, bundle: bundle.id, expiresAt: Math.floor(until / 1000) })}\n`);
  console.log(`It runs: cookiejar connect <that string>`);
  console.log(
    opts.values
      ? 'The agent can read the cookie values in this bundle.'
      : 'The agent can make requests as you, but never sees a cookie value.',
  );
  console.log(`Ctrl-C revokes it now. Otherwise it dies on its own in ${opts.minutes} minutes.\n`);

  let stopped = false;
  const stop = async (why: string): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearInterval(ticker);
    try {
      revokeGrant(vault, bundleId, id);
    } catch {
      // Already revoked from another terminal, which is the same outcome.
    }
    tunnel?.stop();
    await close();
    console.log(`\n${why} — ${id} is revoked and the address is gone.`);
    process.exit(0);
  };

  const ticker = setInterval(() => {
    const left = minutesLeft(until);
    if (left === 0) {
      void stop('time is up');
      return;
    }
    console.log(`${left} min left · ${id} · ctrl-c to cut it off`);
  }, 60_000);

  process.on('SIGINT', () => void stop('stopped'));
  process.on('SIGTERM', () => void stop('stopped'));
}
