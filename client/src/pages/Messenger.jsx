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
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 280px) 1fr', gap: 0, border: '1px solid var(--border-sub)', borderRadius: 12, overflow: 'hidden', minHeight: 420 }}>
            {/* thread list */}
            <div style={{ borderRight: '1px solid var(--border-sub)', maxHeight: 560, overflowY: 'auto', background: 'var(--surface-1)' }}>
              {threads.map(t => (
                <button key={t.psid} onClick={() => setOpen(t.psid)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                    padding: '12px 14px', border: 'none', borderBottom: '1px solid var(--border-sub)',
                    borderLeft: `3px solid ${open === t.psid ? 'var(--accent)' : 'transparent'}`,
                    background: open === t.psid ? 'var(--bg-hover)' : 'transparent',
                  }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, alignItems: 'baseline' }}>
                    <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {t.name || `Visitor …${t.psid.slice(-6)}`}
                    </span>
                    <span style={{ fontSize: 10.5, color: 'var(--text-4)', flexShrink: 0 }}>{fmtT(t.last)}</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.messages[t.messages.length - 1]?.q}
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--text-4)', marginTop: 2 }}>{t.messages.length} message{t.messages.length > 1 ? 's' : ''}</div>
                </button>
              ))}
            </div>

            {/* active thread */}
            <div style={{ minWidth: 0, maxHeight: 560, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10, padding: '16px 18px', background: 'var(--bg-hover)' }}>
              {!active ? <div className="no-data">Pick a thread</div> : (
                <>
                  <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--text-4)', marginBottom: 2 }}>
                    Conversation with <b style={{ color: 'var(--text-2)' }}>{active.name || `Visitor …${active.psid.slice(-6)}`}</b> on Facebook Messenger
                  </div>
                  {active.messages.map((m, i) => (
                    <React.Fragment key={i}>
                      <div style={{ alignSelf: 'flex-start', maxWidth: '72%' }}>
                        <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-sub)', borderRadius: '14px 14px 14px 4px', padding: '9px 13px', fontSize: 13.5, lineHeight: 1.5, color: 'var(--text-1)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.q}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-4)', marginTop: 3, paddingLeft: 4 }}>{fmtT(m.at)}</div>
                      </div>
                      <div style={{ alignSelf: 'flex-end', maxWidth: '72%' }}>
                        <div style={{ background: 'var(--accent)', borderRadius: '14px 14px 4px 14px', padding: '9px 13px', fontSize: 13.5, lineHeight: 1.5, color: '#fff', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.a}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-4)', marginTop: 3, textAlign: 'right', paddingRight: 4 }}>Sarah{m.src && m.src !== 'llm' ? ` · ${m.src}` : ''}</div>
                      </div>
                    </React.Fragment>
                  ))}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
