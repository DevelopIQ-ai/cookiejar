import { useEffect, useMemo, useState } from 'react';
import { api, type BlockedProfile, type Bundle, type CookieMeta, type Profile, type Selector, type Site } from '../api';
import { Banner, Empty, Label, browserGlyph, expiryText } from '../components';
import { FullDiskAccessSteps } from './Onboarding';

const keyOf = (cookie: CookieMeta): string => `${cookie.profileId}|${cookie.domain}|${cookie.path}|${cookie.name}`;
const bare = (domain: string): string => domain.replace(/^\./, '').toLowerCase();

/** Collapses picked cookies into one selector per (profile, site). */
export function selectorsFromCookies(cookies: CookieMeta[]): Selector[] {
  const groups = new Map<string, Selector>();
  for (const cookie of cookies) {
    const key = `${cookie.profileId}|${bare(cookie.domain)}`;
    const selector = groups.get(key) ?? { profileId: cookie.profileId, domain: bare(cookie.domain), names: [] };
    if (!selector.names.includes(cookie.name)) selector.names.push(cookie.name);
    groups.set(key, selector);
  }
  return [...groups.values()];
}

export function Cookies({ bundles, onBundlesChanged }: { bundles: Bundle[]; onBundlesChanged: () => void }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [blocked, setBlocked] = useState<BlockedProfile[]>([]);
  const [active, setActive] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [sites, setSites] = useState<Site[]>([]);
  const [openSite, setOpenSite] = useState<string | null>(null);
  const [siteCookies, setSiteCookies] = useState<CookieMeta[]>([]);
  const [picked, setPicked] = useState<Map<string, CookieMeta>>(new Map());
  const [target, setTarget] = useState('');
  const [newName, setNewName] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .profiles()
      .then((res) => {
        setProfiles(res.profiles);
        setBlocked(res.blocked);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    const handle = setTimeout(() => {
      void api
        .sites(active, query)
        .then((res) => setSites(res.sites))
        .catch((err: Error) => setError(err.message));
    }, 150);
    return () => clearTimeout(handle);
  }, [active, query]);

  useEffect(() => {
    if (!openSite) {
      setSiteCookies([]);
      return;
    }
    void api
      .cookies(openSite, active)
      .then((res) => setSiteCookies(res.cookies))
      .catch((err: Error) => setError(err.message));
  }, [openSite, active]);

  const pickedList = useMemo(() => [...picked.values()], [picked]);

  const toggle = (cookie: CookieMeta) => {
    setPicked((current) => {
      const next = new Map(current);
      const key = keyOf(cookie);
      if (next.has(key)) next.delete(key);
      else next.set(key, cookie);
      return next;
    });
  };

  const pickAllOnSite = () => {
    setPicked((current) => {
      const next = new Map(current);
      const allPicked = siteCookies.every((cookie) => next.has(keyOf(cookie)));
      for (const cookie of siteCookies) {
        if (allPicked) next.delete(keyOf(cookie));
        else next.set(keyOf(cookie), cookie);
      }
      return next;
    });
  };

  const addToBundle = async () => {
    setError(null);
    setNote(null);
    const selectors = selectorsFromCookies(pickedList);
    try {
      if (target === '__new__') {
        if (!newName.trim()) {
          setError('Give the new bundle a name.');
          return;
        }
        const { bundle } = await api.createBundle({ name: newName.trim(), selectors });
        setNote(`Created “${bundle.name}” with ${pickedList.length} cookies.`);
        setNewName('');
      } else {
        const bundle = bundles.find((b) => b.id === target);
        if (!bundle) {
          setError('Pick a bundle first.');
          return;
        }
        const merged = new Map(bundle.selectors.map((s) => [`${s.profileId}|${s.domain}`, { ...s, names: [...s.names] }]));
        for (const selector of selectors) {
          const key = `${selector.profileId}|${selector.domain}`;
          const existing = merged.get(key);
          if (!existing) merged.set(key, selector);
          else for (const name of selector.names) if (!existing.names.includes(name)) existing.names.push(name);
        }
        await api.updateBundle(bundle.id, { selectors: [...merged.values()] });
        setNote(`Added ${pickedList.length} cookies to “${bundle.name}”.`);
      }
      setPicked(new Map());
      onBundlesChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div>
          <Label colour="blue">Your browsers</Label>
          <h1 className="display" style={{ marginTop: 6 }}>
            Pick the cookies.
          </h1>
        </div>
        <input
          type="search"
          value={query}
          placeholder="filter sites…"
          onChange={(event) => setQuery(event.target.value)}
          style={{ maxWidth: 260 }}
        />
      </div>

      {error ? <Banner>{error}</Banner> : null}
      {note ? <Banner kind="good">{note}</Banner> : null}
      {blocked.map((item) => (
        <Banner kind="warn" key={item.id}>
          {item.fix === 'full-disk-access' ? (
            <details>
              <summary>{item.label} is installed but macOS is blocking its cookies. Here is the one-time fix.</summary>
              <FullDiskAccessSteps />
            </details>
          ) : (
            <>
              {item.label} could not be read right now.
              <span className="tiny faint"> {item.error}</span>
            </>
          )}
        </Banner>
      ))}

      <div className="inline">
        <button className="chip" aria-pressed={active.length === 0} onClick={() => setActive([])}>
          All browsers
        </button>
        {profiles.map((profile) => (
          <button
            key={profile.id}
            className="chip"
            aria-pressed={active.includes(profile.id)}
            title={profile.path}
            onClick={() =>
              setActive((current) =>
                current.includes(profile.id) ? current.filter((id) => id !== profile.id) : [...current, profile.id],
              )
            }
          >
            {browserGlyph(profile.browser)} {profile.label} · {profile.cookieCount}
          </button>
        ))}
      </div>

      <div className="split">
        <div className="card plain" style={{ padding: 0, maxHeight: 560, overflow: 'auto' }}>
          <div className="row" style={{ borderBottom: `1px solid var(--line)` }}>
            <Label>Sites · {sites.length}</Label>
          </div>
          {sites.length === 0 ? (
            <div className="row muted tiny">
              {profiles.length === 0
                ? 'No readable browser cookies yet. Sign in somewhere in your browser, then reload.'
                : 'No sites match that filter.'}
            </div>
          ) : null}
          <div className="rows">
            {sites.slice(0, 400).map((site) => (
              <div
                key={site.site}
                className="row clickable"
                aria-current={openSite === site.site}
                onClick={() => setOpenSite(site.site)}
                style={openSite === site.site ? { background: 'rgba(255,255,255,0.9)' } : undefined}
              >
                <div className="grow truncate">{site.site}</div>
                <div className="tiny faint">{site.cookieCount}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="card plain" style={{ padding: 0 }}>
          <div className="row" style={{ borderBottom: `1px solid var(--line)` }}>
            <div className="grow">
              <Label colour="green">{openSite ?? 'select a site'}</Label>
            </div>
            {siteCookies.length ? (
              <button className="btn ghost sm" onClick={pickAllOnSite}>
                Toggle all
              </button>
            ) : null}
          </div>
          {openSite ? null : <div className="row muted tiny">Pick a site on the left to see its cookies.</div>}
          <div className="rows" style={{ maxHeight: 510, overflow: 'auto' }}>
            {siteCookies.map((cookie) => (
              <label key={keyOf(cookie)} className="row clickable">
                <input type="checkbox" checked={picked.has(keyOf(cookie))} onChange={() => toggle(cookie)} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="truncate">{cookie.name}</div>
                  <div className="tiny faint truncate">
                    {cookie.domain}
                    {cookie.path === '/' ? '' : cookie.path} · {cookie.valueLength} chars · {expiryText(cookie.expires)}
                    {cookie.httpOnly ? ' · httpOnly' : ''}
                    {cookie.secure ? ' · secure' : ''}
                  </div>
                </div>
                <div className="tiny faint">{browserGlyph(cookie.browser)}</div>
              </label>
            ))}
          </div>
        </div>
      </div>

      {pickedList.length ? (
        <div className="card stack">
          <Label colour="yellow">{pickedList.length} cookies selected</Label>
          <div className="inline">
            <select
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              style={{ padding: '9px 11px', border: '1px solid var(--line)', borderRadius: 3, background: '#fff' }}
            >
              <option value="">Add to…</option>
              <option value="__new__">＋ New bundle</option>
              {bundles.map((bundle) => (
                <option key={bundle.id} value={bundle.id}>
                  {bundle.name}
                </option>
              ))}
            </select>
            {target === '__new__' ? (
              <input
                type="text"
                value={newName}
                placeholder="bundle name, e.g. github-read"
                onChange={(event) => setNewName(event.target.value)}
                style={{ maxWidth: 260 }}
              />
            ) : null}
            <button className="btn primary" disabled={!target} onClick={() => void addToBundle()}>
              Save
            </button>
            <button className="btn ghost" onClick={() => setPicked(new Map())}>
              Clear
            </button>
          </div>
          <p className="faint tiny" style={{ margin: 0 }}>
            Bundles store <em>which</em> cookies to use, never the values — they are read fresh from the browser on every access.
          </p>
        </div>
      ) : (
        <Empty title="Nothing selected yet" hint="Tick cookies to gather them into a bundle." />
      )}
    </div>
  );
}
