import { readAudit } from '../core/audit.js';
import { installedBrowsers, profileHealth, readAllProfiles, safariAccess, toMeta } from '../core/browsers/index.js';
import { bareDomain, domainCovers, isExpired, resolveBundle } from '../core/bundles.js';
import {
  addSelector,
  createBundle,
  deleteBundle,
  grantId,
  issueGrant,
  removeSelector,
  revokeGrant,
  setPreferences,
} from '../core/manage.js';
import { vaultPath } from '../core/paths.js';
import type { Bundle, BrowserId, CookieMeta } from '../core/types.js';
import type { Vault } from '../core/vault.js';
import { ask, confirm } from './prompt.js';
import { CliError, newPassword } from './vault.js';

const BROWSER_NAMES: Record<BrowserId, string> = {
  chrome: 'Chrome',
  'chrome-beta': 'Chrome Beta',
  chromium: 'Chromium',
  brave: 'Brave',
  edge: 'Edge',
  arc: 'Arc',
  firefox: 'Firefox',
  safari: 'Safari',
};

export const FULL_DISK_ACCESS = `Safari keeps its cookies in a container macOS protects, so cookiejar needs Full Disk Access:
  1. Open System Settings → Privacy & Security → Full Disk Access.
  2. Add the app you run cookiejar from — Terminal, iTerm, or your editor's terminal.
  3. Quit and reopen that app (macOS only applies the permission to freshly launched apps).
  4. Run cookiejar setup again.`;

const pad = (value: string, width: number): string => value.padEnd(width);
const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** First run in the terminal: which browsers, and Safari's permission if asked for. */
export async function setup(vault: Vault): Promise<void> {
  const installed = installedBrowsers();
  if (installed.length === 0) throw new CliError('no browser profiles found on this machine');

  console.log('Which browsers do you use? cookiejar only reads the ones you pick.\n');
  installed.forEach((browser, index) => {
    const note = browser === 'safari' && safariAccess().state !== 'ok' ? '  (needs one permission)' : '';
    console.log(`  ${index + 1}. ${BROWSER_NAMES[browser]}${note}`);
  });

  const answer = await ask('\nNumbers, comma separated (enter = all): ');
  const chosen = answer
    ? answer
        .split(',')
        .map((part) => installed[Number(part.trim()) - 1])
        .filter((browser): browser is BrowserId => Boolean(browser))
    : installed;
  if (chosen.length === 0) throw new CliError('nothing selected');

  if (chosen.includes('safari') && safariAccess().state === 'blocked') {
    console.log(`\n${FULL_DISK_ACCESS}`);
  }

  setPreferences(vault, chosen, true);
  console.log(`\nSaved: ${chosen.map((browser) => BROWSER_NAMES[browser]).join(', ')}.`);
  console.log('Next: cookiejar sites  ·  cookiejar bundle new <name>');
}

export function status(vault: Vault, daemonUrl: string, daemonRunning: boolean): void {
  const health = profileHealth();
  const bundles = vault.read().bundles;
  const preferences = vault.read().preferences;
  console.log(`vault      ${vaultPath()}`);
  console.log(`browsers   ${preferences?.onboardedAt ? preferences.browsers.join(', ') : 'not set up yet (cookiejar setup)'}`);
  console.log(`profiles   ${health.usable.length} readable, ${health.blocked.length} blocked, ${health.empty.length} empty`);
  console.log(`bundles    ${bundles.length}`);
  const grants = bundles.flatMap((b) => b.grants).filter((g) => !g.revokedAt);
  console.log(`tokens     ${grants.length} live`);
  console.log(`agents     ${daemonUrl} — running: ${daemonRunning ? 'yes' : 'no (cookiejar serve)'}`);
}

export function doctor(): void {
  const health = profileHealth();
  if (health.usable.length === 0) console.log('No profiles with readable cookies found.');
  for (const read of health.usable) {
    const sites = new Set(read.cookies.map((c) => bareDomain(c.domain))).size;
    console.log(`✓ ${read.profile.label} (${read.profile.id}) — ${plural(read.cookies.length, 'cookie')} across ${plural(sites, 'site')}`);
  }
  if (health.empty.length > 0) console.log(`  (${plural(health.empty.length, 'profile')} with no cookies hidden)`);
  if (health.blocked.some(({ profile }) => profile.browser === 'safari')) console.log(`\n${FULL_DISK_ACCESS}`);
  for (const { profile, error } of health.blocked) {
    if (profile.browser === 'safari') continue;
    console.log(`✗ ${profile.label} (${profile.id}) — ${error}`);
  }
}

export function listSites(opts: { profileId?: string; filter?: string }): void {
  const reads = profileHealth(opts.profileId ? [opts.profileId] : undefined).usable;
  const sites = new Map<string, { cookies: number; profiles: Set<string> }>();
  for (const read of reads) {
    for (const cookie of read.cookies) {
      const site = bareDomain(cookie.domain);
      if (opts.filter && !site.includes(opts.filter.toLowerCase())) continue;
      const entry = sites.get(site) ?? { cookies: 0, profiles: new Set<string>() };
      entry.cookies += 1;
      entry.profiles.add(cookie.profileId);
      sites.set(site, entry);
    }
  }
  const rows = [...sites.entries()].sort((a, b) => b[1].cookies - a[1].cookies || a[0].localeCompare(b[0]));
  if (rows.length === 0) {
    console.log('No cookies found. Sign in somewhere in your browser, then try again.');
    return;
  }
  const width = Math.max(...rows.map(([site]) => site.length));
  for (const [site, entry] of rows) {
    console.log(`${pad(site, width)}  ${String(entry.cookies).padStart(3)} ${entry.cookies === 1 ? 'cookie ' : 'cookies'}  ${[...entry.profiles].join(' ')}`);
  }
}

function cookiesForSite(site: string, profileId?: string): CookieMeta[] {
  return profileHealth(profileId ? [profileId] : undefined)
    .usable.flatMap((read) => read.cookies)
    .filter((cookie) => domainCovers(site, cookie.domain))
    .map(toMeta)
    .sort((a, b) => a.profileId.localeCompare(b.profileId) || a.name.localeCompare(b.name));
}

/** Values are never printed: the terminal only ever sees names and metadata. */
export function listCookies(site: string, profileId?: string): void {
  const cookies = cookiesForSite(site, profileId);
  if (cookies.length === 0) throw new CliError(`no cookies for ${site}`);
  const width = Math.max(...cookies.map((cookie) => cookie.name.length));
  const domainWidth = Math.max(...cookies.map((cookie) => cookie.domain.length));
  const profileWidth = Math.max(...cookies.map((cookie) => cookie.profileId.length));
  for (const cookie of cookies) {
    const flags = [cookie.httpOnly ? 'httpOnly' : '', cookie.secure ? 'secure' : '', isExpired(cookie) ? 'expired' : '']
      .filter(Boolean)
      .join(' ');
    console.log(`${pad(cookie.name, width)}  ${pad(cookie.domain, domainWidth)}  ${pad(cookie.profileId, profileWidth)}  ${flags}`);
  }
}

export function listBundles(vault: Vault): void {
  const bundles = vault.read().bundles;
  if (bundles.length === 0) {
    console.log('No bundles yet. Make one with: cookiejar bundle new "my bundle"');
    return;
  }
  for (const bundle of bundles) {
    const live = bundle.grants.filter((g) => !g.revokedAt).length;
    const sites = new Set(bundle.selectors.map((s) => bareDomain(s.domain))).size;
    console.log(`${pad(bundle.id, 24)}  ${pad(bundle.name, 20)} ${plural(sites, 'site')}, ${plural(live, 'live token')}`);
  }
}

export function showBundle(vault: Vault, bundleId: string): void {
  const bundle = vault.bundle(bundleId);
  const resolved = resolveBundle(bundle);
  console.log(`${bundle.name}  (${bundle.id})`);
  if (bundle.description) console.log(bundle.description);

  console.log('\nselectors');
  for (const selector of bundle.selectors) {
    const names = selector.names.length === 0 ? 'every cookie' : selector.names.join(', ');
    console.log(`  ${pad(selector.domain, 24)} ${pad(selector.profileId, 18)} ${names}`);
  }

  console.log(`\nlive contents · ${plural(resolved.cookies.length, 'cookie')}`);
  for (const cookie of resolved.cookies.map(toMeta)) {
    console.log(`  ${pad(cookie.name, 24)} ${pad(cookie.domain, 24)} ${cookie.profileId}`);
  }
  for (const selector of resolved.emptySelectors) console.log(`  ! ${selector.domain} matches nothing right now`);
  for (const error of resolved.errors) console.log(`  ! ${error.profileId}: ${error.error}`);

  console.log('\ntokens');
  if (bundle.grants.length === 0) console.log('  none — cookiejar token new ' + bundle.id);
  for (const grant of bundle.grants) {
    const state = grant.revokedAt
      ? 'revoked'
      : grant.expiresAt && grant.expiresAt < Date.now() / 1000
        ? 'expired'
        : grant.redactValues
          ? 'live, proxy only'
          : 'live';
    console.log(`  ${pad(grantId(grant), 14)} ${pad(grant.label, 16)} ${pad(state, 18)} used ${grant.useCount}×`);
  }
}

export async function newBundle(vault: Vault, name: string, description?: string): Promise<Bundle> {
  const bundle = createBundle(vault, { name, description });
  console.log(`created ${bundle.id}`);
  console.log(`add a site with: cookiejar bundle add ${bundle.id} <site>`);
  return bundle;
}

/** Pick a site, optionally narrowing to specific cookie names. */
export async function bundleAdd(
  vault: Vault,
  bundleId: string,
  site: string,
  opts: { profileId?: string; names?: string[]; pick?: boolean },
): Promise<void> {
  const cookies = cookiesForSite(site, opts.profileId);
  if (cookies.length === 0) throw new CliError(`no cookies for ${site}`);

  const profileIds = [...new Set(cookies.map((cookie) => cookie.profileId))];
  let profileId = opts.profileId ?? (profileIds.length === 1 ? profileIds[0] : undefined);
  if (!profileId) {
    console.log(`${site} has cookies in more than one profile:`);
    profileIds.forEach((id, index) => console.log(`  ${index + 1}. ${id}`));
    const answer = await ask('Which one? ');
    profileId = profileIds[Number(answer) - 1];
    if (!profileId) throw new CliError('pass --profile <id> to choose a profile');
  }

  const inProfile = cookies.filter((cookie) => cookie.profileId === profileId);
  let names = opts.names ?? [];
  if (opts.pick) {
    inProfile.forEach((cookie, index) => console.log(`  ${index + 1}. ${cookie.name}  (${cookie.domain})`));
    const answer = await ask('Cookies to include, comma separated (enter = all): ');
    names = answer
      ? answer
          .split(',')
          .map((part) => inProfile[Number(part.trim()) - 1]?.name)
          .filter((name): name is string => Boolean(name))
      : [];
  }

  addSelector(vault, bundleId, { profileId, domain: site, names });
  const count = names.length === 0 ? inProfile.length : names.length;
  console.log(`${bundleId}: added ${site} from ${profileId} (${plural(count, 'cookie')}${names.length === 0 ? ', tracking all' : ''})`);
}

export function bundleRemove(vault: Vault, bundleId: string, site: string, profileId?: string): void {
  removeSelector(vault, bundleId, site, profileId);
  console.log(`${bundleId}: removed ${site}`);
}

export async function bundleDelete(vault: Vault, bundleId: string, force: boolean): Promise<void> {
  const bundle = vault.bundle(bundleId);
  if (!force && !(await confirm(`Delete "${bundle.name}" and its ${plural(bundle.grants.length, 'token')}?`))) return;
  deleteBundle(vault, bundleId);
  console.log(`deleted ${bundleId}`);
}

export function newGrant(
  vault: Vault,
  bundleId: string,
  opts: { label?: string; days?: number; allowFetch?: boolean; redactValues?: boolean },
): void {
  const { token, grant } = issueGrant(vault, bundleId, {
    label: opts.label,
    expiresInDays: opts.days,
    allowFetch: opts.allowFetch,
    redactValues: opts.redactValues,
  });
  console.log(token);
  console.log(
    `\n${grantId(grant)} · ${grant.label} · ${grant.expiresAt ? `expires ${new Date(grant.expiresAt * 1000).toDateString()}` : 'no expiry'}` +
      `${grant.redactValues ? ' · proxy only, values stay here' : ''}`,
  );
  console.log('This is the only time the token is shown. It only works while cookiejar serve is running.');
  console.log(`Config for an agent: cookiejar share ${bundleId}`);
}

export function revoke(vault: Vault, bundleId: string, id: string): void {
  const grant = revokeGrant(vault, bundleId, id);
  console.log(`revoked ${grantId(grant)} (${grant.label})`);
}

function mcpConfig(bundle: Bundle, remoteUrl?: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        [`cookiejar-${bundle.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`]: {
          command: 'npx',
          args: ['-y', '@puffle/cookiejar', 'mcp', ...(remoteUrl ? ['--url', remoteUrl] : [])],
          env: { COOKIEJAR_TOKEN: 'cjr_…' },
        },
      },
    },
    null,
    2,
  );
}

/** Everything needed to hand this bundle to an agent, local or remote. */
export function share(vault: Vault, bundleId: string, opts: { tunnel?: string; port: number }): void {
  const bundle = vault.bundle(bundleId);
  console.log('Tokens are answered by the local daemon, so keep it running while an agent works:\n');
  console.log(`  cookiejar serve\n`);
  console.log(`Agent on this machine — paste into Claude Code, Cursor, or any MCP client:\n`);
  console.log(mcpConfig(bundle));

  console.log(`\nAgent in the cloud — the daemon listens on loopback only, so tunnel it:\n`);
  console.log(`  cloudflared tunnel --url http://127.0.0.1:${opts.port}`);
  console.log('  (tailscale funnel or ngrok work the same way)\n');
  const url = opts.tunnel ?? 'https://your-tunnel.example';
  console.log(mcpConfig(bundle, url));
  console.log(`\nOr straight HTTP:\n`);
  console.log(`  curl -X POST ${url}/agent/fetch \\
    -H "authorization: Bearer $COOKIEJAR_TOKEN" \\
    -H "content-type: application/json" \\
    -d '{"url":"https://example.com/api/me"}'`);
  console.log(
    `\nIssue the token with --proxy-only (cookiejar token new ${bundleId} --proxy-only --days 1) so the agent can make
authenticated requests without ever seeing a cookie value. The tunnel URL is bearer-token access: keep the expiry
short and revoke it when the job is done.`,
  );
}

export function activity(limit: number): void {
  const entries = readAudit(limit);
  if (entries.length === 0) {
    console.log('Nothing yet.');
    return;
  }
  for (const entry of entries) {
    console.log(
      `${entry.at}  ${pad(entry.event, 16)} ${pad(entry.bundleId ?? '', 24)} ${entry.grantLabel ?? ''} ${entry.detail ?? ''}`.trimEnd(),
    );
  }
}

export async function changePassword(vault: Vault, current: string): Promise<void> {
  const next = await newPassword('New master password (8+ characters): ');
  vault.changePassword(current, next);
  console.log('master password changed');
}

export function profiles(): void {
  for (const read of readAllProfiles()) {
    const state = read.error ? read.error : plural(read.cookies.length, 'cookie');
    console.log(`${pad(read.profile.id, 20)} ${pad(read.profile.label, 24)} ${state}`);
  }
}
