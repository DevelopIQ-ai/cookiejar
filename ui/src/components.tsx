import { useEffect, useState, type ReactNode } from 'react';

export function Label({ colour, children }: { colour?: 'green' | 'red' | 'blue' | 'yellow'; children: ReactNode }) {
  return (
    <div className="label">
      {colour ? <span className={`dot ${colour}`} /> : null}
      {children}
    </div>
  );
}

export function Copyable({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <button
      className="btn ghost sm"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => setCopied(true));
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

export function Banner({ kind = 'bad', children }: { kind?: 'bad' | 'good' | 'warn'; children: ReactNode }) {
  return <div className={`banner${kind === 'good' ? ' good' : kind === 'warn' ? ' warn' : ''}`}>{children}</div>;
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="card dashed" style={{ textAlign: 'center', padding: '38px 20px' }}>
      <h3 className="display">{title}</h3>
      {hint ? (
        <p className="muted tiny" style={{ margin: '8px 0 0' }}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export const relative = (iso: string | null): string => {
  if (!iso) return 'never';
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
};

export const expiryText = (expires: number): string => {
  if (!expires) return 'session';
  const days = Math.round((expires - Date.now() / 1000) / 86_400);
  if (days < 0) return 'expired';
  if (days === 0) return 'today';
  return `${days}d`;
};

export const browserGlyph = (browser: string): string =>
  browser === 'safari' ? '🧭' : browser === 'firefox' ? '🦊' : browser === 'brave' ? '🦁' : browser === 'edge' ? '🌊' : '🌐';
