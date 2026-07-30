import { useEffect, useState } from 'react';
import { api, type AppState, type Profile } from '../api';
import { Banner, Copyable, Label, browserGlyph } from '../components';

export function Settings({ state }: { state: AppState }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.profiles().then((res) => setProfiles(res.profiles));
  }, []);

  const change = async () => {
    setError(null);
    setNote(null);
    try {
      await api.changePassword(current, next);
      setNote('Master password changed.');
      setCurrent('');
      setNext('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div>
          <Label colour="blue">Settings</Label>
          <h1 className="display" style={{ marginTop: 6 }}>
            Local, and staying that way.
          </h1>
        </div>
      </div>

      <div className="card plain stack">
        <Label colour="green">This machine</Label>
        <div className="tiny muted">
          Vault: <span className="mono">~/.cookiejar/vault.json</span> (scrypt + AES-256-GCM, 0600)
          <br />
          Auto-lock: {state.autoLockMinutes ? `${state.autoLockMinutes} idle minutes` : 'off'} · platform: {state.platform}
          <br />
          The server listens on 127.0.0.1 only and never makes an outbound request except the ones an agent proxies.
        </div>
      </div>

      <div className="card plain stack">
        <Label colour="yellow">Browser profiles</Label>
        <div className="rows">
          {profiles.map((profile) => (
            <div className="row" key={profile.id}>
              <div className="grow">
                <div className="truncate">
                  {browserGlyph(profile.browser)} {profile.label}
                </div>
                <div className="tiny faint truncate">{profile.error ?? `${profile.cookieCount} cookies · ${profile.path}`}</div>
              </div>
              <div className="tiny faint">{profile.error ? 'unreadable' : `${profile.siteCount} sites`}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="card plain stack">
        <Label colour="red">Master password</Label>
        <div className="inline">
          <input
            type="password"
            value={current}
            placeholder="current"
            autoComplete="current-password"
            onChange={(event) => setCurrent(event.target.value)}
            style={{ maxWidth: 220 }}
          />
          <input
            type="password"
            value={next}
            placeholder="new (8+ characters)"
            autoComplete="new-password"
            onChange={(event) => setNext(event.target.value)}
            style={{ maxWidth: 220 }}
          />
          <button className="btn primary sm" disabled={next.length < 8} onClick={() => void change()}>
            Change
          </button>
        </div>
        {note ? <Banner kind="good">{note}</Banner> : null}
        {error ? <Banner>{error}</Banner> : null}
      </div>

      <div className="card dashed stack">
        <Label>Handy commands</Label>
        <pre className="snippet">{`cookiejar doctor                    # what can be read on this machine
cookiejar export --format netscape --out cookies.txt
curl -b cookies.txt https://example.com/api/me
COOKIEJAR_TOKEN=… cookiejar mcp     # expose one bundle over MCP`}</pre>
        <Copyable value={'cookiejar doctor'} label="Copy doctor command" />
      </div>
    </div>
  );
}
