import { useEffect, useState } from 'react';
import { api, type Bundle, type CookieMeta, type Selector } from '../api';
import { Banner, Copyable, Empty, Label, browserGlyph, expiryText, relative } from '../components';

function mcpSnippet(bundleName: string, token: string, remoteUrl?: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        [`cookiejar-${bundleName}`]: {
          command: 'npx',
          args: ['-y', '@puffle/cookiejar', 'mcp', ...(remoteUrl ? ['--url', remoteUrl] : [])],
          env: { COOKIEJAR_TOKEN: token },
        },
      },
    },
    null,
    2,
  );
}

const tunnelCommand = (): string => `cloudflared tunnel --url http://${window.location.host}`;

function fetchExample(url: string): string {
  return `curl -X POST ${url}/agent/fetch \\
  -H "authorization: Bearer $COOKIEJAR_TOKEN" \\
  -H "content-type: application/json" \\
  -d '{"url":"https://example.com/api/me"}'`;
}

/** How to hand this bundle to an agent, locally or in the cloud. */
function HandoffPanel({ bundle }: { bundle: Bundle }) {
  const [where, setWhere] = useState<'local' | 'cloud'>('local');
  const [tunnel, setTunnel] = useState('');
  const remote = tunnel.trim().replace(/\/+$/, '');
  const target = remote || 'https://your-tunnel.example';

  return (
    <div className="stack">
      <Label colour="blue">Give it to an agent</Label>
      <div className="inline">
        <button className="chip" aria-pressed={where === 'local'} onClick={() => setWhere('local')}>
          Agent on this machine
        </button>
        <button className="chip" aria-pressed={where === 'cloud'} onClick={() => setWhere('cloud')}>
          Agent in the cloud
        </button>
      </div>

      {where === 'local' ? (
        <>
          <p className="tiny muted" style={{ margin: 0 }}>
            Paste this into Claude Code, Cursor, or any MCP client running on this machine, with the token you issued above.
          </p>
          <pre className="snippet">{mcpSnippet(bundle.id, 'cjr_…')}</pre>
          <Copyable value={mcpSnippet(bundle.id, 'cjr_…')} label="Copy MCP config" />
        </>
      ) : (
        <>
          <p className="tiny muted" style={{ margin: 0 }}>
            Cookies never have to leave this machine. Expose the local daemon over a tunnel, then give the cloud agent a{' '}
            <strong>proxy-only</strong> token: it can make authenticated requests, but never sees a cookie value. Revoking the
            token or locking the jar cuts it off instantly.
          </p>
          <div className="stack" style={{ gap: 8 }}>
            <span className="tiny faint">1 · Run a tunnel here (Tailscale Funnel or ngrok work the same way).</span>
            <pre className="snippet">{tunnelCommand()}</pre>
            <Copyable value={tunnelCommand()} label="Copy tunnel command" />
          </div>
          <div className="field">
            <span className="tiny faint">2 · Paste the URL the tunnel printed.</span>
            <input
              type="text"
              value={tunnel}
              placeholder="https://calm-cookie-1234.trycloudflare.com"
              onChange={(event) => setTunnel(event.target.value)}
            />
          </div>
          <div className="stack" style={{ gap: 8 }}>
            <span className="tiny faint">3 · Give the agent the token plus one of these.</span>
            <pre className="snippet">{mcpSnippet(bundle.id, 'cjr_…', target)}</pre>
            <div className="inline">
              <Copyable value={mcpSnippet(bundle.id, 'cjr_…', target)} label="Copy MCP config" />
              <Copyable value={fetchExample(target)} label="Copy curl example" />
            </div>
            <pre className="snippet">{fetchExample(target)}</pre>
          </div>
          <p className="tiny faint" style={{ margin: 0 }}>
            The tunnel URL is a bearer-token endpoint: anyone holding the token can use the bundle, so keep expiry short and
            revoke when the job is done.
          </p>
        </>
      )}
    </div>
  );
}

function GrantPanel({ bundle, onChanged }: { bundle: Bundle; onChanged: () => void }) {
  const [label, setLabel] = useState('');
  const [days, setDays] = useState('30');
  const [allowFetch, setAllowFetch] = useState(true);
  const [redactValues, setRedactValues] = useState(false);
  const [issued, setIssued] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setError(null);
    try {
      const { token } = await api.createGrant(bundle.id, {
        label: label.trim() || 'agent',
        expiresInDays: Number(days) || 0,
        allowFetch,
        redactValues,
      });
      setIssued(token);
      setLabel('');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="stack">
      <Label colour="red">Agent access</Label>
      {bundle.grants.length === 0 ? <p className="tiny muted" style={{ margin: 0 }}>No tokens yet.</p> : null}
      <div className="rows">
        {bundle.grants.map((grant) => (
          <div className="row" key={grant.id}>
            <div className="grow">
              <div className="truncate">
                {grant.label}
                {grant.revokedAt ? ' · revoked' : ''}
              </div>
              <div className="tiny faint">
                {grant.useCount} uses · last {relative(grant.lastUsedAt)} · expires {expiryText(grant.expiresAt)}
                {grant.redactValues ? ' · proxy only' : ''}
                {grant.allowFetch ? '' : ' · no proxy'}
              </div>
            </div>
            {grant.revokedAt ? null : (
              <button
                className="btn danger sm"
                onClick={() => {
                  void api.revokeGrant(bundle.id, grant.id).then(onChanged);
                }}
              >
                Revoke
              </button>
            )}
          </div>
        ))}
      </div>

      {issued ? (
        <div className="stack">
          <Banner kind="good">Copy this token now — it is not stored anywhere and will not be shown again.</Banner>
          <div className="token">{issued}</div>
          <div className="inline">
            <Copyable value={issued} label="Copy token" />
            <Copyable value={mcpSnippet(bundle.id, issued)} label="Copy MCP config" />
            <button className="btn ghost sm" onClick={() => setIssued(null)}>
              Done
            </button>
          </div>
          <pre className="snippet">{mcpSnippet(bundle.id, issued)}</pre>
        </div>
      ) : (
        <div className="stack">
          <div className="inline">
            <input
              type="text"
              value={label}
              placeholder="who is this for? e.g. devin, claude-code"
              onChange={(event) => setLabel(event.target.value)}
              style={{ maxWidth: 280 }}
            />
            <input
              type="number"
              value={days}
              min={0}
              onChange={(event) => setDays(event.target.value)}
              style={{ maxWidth: 90 }}
              title="Days until the token expires (0 = never)"
            />
            <span className="tiny faint">days</span>
          </div>
          <label className="inline tiny">
            <input type="checkbox" checked={allowFetch} onChange={(event) => setAllowFetch(event.target.checked)} />
            may proxy requests through the bundle
          </label>
          <label className="inline tiny">
            <input type="checkbox" checked={redactValues} onChange={(event) => setRedactValues(event.target.checked)} />
            hide raw cookie values (proxy only — the agent never sees the secrets)
          </label>
          {error ? <Banner>{error}</Banner> : null}
          <button className="btn primary" onClick={() => void create()}>
            Issue token
          </button>
        </div>
      )}
    </div>
  );
}

function Detail({ bundle, onChanged }: { bundle: Bundle; onChanged: () => void }) {
  const [preview, setPreview] = useState<{ cookies: CookieMeta[]; emptySelectors: Selector[]; errors: Array<{ profileId: string; error: string }> } | null>(null);
  const [name, setName] = useState(bundle.name);
  const [description, setDescription] = useState(bundle.description);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(bundle.name);
    setDescription(bundle.description);
    void api
      .preview(bundle.id)
      .then(setPreview)
      .catch((err: Error) => setError(err.message));
  }, [bundle]);

  const removeSelector = async (selector: Selector) => {
    const selectors = bundle.selectors.filter((s) => !(s.profileId === selector.profileId && s.domain === selector.domain));
    await api.updateBundle(bundle.id, { selectors });
    onChanged();
  };

  const save = async () => {
    await api.updateBundle(bundle.id, { name, description });
    onChanged();
  };

  const hosts = [...new Set((preview?.cookies ?? []).map((c) => c.domain.replace(/^\./, '')))].sort();

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="card plain stack">
        <div className="field">
          <Label colour="blue">Bundle</Label>
          <input type="text" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="field">
          <Label>What is it for?</Label>
          <input
            type="text"
            value={description}
            placeholder="e.g. read-only access to our Linear and Notion"
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        <div className="inline">
          <button className="btn primary sm" onClick={() => void save()}>
            Save
          </button>
          <Copyable value={bundle.id} label="Copy bundle id" />
          <button
            className="btn danger sm"
            onClick={() => {
              if (confirm(`Delete bundle “${bundle.name}”? Tokens for it stop working immediately.`)) {
                void api.deleteBundle(bundle.id).then(onChanged);
              }
            }}
          >
            Delete
          </button>
        </div>
        {error ? <Banner>{error}</Banner> : null}
      </div>

      <div className="card plain stack">
        <Label colour="green">
          Live contents · {preview?.cookies.length ?? 0} cookies · {hosts.length} hosts
        </Label>
        {preview?.errors.map((item) => (
          <Banner kind="warn" key={item.profileId}>
            {item.profileId}: {item.error}
          </Banner>
        ))}
        {preview?.emptySelectors.length ? (
          <Banner kind="warn">
            {preview.emptySelectors.length} selector(s) match nothing right now — you may have logged out in that browser.
          </Banner>
        ) : null}
        <div className="rows">
          {bundle.selectors.map((selector) => (
            <div className="row" key={`${selector.profileId}|${selector.domain}`}>
              <div className="grow">
                <div className="truncate">{selector.domain}</div>
                <div className="tiny faint truncate">
                  {browserGlyph(selector.profileId.split(':')[0])} {selector.profileId} ·{' '}
                  {selector.names.length === 0 ? 'all cookies' : selector.names.join(', ')}
                </div>
              </div>
              <button className="btn ghost sm" onClick={() => void removeSelector(selector)}>
                Remove
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="card plain">
        <GrantPanel bundle={bundle} onChanged={onChanged} />
      </div>

      <div className="card plain">
        <HandoffPanel bundle={bundle} />
      </div>
    </div>
  );
}

export function Bundles({ bundles, onChanged }: { bundles: Bundle[]; onChanged: () => void }) {
  const [selected, setSelected] = useState<string | null>(bundles[0]?.id ?? null);
  const bundle = bundles.find((b) => b.id === selected) ?? bundles[0] ?? null;

  useEffect(() => {
    if (!bundles.some((b) => b.id === selected)) setSelected(bundles[0]?.id ?? null);
  }, [bundles, selected]);

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div>
          <Label colour="red">Bundles</Label>
          <h1 className="display" style={{ marginTop: 6 }}>
            What your agents can use.
          </h1>
        </div>
      </div>

      {bundles.length === 0 ? (
        <Empty title="No bundles yet" hint="Go to Cookies, tick what you want, and gather it into a bundle." />
      ) : (
        <div className="split">
          <div className="stack">
            <div className="card plain" style={{ padding: 0 }}>
              <div className="rows">
                {bundles.map((item) => {
                  const live = item.grants.filter((g) => !g.revokedAt).length;
                  return (
                    <div
                      key={item.id}
                      className="row clickable"
                      onClick={() => setSelected(item.id)}
                      style={item.id === bundle?.id ? { background: 'rgba(255,255,255,0.9)' } : undefined}
                    >
                      <div className="grow">
                        <div className="truncate">{item.name}</div>
                        <div className="tiny faint truncate">
                          {item.selectors.length} site(s) · {live} token(s) · {item.description || 'no description'}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          {bundle ? <Detail bundle={bundle} onChanged={onChanged} /> : null}
        </div>
      )}
    </div>
  );
}
