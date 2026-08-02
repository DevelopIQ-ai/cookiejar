import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { audit, readAudit } from '../core/audit.js';
import { playwrightSnippet, writeBrowserState } from '../core/browserstate.js';
import { installedBrowsers, profileHealth, readAllProfiles, safariAccess, toMeta } from '../core/browsers/index.js';
import { bareDomain, domainCovers, isExpired, resolveBundle } from '../core/bundles.js';
import {
  addSelector,
  createBundle,
  deleteBundle,
  grantId,
  isLive,
  issueGrant,
  removeSelector,
  revokeGrant,
  setPreferences,
  updateBundle,
} from '../core/manage.js';
import { decodeConnection, forgetConnection, saveConnection, type Connection } from '../core/connect.js';
import { keyring } from '../core/keyring.js';
import { auditPath, vaultPath } from '../core/paths.js';
import { suggestBundles } from '../core/suggest.js';
import type { AuditEntry, Bundle, BrowserId, CookieMeta } from '../core/types.js';
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

/** Turns `--browsers chrome,safari` into ids, so setup can be scripted. */
function namedBrowsers(list: string, installed: BrowserId[]): BrowserId[] {
  return list.split(',').map((part) => {
    const name = part.trim().toLowerCase();
    const browser = installed.find((id) => id === name);
    if (!browser) throw new CliError(`no ${name} profile here — installed: ${installed.join(', ')}`);
    return browser;
  });
}

/** First run in the terminal: which browsers, and Safari's permission if asked for. */
export async function setup(vault: Vault, browsers?: string): Promise<void> {
  const installed = installedBrowsers();
  if (installed.length === 0) throw new CliError('no browser profiles found on this machine');

  if (browsers) {
    const named = namedBrowsers(browsers, installed);
    setPreferences(vault, named, true);
    console.log(`Saved: ${named.map((browser) => BROWSER_NAMES[browser]).join(', ')}.`);
    if (named.includes('safari') && safariAccess().state === 'blocked') console.log(`\n${FULL_DISK_ACCESS}`);
    return;
  }

  console.log('Which browsers do you use? Only the ones you pick are read when picking cookies.\n');
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
  console.log('(sites, cookies and bundle add take --all if you want the other browsers too)');
}

export function status(vault: Vault, daemonUrl: string, daemonRunning: boolean): void {
  const health = profileHealth();
  const bundles = vault.read().bundles;
  const preferences = vault.read().preferences;
  console.log(`vault      ${vaultPath()}`);
  console.log(`key        ${vault.protection === 'keyring' ? keyring().where : 'a master password you type'}`);
  console.log(`browsers   ${preferences?.onboardedAt ? preferences.browsers.join(', ') : 'not set up yet (cookiejar setup)'}`);
  console.log(`profiles   ${health.usable.length} readable, ${health.blocked.length} blocked, ${health.empty.length} empty`);
  console.log(`bundles    ${bundles.length}`);
  const grants = bundles.flatMap((b) => b.grants).filter(isLive);
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

/**
 * The browsers `cookiejar setup` was told about. Picking cookies honours that
 * answer; `doctor` and `profiles` deliberately do not, since their job is to
 * report what this machine actually has.
 */
export function chosenBrowsers(vault: Vault, all = false): BrowserId[] | undefined {
  if (all) return undefined;
  const preferences = vault.read().preferences;
  return preferences?.onboardedAt && preferences.browsers.length > 0 ? preferences.browsers : undefined;
}

export function listSites(vault: Vault, opts: { profileId?: string; filter?: string; all?: boolean }): void {
  const reads = profileHealth(opts.profileId ? [opts.profileId] : undefined, chosenBrowsers(vault, opts.all)).usable;
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
    if (chosenBrowsers(vault)) console.log('Only the browsers you picked in setup are read — cookiejar sites --all shows the rest.');
    return;
  }
  const width = Math.max(...rows.map(([site]) => site.length));
  for (const [site, entry] of rows) {
    console.log(`${pad(site, width)}  ${String(entry.cookies).padStart(3)} ${entry.cookies === 1 ? 'cookie ' : 'cookies'}  ${[...entry.profiles].join(' ')}`);
  }
}

function cookiesForSite(site: string, profileId?: string, browsers?: BrowserId[]): CookieMeta[] {
  return profileHealth(profileId ? [profileId] : undefined, browsers)
    .usable.flatMap((read) => read.cookies)
    .filter((cookie) => domainCovers(site, cookie.domain))
    .map(toMeta)
    .sort((a, b) => a.profileId.localeCompare(b.profileId) || a.name.localeCompare(b.name));
}

/** Values are never printed: the terminal only ever sees names and metadata. */
export function listCookies(vault: Vault, site: string, opts: { profileId?: string; all?: boolean } = {}): void {
  const cookies = cookiesForSite(site, opts.profileId, chosenBrowsers(vault, opts.all));
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

/**
 * Groups the cookies you already have into bundles worth making, so nobody has
 * to hand an agent one site at a time. Nothing is written until you accept.
 */
export async function suggest(
  vault: Vault,
  opts: { categoryId?: string; all?: boolean; yes?: boolean } = {},
): Promise<void> {
  const suggestions = suggestBundles(chosenBrowsers(vault, opts.all));
  if (suggestions.length === 0) {
    console.log('Nothing to suggest yet: no signed-in site matched a category.');
    console.log('cookiejar sites shows everything readable; cookiejar bundle new makes one by hand.');
    return;
  }

  const wanted = opts.categoryId ? suggestions.filter((s) => s.categoryId === opts.categoryId) : suggestions;
  if (wanted.length === 0) {
    throw new CliError(`no suggestion called ${opts.categoryId} — try: ${suggestions.map((s) => s.categoryId).join(', ')}`);
  }

  for (const suggestion of wanted) {
    const sites = suggestion.sites;
    console.log(`\n${suggestion.categoryId}  ${plural(sites.length, 'site')}`);
    console.log(`  ${suggestion.description}`);
    const width = Math.max(...sites.map((site) => site.site.length));
    for (const site of sites) {
      // Names only, as everywhere else in the CLI.
      console.log(`  ${pad(site.site, width)}  ${pad(site.profileId, 14)}  ${site.authNames.join(', ')}`);
    }

    if (!opts.categoryId && !opts.yes) continue;
    const accepted = opts.yes || (await confirm(`\nCreate a "${suggestion.name}" bundle from these? `));
    if (!accepted) continue;
    const bundle = createBundle(vault, {
      name: suggestion.name,
      description: suggestion.description,
      selectors: suggestion.selectors,
    });
    console.log(`created ${bundle.id} with ${plural(bundle.selectors.length, 'site')}`);
    console.log(`  cookiejar bundle ${bundle.id}          see what it resolves to right now`);
    console.log(`  cookiejar token new ${bundle.id} --proxy-only   hand it to an agent`);
  }

  if (!opts.categoryId && !opts.yes) {
    console.log(`\nAccept one with: cookiejar suggest ${wanted[0].categoryId}`);
    console.log('Selectors take the cookies that look like a session, so an agent gets a login and nothing else.');
  }
}

/**
 * Drops a SKILL.md into the current project so a coding agent knows how to use
 * a token without being told. Never clobbers an edited copy.
 */
export function installSkill(opts: { dir?: string; force?: boolean; print?: boolean } = {}): void {
  const template = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skill', 'SKILL.md');
  if (!fs.existsSync(template)) throw new CliError('the skill template is missing from this install');
  const body = fs.readFileSync(template, 'utf8');
  if (opts.print) {
    process.stdout.write(body);
    return;
  }
  const target = path.resolve(opts.dir ?? '.agents/skills/cookiejar', 'SKILL.md');
  if (fs.existsSync(target) && !opts.force) {
    throw new CliError(`${target} already exists — pass --force to overwrite it`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
  console.log(`wrote ${target}`);
  console.log('Commit it, then give the agent a token: cookiejar token new <bundle> --proxy-only');
}

export function listBundles(vault: Vault): void {
  const bundles = vault.read().bundles;
  if (bundles.length === 0) {
    console.log('No bundles yet. Make one with: cookiejar bundle new "my bundle"');
    return;
  }
  for (const bundle of bundles) {
    const live = bundle.grants.filter(isLive).length;
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
  opts: { profileId?: string; names?: string[]; pick?: boolean; all?: boolean },
): Promise<void> {
  const cookies = cookiesForSite(site, opts.profileId, chosenBrowsers(vault, opts.all));
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

/** The panic switch: cut off every live token, in one bundle or in all of them. */
export function revokeAll(vault: Vault, bundleId?: string): void {
  const bundles = bundleId ? [vault.bundle(bundleId)] : vault.read().bundles;
  const live = bundles.flatMap((bundle) => bundle.grants.filter(isLive).map((g) => ({ bundle, grant: g })));
  if (live.length === 0) {
    console.log('no live tokens');
    return;
  }
  for (const { bundle, grant } of live) revokeGrant(vault, bundle.id, grantId(grant));
  console.log(`revoked ${plural(live.length, 'token')}`);
  console.log('A running daemon picks this up on the next request — no restart needed.');
}

/** Every token this jar has handed out, so nothing is only visible per bundle. */
export function listGrants(vault: Vault, opts: { live?: boolean } = {}): void {
  const now = Date.now() / 1000;
  const rows = vault.read().bundles.flatMap((bundle) =>
    bundle.grants.map((grant) => ({
      bundle,
      grant,
      state: grant.revokedAt
        ? 'revoked'
        : grant.expiresAt && grant.expiresAt < now
          ? 'expired'
          : grant.redactValues
            ? 'live, proxy only'
            : 'live',
    })),
  );
  const shown = opts.live ? rows.filter((row) => row.state.startsWith('live')) : rows;
  if (shown.length === 0) {
    console.log(opts.live ? 'no live tokens' : 'no tokens yet — cookiejar token new <bundle>');
    return;
  }
  const bundleWidth = Math.max(...shown.map((row) => row.bundle.id.length));
  const labelWidth = Math.max(...shown.map((row) => row.grant.label.length));
  for (const { bundle, grant, state } of shown) {
    const used = grant.lastUsedAt ? `used ${grant.useCount}×, last ${grant.lastUsedAt}` : 'never used';
    console.log(`${pad(grantId(grant), 14)} ${pad(bundle.id, bundleWidth)}  ${pad(grant.label, labelWidth)}  ${pad(state, 18)} ${used}`);
  }
}

export function editBundle(vault: Vault, bundleId: string, patch: { name?: string; description?: string }): void {
  if (patch.name === undefined && patch.description === undefined) {
    throw new CliError('nothing to change — pass --name or --description');
  }
  const bundle = updateBundle(vault, bundleId, patch);
  console.log(`${bundle.id}  ${bundle.name}${bundle.description ? `  — ${bundle.description}` : ''}`);
}

/** Start over when the master password is gone: the jar holds no cookie values, so this loses only bundles. */
export async function reset(force: boolean): Promise<void> {
  if (!fs.existsSync(vaultPath())) throw new CliError(`no jar at ${vaultPath()}`);
  console.log(`This deletes ${vaultPath()} and ${auditPath()}: every bundle and token goes with it.`);
  console.log('Your browsers and their cookies are untouched.');
  if (!force && !(await confirm('Delete the jar?'))) return;
  fs.rmSync(vaultPath(), { force: true });
  fs.rmSync(auditPath(), { force: true });
  // The old key is useless now, and leaving it in the keyring is just litter.
  keyring().clear();
  forgetConnection();
  console.log('deleted — cookiejar setup starts a new one');
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

export function activity(limit: number, bundleId?: string): void {
  const entries = readAudit(limit).filter((entry) => !bundleId || entry.bundleId === bundleId);
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

/**
 * The audit log as it happens. Lending is the one moment you want to watch a
 * remote agent work, and re-running `activity` every few seconds is not that.
 */
export function tail(bundleId: string | undefined, signal: { onStop: (stop: () => void) => void }): void {
  const file = auditPath();
  const show = (entry: AuditEntry): void => {
    if (bundleId && entry.bundleId !== bundleId) return;
    console.log(
      `${entry.at}  ${pad(entry.event, 16)} ${pad(entry.bundleId ?? '', 24)} ${entry.grantLabel ?? ''} ${entry.detail ?? ''}`.trimEnd(),
    );
  };
  for (const entry of readAudit(20).reverse()) show(entry);
  console.log(`— watching ${file}${bundleId ? ` for ${bundleId}` : ''}; ctrl-c to stop —`);

  let offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
  const poll = setInterval(() => {
    if (!fs.existsSync(file)) return;
    const size = fs.statSync(file).size;
    // A reset truncates the log; start over rather than reading garbage.
    if (size < offset) offset = 0;
    if (size === offset) return;
    const handle = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(size - offset);
    fs.readSync(handle, buffer, 0, buffer.length, offset);
    fs.closeSync(handle);
    offset = size;
    for (const line of buffer.toString('utf8').split('\n').filter(Boolean)) {
      try {
        show(JSON.parse(line) as AuditEntry);
      } catch {
        // A half-written line will be complete on the next poll.
      }
    }
  }, 500);
  signal.onStop(() => clearInterval(poll));
}

/** Buys a running loan more time without handing out a second token. */
export function extendGrant(vault: Vault, bundleId: string, tokenId: string | undefined, minutes: number): void {
  if (!Number.isFinite(minutes) || minutes <= 0) throw new CliError('--minutes must be a positive number');
  const bundle = vault.bundle(bundleId);
  const live = bundle.grants.filter(isLive);
  const grant = tokenId ? live.find((g) => grantId(g).startsWith(tokenId)) : live[live.length - 1];
  if (!grant) throw new CliError(tokenId ? `no live token ${tokenId} in ${bundleId}` : `no live token in ${bundleId}`);
  const base = Math.max(grant.expiresAt, Math.floor(Date.now() / 1000));
  const until = grant.expiresAt === 0 ? 0 : base + minutes * 60;
  vault.write((data) => {
    const target = data.bundles
      .find((b) => b.id === bundleId)!
      .grants.find((g) => g.tokenHash === grant.tokenHash)!;
    target.expiresAt = until;
  });
  audit({ event: 'grant_extended', bundleId, grantLabel: grant.label, detail: `+${minutes}m` });
  console.log(
    until === 0
      ? `${grantId(grant)} never expires, so there is nothing to extend`
      : `${grantId(grant)} (${grant.label}) now runs until ${new Date(until * 1000).toLocaleTimeString()}`,
  );
  console.log('the agent picks this up on its next request — no reconnect needed');
}

/** Hands a bundle to Playwright, which is the only way to click things. */
export function browserHandoff(vault: Vault, bundleId: string, out?: string): void {
  const bundle = vault.bundle(bundleId);
  const { cookies } = resolveBundle(bundle);
  if (cookies.length === 0) throw new CliError(`"${bundle.name}" resolves to no cookies right now — cookiejar bundle ${bundleId}`);
  const file = writeBrowserState(bundle, out);
  console.log(`wrote ${file} (0600) — ${cookies.length} cookies, real values`);
  console.log('this file is a password: it is the session itself, not a proxy to it.\n');
  console.log(playwrightSnippet(bundle, file));
}

/** Sets (or replaces) a passphrase on a jar that is already open. */
export async function setPassword(vault: Vault): Promise<void> {
  const next = await newPassword('New master password (8+ characters): ');
  vault.adoptPassword(next);
  console.log('master password set — cookiejar passwd --none undoes this');
}

/** Stops the prompts by moving the key into the OS keyring. */
export function useKeyring(vault: Vault): void {
  if (vault.protection === 'keyring') {
    console.log(`already keyring-backed — the key is in ${keyring().where}`);
    return;
  }
  vault.adoptKeyring();
  console.log(`the key is in ${keyring().where} now, so cookiejar will not ask for a password again`);
  console.log('the jar itself is still encrypted; anyone who can log in as you can open it');
}

const expiryNote = (connection: Connection): string => {
  if (!connection.expiresAt) return 'no expiry';
  const minutes = Math.round((connection.expiresAt * 1000 - Date.now()) / 60_000);
  return minutes > 0 ? `about ${plural(minutes, 'minute')} left` : 'already expired';
};

/**
 * The agent's half of `cookiejar lend`: check the string works, say what it
 * reaches, and remember it so the other commands need no flags.
 */
export async function connect(value: string, opts: { save?: boolean } = {}): Promise<void> {
  const connection = decodeConnection(value);
  if (connection.expiresAt && connection.expiresAt * 1000 < Date.now()) {
    throw new CliError('that loan already expired — ask for a fresh cookiejar lend');
  }
  const response = await fetch(new URL('/agent/bundle', connection.url), {
    headers: { authorization: `Bearer ${connection.token}` },
  });
  const text = await response.text();
  if (!response.ok) throw new CliError(`that bundle is not reachable: ${response.status} ${text}`);

  const described = JSON.parse(text) as {
    bundle: { name: string };
    hosts: string[];
    cookieCount: number;
    permissions: { allowFetch: boolean; redactValues: boolean };
  };
  const readable = !described.permissions.redactValues;

  console.log(`connected to "${described.bundle.name}" · ${expiryNote(connection)}`);
  console.log(`hosts   ${described.hosts.join(', ') || 'none right now'}`);
  console.log(`cookies ${described.cookieCount}, values ${readable ? 'readable' : 'hidden (proxy only)'}`);

  if (opts.save === false) return;
  const file = saveConnection(connection);
  console.log(`\nsaved to ${file} — these now work with no flags:`);
  console.log('  cookiejar fetch <url>            request that URL as the lender');
  if (readable) console.log('  cookiejar export --format storage-state');
  console.log('  cookiejar mcp                    expose it to this agent over MCP');
}

export function disconnect(): void {
  forgetConnection();
  console.log('forgot the borrowed bundle');
}

export async function changePassword(vault: Vault, current: string): Promise<void> {
  const next = await newPassword('New master password (8+ characters): ');
  vault.changePassword(current, next);
  console.log('master password changed');
}

export function profiles(): void {
  const reads = readAllProfiles();
  const idWidth = Math.max(...reads.map((read) => read.profile.id.length));
  const labelWidth = Math.max(...reads.map((read) => read.profile.label.length));
  for (const read of reads) {
    const state = read.error ? read.error : plural(read.cookies.length, 'cookie');
    console.log(`${pad(read.profile.id, idWidth)}  ${pad(read.profile.label, labelWidth)}  ${state}`);
  }
}
