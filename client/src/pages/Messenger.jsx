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
  const [channel, setChannel] = useState('all'); // all | website | facebook

  // Phone layout: list OR transcript, never side-by-side
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 720px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 720px)');
    const onChange = (e) => setIsMobile(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const load = () => api.getMessengerThreads()
    .then(r => {
      setThreads(r.data.threads);
      // desktop auto-opens the newest thread; mobile stays on the list
      if (r.data.threads.length && !open && !window.matchMedia('(max-width: 720px)').matches) setOpen(r.data.threads[0].psid);
    })
    .catch(() => setThreads([]));
  useEffect(() => { load(); }, []);

  // Relative time in the viewer's local timezone: "just now", "35m ago",
  // "3h ago", "yesterday 4:12 PM", "Tue 4:12 PM", then "Jul 12".
  const localTime = (at) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const localFull = (at) => new Date(at).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const dayDiff = (at) => {
    const d = new Date(at), now = new Date();
    return Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  };
  const ago = (at) => {
    const mins = (Date.now() - new Date(at).getTime()) / 60000;
    if (mins < 2) return 'just now';
    if (mins < 60) return `${Math.round(mins)}m ago`;
    if (mins < 12 * 60 && dayDiff(at) === 0) return `${Math.round(mins / 60)}h ago`;
    const dd = dayDiff(at);
    if (dd === 0) return `today ${localTime(at)}`;
    if (dd === 1) return `yesterday ${localTime(at)}`;
    if (dd < 7) return `${new Date(at).toLocaleDateString([], { weekday: 'short' })} ${localTime(at)}`;
    return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
  // Age color: today orange, yesterday blue, this week purple, older gray
  const AGE_COLORS = { 0: ['rgba(249,115,22,0.15)', '#f97316'], 1: ['rgba(59,130,246,0.15)', '#3b82f6'], week: ['rgba(168,85,247,0.15)', '#a855f7'], older: ['rgba(120,130,145,0.15)', 'var(--text-4)'] };
  const ageColor = (at) => { const d = dayDiff(at); return AGE_COLORS[d] || (d < 7 ? AGE_COLORS.week : AGE_COLORS.older); };
  const TimePill = ({ at }) => {
    const [bg, fg] = ageColor(at);
    return <span title={localFull(at)} style={{ fontSize: 10, fontWeight: 700, color: fg, background: bg, padding: '2px 8px', borderRadius: 999, flexShrink: 0, whiteSpace: 'nowrap' }}>{ago(at)}</span>;
  };
  // Website threads: badge for the page they chatted from, full URL on hover
  const pageBadge = (page) => {
    const u = String(page || '');
    let text = 'main site';
    try {
      const path = u.startsWith('http') ? new URL(u).pathname : u;
      if (path && path !== '/') text = path.replace(/^\//, '').split('/').slice(0, 2).join('/').slice(0, 22);
    } catch {}
    return { text, full: u || 'unknown page' };
  };
  const [showTests, setShowTests] = useState(false);
  const visible = threads?.filter(t => (channel === 'all' || t.channel === channel) && (showTests || !t.isTest));
  const active = threads?.find(t => t.psid === open);
  const label = (t) => t.name || (t.channel === 'website' ? `Visitor …${t.psid.slice(-4)}` : `Visitor …${t.psid.slice(-6)}`);

  return (
    <div>
      <div className="page-header">
        <h1>💬 Conversations</h1>
        <p>Every conversation the assistant has — the website widget on midwest3on3.com and the Facebook page via Messenger — grouped into per-person threads</p>
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <h2 style={{ margin: 0, marginRight: 6 }}>Threads {visible ? `(${visible.length})` : ''}</h2>
            {[['all', 'All'], ['website', '🌐 Website'], ['facebook', '📘 Facebook']].map(([v, l]) => (
              <button key={v} onClick={() => setChannel(v)} className={channel === v ? 'btn-primary' : 'btn-secondary'}
                style={{ width: 'auto', margin: 0, padding: '3px 12px', fontSize: 12 }}>
                {l} {threads ? `(${v === 'all' ? threads.length : threads.filter(t => t.channel === v).length})` : ''}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <label style={{ fontSize: 12, color: 'var(--text-3)', display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
              <input type="checkbox" checked={showTests} onChange={e => setShowTests(e.target.checked)} />
              show test chats ({threads?.filter(t => t.isTest).length ?? 0})
            </label>
            <button className="btn-secondary" style={{ width: 'auto', margin: 0 }} onClick={load}>↻ Refresh</button>
          </div>
        </div>

        {!threads ? <div className="no-data" style={{ padding: 16 }}>Loading…</div>
          : threads.length === 0 ? (
            <div className="no-data" style={{ padding: 16 }}>
              No Messenger conversations yet. In development mode only app admins/testers get replies —
              message the Facebook page from an admin account to test, and submit App Review
              (pages_messaging) to open Sarah to the public.
            </div>
          ) : (
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(220px, 280px) 1fr', gap: 0, border: '1px solid var(--border-sub)', borderRadius: 12, overflow: 'hidden', minHeight: isMobile ? 0 : 420 }}>
            {/* thread list (hidden on mobile while a transcript is open) */}
            <div style={{ display: isMobile && open ? 'none' : 'block', borderRight: isMobile ? 'none' : '1px solid var(--border-sub)', maxHeight: 560, overflowY: 'auto', background: 'var(--surface-1)' }}>
              {visible.map(t => (
                <button key={t.psid} onClick={() => setOpen(t.psid)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                    padding: '12px 14px', border: 'none', borderBottom: '1px solid var(--border-sub)',
                    borderLeft: `3px solid ${open === t.psid ? 'var(--accent)' : 'transparent'}`,
                    background: open === t.psid ? 'var(--bg-hover)' : 'transparent',
                  }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, alignItems: 'center' }}>
                    <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.channel === 'website' ? '🌐' : '📘'} {label(t)}</span>
                      {t.isTest && <span style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--text-3)', border: '1px dashed var(--text-4)', padding: '1px 7px', borderRadius: 999, flexShrink: 0 }}>🧪 test</span>}
                      {t.channel === 'website' && (
                        <span title={pageBadge(t.page).full} style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--accent-light)', background: 'var(--chip-bg-soft)', border: '1px solid var(--chip-border)', padding: '1px 8px', borderRadius: 999, flexShrink: 0, cursor: 'help' }}>
                          {pageBadge(t.page).text}
                        </span>
                      )}
                    </span>
                    <TimePill at={t.last} />
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.messages[t.messages.length - 1]?.q}
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--text-4)', marginTop: 2 }}>{t.messages.length} message{t.messages.length > 1 ? 's' : ''}</div>
                </button>
              ))}
            </div>

            {/* active thread (mobile: full-width with a back button) */}
            <div style={{ display: isMobile && !open ? 'none' : 'flex', minWidth: 0, maxHeight: 560, overflowY: 'auto', flexDirection: 'column', gap: 10, padding: isMobile ? '12px 10px' : '16px 18px', background: 'var(--bg-hover)' }}>
              {!active ? <div className="no-data">Pick a thread</div> : (
                <>
                  {isMobile && (
                    <button onClick={() => setOpen(null)} className="btn-secondary"
                      style={{ width: 'auto', margin: 0, alignSelf: 'flex-start', padding: '5px 14px', fontSize: 13, position: 'sticky', top: 0, zIndex: 2 }}>
                      ← All conversations
                    </button>
                  )}
                  <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--text-4)', marginBottom: 2 }}>
                    Conversation with <b style={{ color: 'var(--text-2)' }}>{label(active)}</b> {active.channel === 'website' ? 'on the website widget' : 'on Facebook Messenger'}
                  </div>
                  {active.messages.map((m, i) => (
                    <React.Fragment key={i}>
                      <div style={{ alignSelf: 'flex-start', maxWidth: '72%' }}>
                        <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-sub)', borderRadius: '14px 14px 14px 4px', padding: '9px 13px', fontSize: 13.5, lineHeight: 1.5, color: 'var(--text-1)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.q}</div>
                        <div title={localFull(m.at)} style={{ fontSize: 10, color: 'var(--text-4)', marginTop: 3, paddingLeft: 4 }}>{ago(m.at)}</div>
                      </div>
                      <div style={{ alignSelf: 'flex-end', maxWidth: '72%' }}>
                        <div style={{ background: 'var(--accent)', borderRadius: '14px 14px 4px 14px', padding: '9px 13px', fontSize: 13.5, lineHeight: 1.5, color: '#fff', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.a}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-4)', marginTop: 3, textAlign: 'right', paddingRight: 4 }}>Courtney{m.src && m.src !== 'llm' ? ` · ${m.src}` : ''}</div>
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
