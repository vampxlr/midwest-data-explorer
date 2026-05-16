import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.jsx';
import { toast } from 'react-hot-toast';

// ── level colours (same palette as BootTerminal) ────────────────────────────
const LC = {
  info:'#64748b', ok:'#22c55e', error:'#ef4444', warn:'#f97316',
  call:'#60a5fa', response:'#a78bfa', save:'#34d399', skip:'#94a3b8', wait:'#475569',
};

// ── Inline terminal for one event ────────────────────────────────────────────
function EventTerminal({ eventId, orgId, eventName, onDone, onClose }) {
  const [lines,  setLines]  = useState([]);
  const [status, setStatus] = useState('connecting'); // connecting|running|done|error
  const [summary,setSummary]= useState(null);
  const bottomRef  = useRef(null);
  const esRef      = useRef(null);
  // Track whether we already received a terminal event (complete/error).
  // EventSource fires onerror on ANY connection close — including a clean
  // res.end() from the server after success — so we must ignore it in that case.
  const finishedRef = useRef(false);

  useEffect(() => {
    const url = api.purgeReloadStreamUrl(eventId, orgId);
    const es  = new EventSource(url);
    esRef.current = es;

    es.addEventListener('log', e => {
      const entry = JSON.parse(e.data);
      setLines(prev => [...prev, entry]);
      setStatus('running');
    });

    es.addEventListener('complete', e => {
      finishedRef.current = true;
      const d = JSON.parse(e.data);
      setSummary(d);
      setStatus('done');
      es.close();
      if (onDone) onDone(d);
    });

    // Named 'error' SSE event sent by the server on a real failure
    es.addEventListener('error', e => {
      finishedRef.current = true;
      try {
        const d = JSON.parse(e.data);
        setLines(prev => [...prev, { ts: new Date().toLocaleTimeString('en-US',{hour12:false}), msg: '✗ ' + d.message, level: 'error' }]);
      } catch {}
      setStatus('error');
      es.close();
    });

    // onerror = network-level error OR normal close after res.end().
    // Only treat it as an actual error if we haven't finished yet.
    es.onerror = () => {
      if (finishedRef.current) return; // clean close after complete — ignore
      // Give the browser 200 ms to process any queued events first
      setTimeout(() => {
        if (finishedRef.current) return;
        setLines(prev => [...prev, {
          ts: new Date().toLocaleTimeString('en-US',{hour12:false}),
          msg: 'Stream closed unexpectedly. The fetch may still be running on the server — check the Reports page in a moment.',
          level: 'warn',
        }]);
        setStatus('error');
        es.close();
      }, 200);
    };

    return () => es.close();
  }, []);

  // Auto-scroll
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior:'smooth' }); }, [lines]);

  const statusColor =
    status==='done'       ? '#22c55e' :
    status==='error'      ? '#ef4444' :
    status==='connecting' ? '#f97316' : '#3b82f6';

  return (
    <div style={{
      background:'#080a0f', border:'1px solid #1e2235', borderRadius:10,
      fontFamily:'"Cascadia Code","Fira Code","Consolas",monospace',
      overflow:'hidden', marginTop:8,
    }}>
      {/* title bar */}
      <div style={{
        background:'#0f1117', borderBottom:'1px solid #1e2235',
        padding:'8px 14px', display:'flex', alignItems:'center', gap:10,
      }}>
        <div style={{ display:'flex', gap:5 }}>
          {['#ef4444','#f97316','#22c55e'].map(c=>(
            <div key={c} style={{ width:10, height:10, borderRadius:'50%', background:c }} />
          ))}
        </div>
        <span style={{ color:'#475569', fontSize:12, flex:1 }}>
          purge-reload — {eventName?.slice(0,60)}
        </span>
        <span style={{ color:statusColor, fontSize:11, fontWeight:700 }}>
          {status==='connecting'?'CONNECTING':status==='running'?'RUNNING':status==='done'?'DONE':'ERROR'}
        </span>
        <button onClick={onClose}
          style={{ background:'none', border:'none', color:'#475569', cursor:'pointer', fontSize:14, padding:'0 4px' }}>
          ✕
        </button>
      </div>

      {/* log body */}
      <div style={{ padding:'12px 14px', maxHeight:340, overflowY:'auto', fontSize:12, lineHeight:1.7 }}>
        {lines.map((l,i) => (
          <div key={i} style={{ display:'flex', gap:10 }}>
            <span style={{ color:'#1e3a5f', flexShrink:0, minWidth:56 }}>{l.ts}</span>
            <span style={{ color: LC[l.level]||LC.info, whiteSpace:'pre-wrap', wordBreak:'break-all' }}>{l.msg}</span>
          </div>
        ))}
        {status==='running' && (
          <div style={{ display:'flex', gap:10 }}>
            <span style={{ color:'#1e3a5f', minWidth:56 }}>{new Date().toLocaleTimeString('en-US',{hour12:false})}</span>
            <span style={{ color:'#22c55e', animation:'blink 1s step-end infinite' }}>█</span>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* summary bar */}
      {summary && (
        <div style={{
          borderTop:'1px solid #1e2235', background:'#0d1f0d',
          padding:'10px 14px', display:'flex', gap:20, flexWrap:'wrap',
        }}>
          {[
            { label:'Deleted',     val:summary.deleted,     color:'#ef4444' },
            { label:'Fetched',     val:summary.fetched,     color:'#60a5fa' },
            { label:'Saved (new)', val:summary.added,       color:'#22c55e' },
            { label:'Store total', val:summary.totalInStore,color:'#f97316' },
          ].map(s=>(
            <div key={s.label} style={{ fontSize:12 }}>
              <span style={{ color:'#475569' }}>{s.label}: </span>
              <span style={{ color:s.color, fontWeight:700 }}>{s.val}</span>
            </div>
          ))}
        </div>
      )}

      <style>{`@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}`}</style>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function DataManagement({ ctx }) {
  const { orgId } = ctx;

  const [storeEvents, setStoreEvents] = useState([]);
  const [allRegs,     setAllRegs]     = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [search,      setSearch]      = useState('');
  // Which event has an active terminal open: eventId | null
  const [activeTerminal, setActiveTerminal] = useState(null);
  // Purge-only loading state per event
  const [purging,     setPurging]     = useState({});

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    try {
      const [se, ar] = await Promise.all([
        api.storeEvents(),
        api.recentRegistrations(orgId),
      ]);
      setStoreEvents(se.data.events || []);
      setAllRegs(ar.data.registrations || []);
    } catch (err) {
      toast.error('Failed to load: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  async function refreshStoreList() {
    const se = await api.storeEvents();
    setStoreEvents(se.data.events || []);
  }

  async function handlePurgeOnly(reg) {
    setPurging(prev => ({ ...prev, [reg.id]: true }));
    try {
      const res = await api.purge(String(reg.id));
      toast.success(`Purged ${res.data.deleted} results from "${reg.name.slice(0,30)}"`);
      await refreshStoreList();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setPurging(prev => ({ ...prev, [reg.id]: false }));
    }
  }

  // Build merged list
  const merged = allRegs.map(reg => {
    const saved = storeEvents.find(e => String(e.id) === String(reg.id));
    return {
      ...reg,
      savedCount: saved?.count || 0,
      fetchedAt:  saved?.meta?.fetchedAt || null,
      inStore:    !!saved,
    };
  }).filter(r =>
    search==='' ||
    r.name.toLowerCase().includes(search.toLowerCase()) ||
    String(r.id).includes(search)
  );

  const totalSaved = storeEvents.reduce((s,e)=>s+e.count,0);

  return (
    <div>
      <div className="page-header">
        <h1>Data Management</h1>
        <p>Purge and reload individual leagues — watch the live terminal as data is re-fetched</p>
      </div>

      {/* Stats */}
      <div className="grid-4" style={{ marginBottom:20 }}>
        {[
          { label:'Saved Results',       val:totalSaved,                    color:'#60a5fa' },
          { label:'Events in Store',     val:storeEvents.length,            color:'#22c55e' },
          { label:'Total Events (SE)',   val:allRegs.length,                color:'#f97316' },
          { label:'Not Yet Fetched',     val:allRegs.length-storeEvents.length, color:'#a855f7' },
        ].map(s=>(
          <div key={s.label} className="stat-card">
            <div className="stat-label">{s.label}</div>
            <div className="stat-value" style={{color:s.color}}>{s.val??'—'}</div>
          </div>
        ))}
      </div>

      {/* Info */}
      <div style={{
        background:'#1e2235', border:'1px solid #2a2d3e', borderRadius:10,
        padding:'12px 16px', marginBottom:20, fontSize:13, color:'#64748b', lineHeight:1.7,
      }}>
        <strong style={{color:'#94a3b8'}}>↺ Purge & Reload</strong> — deletes saved results for that
        league then immediately re-fetches fresh data from SportsEngine. A live terminal appears below
        the row showing every step.&nbsp;&nbsp;
        <strong style={{color:'#94a3b8'}}>✕ Purge</strong> — removes locally-saved data only (no re-fetch).
        All operations are <strong style={{color:'#22c55e'}}>read-only on SportsEngine</strong> — nothing is
        written to the remote server.
      </div>

      {/* Search */}
      <input type="text" placeholder="Search by name or ID…"
        value={search} onChange={e=>setSearch(e.target.value)}
        style={{
          width:'100%', background:'#13161f', border:'1px solid #2a2d3e',
          color:'#e2e8f0', borderRadius:8, padding:'10px 14px', fontSize:14,
          outline:'none', marginBottom:16,
        }} />

      {loading && <div className="no-data">Loading…</div>}

      {!loading && (
        <div className="card" style={{ padding:0, overflow:'hidden' }}>
          <div style={{ overflowX:'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{minWidth:300}}>League / Registration</th>
                  <th>ID</th>
                  <th>Status</th>
                  <th>Saved</th>
                  <th>Last Fetched</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {merged.map(reg => {
                  const isActive  = activeTerminal === String(reg.id);
                  const isPurging = purging[reg.id];

                  return (
                    <React.Fragment key={reg.id}>
                      <tr style={{ background: isActive ? '#0d1520' : 'transparent' }}>
                        {/* Name */}
                        <td style={{ color:'#e2e8f0', maxWidth:340 }}>
                          {reg.name}
                        </td>

                        {/* ID */}
                        <td style={{ fontFamily:'monospace', color:'#60a5fa', fontSize:12 }}>{reg.id}</td>

                        {/* Status */}
                        <td>
                          {reg.status===1
                            ? <span className="badge badge-green">Open</span>
                            : <span className="badge" style={{background:'#1e2235',color:'#64748b'}}>Closed</span>}
                        </td>

                        {/* Saved count */}
                        <td>
                          {reg.inStore
                            ? <span className="badge badge-orange">{reg.savedCount}</span>
                            : <span style={{color:'#334155',fontSize:12}}>—</span>}
                        </td>

                        {/* Last fetched */}
                        <td style={{fontSize:12,color:'#475569',whiteSpace:'nowrap'}}>
                          {reg.fetchedAt
                            ? new Date(reg.fetchedAt).toLocaleString()
                            : <span style={{color:'#334155'}}>Never</span>}
                        </td>

                        {/* Actions */}
                        <td style={{whiteSpace:'nowrap'}}>
                          <div style={{display:'flex',gap:6}}>
                            {/* Purge & Reload */}
                            <button
                              onClick={() => setActiveTerminal(isActive ? null : String(reg.id))}
                              title="Purge saved data then re-fetch from SportsEngine with live terminal"
                              style={{
                                padding:'5px 12px', borderRadius:6, fontSize:12, fontWeight:600,
                                border:'none', cursor:'pointer', transition:'all 0.15s',
                                background: isActive ? '#1d4ed8' : '#1e3a5f',
                                color: isActive ? '#fff' : '#60a5fa',
                              }}>
                              {isActive ? '▲ Close' : '↺ Purge & Reload'}
                            </button>

                            {/* Purge only */}
                            {reg.inStore && (
                              <button
                                onClick={() => handlePurgeOnly(reg)}
                                disabled={isPurging}
                                title="Delete cached data only — no re-fetch"
                                style={{
                                  padding:'5px 10px', borderRadius:6, fontSize:12, fontWeight:600,
                                  border:'none', cursor: isPurging?'not-allowed':'pointer',
                                  background:'#1c0505', color: isPurging?'#475569':'#f87171',
                                  transition:'all 0.15s',
                                }}>
                                {isPurging ? '…' : '✕ Purge'}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>

                      {/* Inline terminal row — only shown when active */}
                      {isActive && (
                        <tr>
                          <td colSpan={6} style={{ padding:'0 16px 16px', background:'#080c12' }}>
                            <EventTerminal
                              eventId={String(reg.id)}
                              orgId={orgId}
                              eventName={reg.name}
                              onDone={async () => { await refreshStoreList(); }}
                              onClose={() => setActiveTerminal(null)}
                            />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
