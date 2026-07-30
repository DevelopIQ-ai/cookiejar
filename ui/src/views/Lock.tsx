import { useState } from 'react';
import { api } from '../api';
import { Banner, Label } from '../components';

export function Lock({ vaultExists, onUnlocked }: { vaultExists: boolean; onUnlocked: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!vaultExists && password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      if (vaultExists) await api.unlock(password);
      else await api.createVault(password);
      onUnlocked();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setPassword('');
      setConfirm('');
    }
  };

  return (
    <div className="lock">
      <div className="lock-card stack">
        <div className="cloud">☁️</div>
        <h1 className="display">{vaultExists ? 'Open the jar.' : 'A jar for your cookies.'}</h1>
        <p className="muted tiny" style={{ margin: 0 }}>
          {vaultExists
            ? 'Your bundles are encrypted on this machine. Nothing leaves it.'
            : 'Pick a master password. It encrypts your bundles locally — there is no account, no cloud, no recovery.'}
        </p>
        <div className="dotted-arrow">· · · · · ·</div>
        <form className="card plain stack" onSubmit={submit} style={{ textAlign: 'left' }}>
          <div className="field">
            <Label colour="blue">Master password</Label>
            <input
              type="password"
              value={password}
              autoFocus
              autoComplete={vaultExists ? 'current-password' : 'new-password'}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="at least 8 characters"
            />
          </div>
          {vaultExists ? null : (
            <div className="field">
              <Label colour="yellow">Confirm</Label>
              <input
                type="password"
                value={confirm}
                autoComplete="new-password"
                onChange={(event) => setConfirm(event.target.value)}
              />
            </div>
          )}
          {error ? <Banner>{error}</Banner> : null}
          <button className="btn primary" disabled={busy || password.length < 8}>
            {vaultExists ? 'Unlock' : 'Create the jar'}
          </button>
        </form>
        <p className="faint tiny" style={{ margin: 0 }}>
          Agent tokens only work while the jar is unlocked.
        </p>
      </div>
    </div>
  );
}
