import React, { useEffect, useState } from 'react';
import { api } from '../api.jsx';

/**
 * 💬 Messenger — every conversation Sarah has had on the Facebook page,
 * grouped into per-person threads. Names resolve from the Graph API when
 * permissions allow; otherwise the PSID is shown.
 */
export default function Messenger() {
  const [threads, setThreads] = useState(null);
  const [open, setOpen] = useState(null); // psid

  const load = () => api.getMessengerThreads()
    .then(r => { setThreads(r.data.threads); if (r.data.threads.length && !open) setOpen(r.data.threads[0].psid); })
    .catch(() => setThreads([]));
  useEffect(() => { load(); }, []);

  const fmtT = (at) => String(at).replace('T', ' ').slice(5, 16);
  const active = threads?.find(t => t.psid === open);

  return (
    <div>
      <div className="page-header">
        <h1>💬 Messenger</h1>
        <p>Conversations Sarah has on the Facebook page — same brain as the website widget (live deadlines, FAQ bank, lead capture), delivered through Meta's Messenger</p>
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
          <h2 style={{ margin: 0 }}>Threads {threads ? `(${threads.length})` : ''}</h2>
          <button className="btn-secondary" style={{ width: 'auto', margin: 0 }} onClick={load}>↻ Refresh</button>
        </div>

        {!threads ? <div className="no-data" style={{ padding: 16 }}>Loading…</div>
          : threads.length === 0 ? (
            <div className="no-data" style={{ padding: 16 }}>
              No Messenger conversations yet. In development mode only app admins/testers get replies —
              message the Facebook page from an admin account to test, and submit App Review
              (pages_messaging) to open Sarah to the public.
            </div>
          ) : (
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            {/* thread list */}
            <div style={{ flex: '0 0 240px', minWidth: 200, maxHeight: 480, overflowY: 'auto', display: 'grid', gap: 6 }}>
              {threads.map(t => (
                <button key={t.psid} onClick={() => setOpen(t.psid)}
                  style={{
                    textAlign: 'left', cursor: 'pointer', borderRadius: 10, padding: '10px 12px',
                    border: `1px solid ${open === t.psid ? 'var(--accent)' : 'var(--border-sub)'}`,
                    background: open === t.psid ? 'rgba(249,115,22,0.08)' : 'var(--surface-1)',
                  }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-1)' }}>
                    {t.name || `Visitor …${t.psid.slice(-6)}`}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-4)', marginTop: 2 }}>
                    {t.messages.length} message{t.messages.length > 1 ? 's' : ''} · {fmtT(t.last)}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.messages[t.messages.length - 1]?.q}
                  </div>
                </button>
              ))}
            </div>

            {/* active thread */}
            <div style={{ flex: 1, minWidth: 280, maxHeight: 480, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, padding: '4px 2px' }}>
              {!active ? <div className="no-data">Pick a thread</div> : active.messages.map((m, i) => (
                <React.Fragment key={i}>
                  <div style={{ alignSelf: 'flex-start', maxWidth: '78%', background: 'var(--surface-1)', border: '1px solid var(--border-sub)', borderRadius: '12px 12px 12px 4px', padding: '8px 12px' }}>
                    <div style={{ fontSize: 13, color: 'var(--text-1)', whiteSpace: 'pre-wrap' }}>{m.q}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-4)', marginTop: 3 }}>{fmtT(m.at)}</div>
                  </div>
                  <div style={{ alignSelf: 'flex-end', maxWidth: '78%', background: 'rgba(249,115,22,0.10)', border: '1px solid rgba(249,115,22,0.3)', borderRadius: '12px 12px 4px 12px', padding: '8px 12px' }}>
                    <div style={{ fontSize: 13, color: 'var(--text-1)', whiteSpace: 'pre-wrap' }}>{m.a}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-4)', marginTop: 3 }}>Sarah{m.src && m.src !== 'llm' ? ` · ${m.src}` : ''}</div>
                  </div>
                </React.Fragment>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
