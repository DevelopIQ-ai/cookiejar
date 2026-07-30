import { useEffect, useState } from 'react';
import { api, type AuditEntry } from '../api';
import { Empty, Label } from '../components';

const COLOUR: Record<string, 'green' | 'red' | 'blue' | 'yellow'> = {
  unlock: 'green',
  unlock_failed: 'red',
  bundle_read: 'blue',
  bundle_fetch: 'blue',
  grant_created: 'yellow',
  grant_revoked: 'red',
  bundle_saved: 'green',
  bundle_deleted: 'red',
};

export function Activity() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);

  useEffect(() => {
    const load = () => {
      void api.audit().then((res) => setEntries(res.entries));
    };
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div>
          <Label colour="yellow">Activity</Label>
          <h1 className="display" style={{ marginTop: 6 }}>
            Who used what, when.
          </h1>
        </div>
      </div>
      {entries.length === 0 ? (
        <Empty title="Nothing has happened yet" />
      ) : (
        <div className="card plain" style={{ padding: 0 }}>
          <div className="rows">
            {entries.map((entry, index) => (
              <div className="row" key={`${entry.at}-${index}`}>
                <div className="grow">
                  <div className="tiny">
                    <span className={`dot ${COLOUR[entry.event] ?? 'blue'}`} />
                    {entry.event.replace(/_/g, ' ')}
                    {entry.bundleId ? ` · ${entry.bundleId}` : ''}
                    {entry.grantLabel ? ` · ${entry.grantLabel}` : ''}
                  </div>
                  {entry.detail ? <div className="tiny faint truncate">{entry.detail}</div> : null}
                </div>
                <div className="tiny faint">{new Date(entry.at).toLocaleString()}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
