import { useEffect, useState } from 'react';
import { api, type Onboarding as OnboardingData } from '../api';
import { Banner, Label, browserGlyph, browserName } from '../components';

export function FullDiskAccessSteps({ terminalHint = true }: { terminalHint?: boolean }) {
  return (
    <ol className="steps tiny muted">
      <li>
        Open <span className="mono">System Settings → Privacy &amp; Security → Full Disk Access</span>.
      </li>
      <li>
        Press <span className="mono">+</span> and add the app that runs cookiejar
        {terminalHint ? ' — Terminal, iTerm, or whichever terminal you typed `cookiejar` into' : ''}.
      </li>
      <li>Turn its switch on, then quit and reopen that app.</li>
      <li>
        Start cookiejar again with <span className="mono">cookiejar ui --open</span>.
      </li>
    </ol>
  );
}

/** First-run questions: which browsers, and any permission they imply. */
export function Onboarding({ onDone }: { onDone: () => void }) {
  const [data, setData] = useState<OnboardingData | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [step, setStep] = useState<'browsers' | 'safari'>('browsers');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await api.onboarding();
      setData(res);
      setChosen((current) => (current.length ? current : res.preferences.browsers.length ? res.preferences.browsers : res.installed.filter((b) => b !== 'safari')));
      return res;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const toggle = (browser: string) =>
    setChosen((current) => (current.includes(browser) ? current.filter((b) => b !== browser) : [...current, browser]));

  const finish = async (browsers: string[]) => {
    try {
      await api.saveOnboarding(browsers, true);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const next = () => {
    if (chosen.includes('safari') && data?.safari !== 'ok') setStep('safari');
    else void finish(chosen);
  };

  const recheck = async () => {
    setChecking(true);
    const res = await load();
    setChecking(false);
    if (res?.safari === 'ok') void finish(chosen);
  };

  if (!data) {
    return (
      <div className="lock">
        <div className="lock-card stack">{error ? <Banner>{error}</Banner> : null}</div>
      </div>
    );
  }

  const options = [...new Set([...data.installed, ...(data.platform === 'darwin' ? ['safari'] : [])])];

  return (
    <div className="lock">
      <div className="lock-card stack" style={{ maxWidth: 560 }}>
        <div className="cloud">🍪</div>
        {step === 'browsers' ? (
          <>
            <h1 className="display">Which browsers do you use?</h1>
            <p className="muted tiny" style={{ margin: 0 }}>
              cookiejar only reads the ones you pick, and only when you ask it to.
            </p>
            <div className="card plain stack" style={{ textAlign: 'left' }}>
              <Label colour="blue">Found on this Mac</Label>
              <div className="choices">
                {options.map((browser) => (
                  <button
                    key={browser}
                    type="button"
                    className="choice"
                    aria-pressed={chosen.includes(browser)}
                    onClick={() => toggle(browser)}
                  >
                    <span className="glyph">{browserGlyph(browser)}</span>
                    <span>{browserName(browser)}</span>
                    {browser === 'safari' && data.safari !== 'ok' ? <span className="tiny faint">needs permission</span> : null}
                  </button>
                ))}
              </div>
              {options.length === 0 ? (
                <p className="tiny muted" style={{ margin: 0 }}>
                  No browser cookie stores found. Open a browser, sign in somewhere, then reload this page.
                </p>
              ) : null}
              {error ? <Banner>{error}</Banner> : null}
              <div className="inline">
                <button className="btn primary" disabled={chosen.length === 0} onClick={next}>
                  Continue
                </button>
                <button className="btn ghost sm" onClick={() => void finish(chosen)}>
                  Skip
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <h1 className="display">Safari needs one permission.</h1>
            <p className="muted tiny" style={{ margin: 0 }}>
              macOS keeps Safari&rsquo;s cookies in a protected container. Any app that reads them — including cookiejar — needs
              Full Disk Access. Chrome and Firefox do not.
            </p>
            <div className="card plain stack" style={{ textAlign: 'left' }}>
              <Label colour="yellow">Grant Full Disk Access</Label>
              <FullDiskAccessSteps />
              <p className="tiny faint" style={{ margin: 0 }}>
                macOS only applies the permission to freshly launched apps, so cookiejar has to be restarted after you flip the
                switch.
              </p>
              {data.safari === 'ok' ? <Banner kind="good">Safari cookies are readable.</Banner> : null}
              {error ? <Banner>{error}</Banner> : null}
              <div className="inline">
                <button className="btn primary" disabled={checking} onClick={() => void recheck()}>
                  {checking ? 'Checking…' : 'Check again'}
                </button>
                <button className="btn ghost sm" onClick={() => void finish(chosen.filter((b) => b !== 'safari'))}>
                  Continue without Safari
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
