import { useCallback, useEffect, useState } from 'react';
import { api, type AppState, type Bundle } from './api';
import { Lock } from './views/Lock';
import { Cookies } from './views/Cookies';
import { Bundles } from './views/Bundles';
import { Activity } from './views/Activity';
import { Settings } from './views/Settings';
import { Onboarding } from './views/Onboarding';
import { Label } from './components';

type Tab = 'cookies' | 'bundles' | 'activity' | 'settings';

const TABS: Array<{ id: Tab; title: string; colour: 'green' | 'red' | 'blue' | 'yellow' }> = [
  { id: 'cookies', title: 'Cookies', colour: 'green' },
  { id: 'bundles', title: 'Bundles', colour: 'red' },
  { id: 'activity', title: 'Activity', colour: 'blue' },
  { id: 'settings', title: 'Settings', colour: 'yellow' },
];

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [tab, setTab] = useState<Tab>('cookies');
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [onboarded, setOnboarded] = useState<boolean | null>(null);

  const refreshState = useCallback(async () => {
    setState(await api.state());
  }, []);

  const refreshBundles = useCallback(() => {
    void api
      .bundles()
      .then((res) => setBundles(res.bundles))
      .catch(() => setBundles([]));
  }, []);

  useEffect(() => {
    void refreshState();
  }, [refreshState]);

  useEffect(() => {
    if (state?.unlocked) refreshBundles();
  }, [state?.unlocked, refreshBundles]);

  useEffect(() => {
    if (!state?.unlocked) return;
    void api
      .onboarding()
      .then((res) => setOnboarded(res.preferences.onboardedAt !== null))
      .catch(() => setOnboarded(true));
  }, [state?.unlocked]);

  if (!state) return <div className="lock" />;

  if (!state.unlocked) {
    return (
      <Lock
        vaultExists={state.vaultExists}
        onUnlocked={() => {
          void refreshState();
        }}
      />
    );
  }

  if (onboarded === null) return <div className="lock" />;
  if (!onboarded) return <Onboarding onDone={() => setOnboarded(true)} />;

  return (
    <div className="shell">
      <aside className="rail">
        <div className="brand">
          <span className="spark">✦</span>
          <span className="name">cookiejar</span>
        </div>
        <nav>
          {TABS.map((item) => (
            <button key={item.id} aria-current={tab === item.id} onClick={() => setTab(item.id)}>
              <span className={`dot ${item.colour}`} />
              <span className="label" style={{ color: 'var(--ink)' }}>
                {item.title}
              </span>
            </button>
          ))}
        </nav>
        <div className="foot">
          <hr className="dotted-rule" style={{ margin: 0 }} />
          <Label colour="green">Unlocked · local only</Label>
          <button
            className="btn ghost sm"
            onClick={() => {
              void api.lock().then(() => refreshState());
            }}
          >
            Lock the jar
          </button>
          <p className="faint tiny" style={{ margin: 0 }}>
            Locking immediately cuts off every agent token.
          </p>
        </div>
      </aside>
      <main className="main">
        {tab === 'cookies' ? <Cookies bundles={bundles} onBundlesChanged={refreshBundles} /> : null}
        {tab === 'bundles' ? <Bundles bundles={bundles} onChanged={refreshBundles} /> : null}
        {tab === 'activity' ? <Activity /> : null}
        {tab === 'settings' ? <Settings state={state} onRerunOnboarding={() => setOnboarded(false)} /> : null}
      </main>
    </div>
  );
}
