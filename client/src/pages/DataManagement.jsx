import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.jsx';
import { invalidateDeadlineCache } from '../deadlines.jsx';
import WebhookInspector from '../components/WebhookInspector.jsx';
import { useAuth } from '../AuthContext.jsx';
import { toast } from 'react-hot-toast';

// ── level colours (same palette as BootTerminal) ────────────────────────────
const LC = {
  info:'var(--text-3)', ok:'#22c55e', error:'#ef4444', warn:'#f97316',
  call:'#60a5fa', response:'#a78bfa', save:'#34d399', skip:'var(--text-2)', wait:'var(--text-4)',
};

function nowTs() { return new Date().toLocaleTimeString('en-US',{hour12:false}); }

// ── Inline terminal for one event ────────────────────────────────────────────
// On local dev (SSE), the whole purge+fetch+save runs in one long-lived stream
// connection — fine since there's no execution time limit.
// On Vercel, a single request is capped at 60s, which heavy events (lots of
// pages / answer fields) can exceed — so there we purge, then paginate via
// repeated short /api/aggregate/fetch-event calls, the same chunked pattern
// AggregatePanel already uses for bulk Smart Update.
function EventTerminal({ eventId, orgId, eventName, eventStatus, resultsCompleted, isVercel, onDone, onClose }) {
  const [lines,  setLines]  = useState([]);
  const [status, setStatus] = useState('connecting'); // connecting|running|done|error
  const [summary,setSummary]= useState(null);
  const bottomRef  = useRef(null);
  const esRef      = useRef(null);
  const abortRef   = useRef(false);
  // Track whether we already received a terminal event (complete/error).
  // EventSource fires onerror on ANY connection close — including a clean
  // res.end() from the server after success — so we must ignore it in that case.
  const finishedRef = useRef(false);

  function addLine(msg, level='info') {
    setLines(prev => [...prev, { ts: nowTs(), msg, level }]);
  }

  async function runChunked() {
    setStatus('running');
    addLine('STEP 1 — Purging local store…', 'ok');
    let deleted = 0;
    try {
      const res = await api.purge(eventId);
      deleted = res.data.deleted || 0;
      addLine(`  ✓ Deleted ${deleted} results`, 'ok');
    } catch (err) {
      addLine(`✗ Purge failed: ${err.response?.data?.error || err.message}`, 'error');
      setStatus('error');
      return;
    }

    addLine('STEP 2 — Fetching fresh data from SportsEngine (paginated)…', 'ok');
    let page, prevCompact = [], added = 0, fetched = 0;
    try {
      do {
        if (abortRef.current) return;
        const res = await api.aggregateFetchEvent({
          orgId, eventId, eventName, eventStatus,
          resultsCompleted: resultsCompleted || 0,
          ...(page != null ? { page } : {}),
          ...(prevCompact.length ? { prevCompact } : {}),
        });
        fetched = res.data.fetched || fetched;
        addLine(`  ← page ${res.data.page}: ${fetched} fetched so far`, 'response');
        if (res.data.hasMore) {
          page = res.data.nextPage;
          prevCompact = res.data.compact || [];
          await new Promise(r => setTimeout(r, 300));
        } else {
          added = res.data.added || 0;
          page = null;
        }
      } while (page != null);
    } catch (err) {
      addLine(`✗ Fetch failed: ${err.response?.data?.error || err.message}`, 'error');
      setStatus('error');
      return;
    }

    addLine(`✓ Saved ${added} new results`, 'ok');
    addLine('COMPLETE', 'ok');
    const d = { deleted, fetched, added, totalInStore: null };
    setSummary(d);
    setStatus('done');
    if (onDone) onDone(d);
  }

  useEffect(() => {
    if (isVercel) {
      runChunked();
      return () => { abortRef.current = true; };
    }

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
      background:'#080a0f', border:'1px solid var(--surface-1)', borderRadius:10,
      fontFamily:'"Cascadia Code","Fira Code","Consolas",monospace',
      overflow:'hidden', marginTop:8,
    }}>
      {/* title bar */}
      <div style={{
        background:'var(--surface-3)', borderBottom:'1px solid var(--surface-1)',
        padding:'8px 14px', display:'flex', alignItems:'center', gap:10,
      }}>
        <div style={{ display:'flex', gap:5 }}>
          {['#ef4444','#f97316','#22c55e'].map(c=>(
            <div key={c} style={{ width:10, height:10, borderRadius:'50%', background:c }} />
          ))}
        </div>
        <span style={{ color:'var(--text-4)', fontSize:12, flex:1 }}>
          purge-reload — {eventName?.slice(0,60)}
        </span>
        <span style={{ color:statusColor, fontSize:11, fontWeight:700 }}>
          {status==='connecting'?'CONNECTING':status==='running'?'RUNNING':status==='done'?'DONE':'ERROR'}
        </span>
        <button onClick={onClose}
          style={{ background:'none', border:'none', color:'var(--text-4)', cursor:'pointer', fontSize:14, padding:'0 4px' }}>
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
          borderTop:'1px solid var(--surface-1)', background:'rgba(34,197,94,0.1)',
          padding:'10px 14px', display:'flex', gap:20, flexWrap:'wrap',
        }}>
          {[
            { label:'Deleted',     val:summary.deleted,     color:'#ef4444' },
            { label:'Fetched',     val:summary.fetched,     color:'var(--accent-light)' },
            { label:'Saved (new)', val:summary.added,       color:'#22c55e' },
            { label:'Store total', val:summary.totalInStore,color:'#f97316' },
          ].map(s=>(
            <div key={s.label} style={{ fontSize:12 }}>
              <span style={{ color:'var(--text-4)' }}>{s.label}: </span>
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
// ── Registration deadlines (scraped from midwest3on3.com) ─────────────────────
function DeadlinesCard() {
  const [deadlines, setDeadlines] = useState({});
  const [coverage, setCoverage] = useState(null);
  const [scraping, setScraping] = useState(false);
  const [editing, setEditing] = useState(null); // eventId

  async function load({ invalidate = false } = {}) {
    try {
      const [d, c] = await Promise.all([api.getDeadlines(), api.deadlineCoverage()]);
      setDeadlines(d.data.deadlines || {});
      setCoverage(c.data);
      // after an import/scrape/edit, push the fresh list to every chart too
      if (invalidate) invalidateDeadlineCache();
    } catch {}
  }
  useEffect(() => { load(); }, []);

  // "Add manually" for an uncovered event: create an empty manual row and open it
  async function addMissing(ev) {
    await api.setDeadline(ev.id, { eventName: ev.name });
    await load({ invalidate: true });
    setEditing(ev.id);
  }

  async function scrape() {
    setScraping(true);
    try {
      const r = await api.scrapeDeadlines();
      toast.success(`Scraped ${r.data.pagesScanned} pages — ${r.data.matched} events matched`);
      if (r.data.unmatched?.length) toast(`${r.data.unmatched.length} page(s) could not be matched`, { icon: '⚠️' });
      load({ invalidate: true });
    } catch (err) { toast.error(err.response?.data?.error || err.message); }
    finally { setScraping(false); }
  }

  async function save(id, d) {
    try {
      await api.setDeadline(id, d);
      toast.success('Saved (manual override — scraping will not overwrite it)');
      setEditing(null);
      load({ invalidate: true });
    } catch (err) { toast.error(err.message); }
  }

  const entries = Object.entries(deadlines).sort((a, b) => (b[1].earlyBird || '').localeCompare(a[1].earlyBird || ''));

  return (
    <div className="card" style={{ marginTop:20 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:8, marginBottom:8 }}>
        <h2 style={{ margin:0 }}>Registration Deadlines</h2>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
          <button className="btn-secondary" style={{ width:'auto', margin:0 }} title="Download every deadline as a JSON file (portable to production)"
            onClick={() => { window.location.href = api.deadlinesExportUrl(); }}>
            ⬇ Export file
          </button>
          <label className="btn-secondary" style={{ width:'auto', margin:0, cursor:'pointer' }} title="Import a previously exported deadlines file (merges with existing)">
            ⬆ Import file
            <input type="file" accept=".json,application/json" style={{ display:'none' }}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                try {
                  const parsed = JSON.parse(await file.text());
                  const r = await api.importDeadlines({ deadlines: parsed.deadlines || parsed, mode: 'merge' });
                  toast.success(`Imported ${r.data.imported} deadlines (${r.data.skipped} skipped) — ${r.data.total} total`);
                  load({ invalidate: true });
                } catch (err) {
                  toast.error(err.response?.data?.error || 'Not a valid deadlines file');
                }
              }} />
          </label>
          <button className="btn-primary" onClick={scrape} disabled={scraping}>
            {scraping ? 'Scraping midwest3on3.com…' : '🌐 Scrape from midwest3on3.com'}
          </button>
        </div>
      </div>
      <p style={{ fontSize:12, color:'var(--text-3)', margin:'0 0 12px', lineHeight:1.5 }}>
        Early-bird and final registration deadlines pulled from the league/tournament/camp pages,
        matched to SportsEngine events, and shown as EB/Final markers on the YoY comparison charts.
        Edits here become manual overrides that scraping never overwrites.
      </p>
      {/* Coverage: which of this year's events still lack deadlines */}
      {coverage && (
        <div style={{ marginBottom:14, padding:'10px 14px', borderRadius:10,
          background: coverage.covered === coverage.total ? 'rgba(34,197,94,0.08)' : 'rgba(249,115,22,0.08)',
          border: `1px solid ${coverage.covered === coverage.total ? 'rgba(34,197,94,0.3)' : 'rgba(249,115,22,0.3)'}` }}>
          <div style={{ fontSize:12, fontWeight:700, color: coverage.covered === coverage.total ? 'var(--viz-up)' : 'var(--accent-2)', marginBottom: coverage.covered === coverage.total ? 0 : 8 }}>
            {coverage.year} coverage: {coverage.covered}/{coverage.total} events have deadlines
          </div>
          {coverage.events.filter(e => !e.has).map(ev => (
            <div key={ev.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:8, padding:'3px 0', fontSize:12 }}>
              <span style={{ color:'var(--text-2)' }}>✗ {ev.name}</span>
              <button className="btn-chart" style={{ padding:'3px 10px', fontSize:11 }} onClick={() => addMissing(ev)}>+ Add manually</button>
            </div>
          ))}
        </div>
      )}

      {entries.length === 0 ? <div className="no-data">No deadlines yet — run the scraper.</div> : (
        <div style={{ overflowX:'auto' }}>
          <table className="data-table">
            <thead><tr><th>Event</th><th>Early bird</th><th>EB price</th><th>Final</th><th>Final price</th><th></th></tr></thead>
            <tbody>
              {entries.map(([id, d]) => editing === id ? (
                <EditRow key={id} id={id} d={d} onSave={save} onCancel={() => setEditing(null)} />
              ) : (
                <tr key={id}>
                  <td style={{ color:'var(--text-1)', fontWeight:500 }}>{d.eventName}{d.manual && <span className="badge badge-purple" style={{ marginLeft:6, fontSize:9 }}>manual</span>}</td>
                  <td>{d.earlyBird || '—'}</td>
                  <td>{d.earlyBirdPrice ? `$${d.earlyBirdPrice}` : '—'}</td>
                  <td>{d.finalDeadline || '—'}</td>
                  <td>{d.finalPrice ? `$${d.finalPrice}` : '—'}</td>
                  <td><button className="btn-chart" onClick={() => setEditing(id)}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function EditRow({ id, d, onSave, onCancel }) {
  const [f, setF] = useState({ ...d });
  return (
    <tr>
      <td style={{ color:'var(--text-1)' }}>{d.eventName}</td>
      <td><input type="date" className="field-input" value={f.earlyBird || ''} onChange={e => setF(x => ({ ...x, earlyBird: e.target.value }))} /></td>
      <td><input type="number" className="field-input" style={{ width:80 }} value={f.earlyBirdPrice ?? ''} onChange={e => setF(x => ({ ...x, earlyBirdPrice: e.target.value ? Number(e.target.value) : null }))} /></td>
      <td><input type="date" className="field-input" value={f.finalDeadline || ''} onChange={e => setF(x => ({ ...x, finalDeadline: e.target.value }))} /></td>
      <td><input type="number" className="field-input" style={{ width:80 }} value={f.finalPrice ?? ''} onChange={e => setF(x => ({ ...x, finalPrice: e.target.value ? Number(e.target.value) : null }))} /></td>
      <td style={{ whiteSpace:'nowrap' }}>
        <button className="btn-action-green" style={{ marginRight:4 }} onClick={() => onSave(id, f)}>Save</button>
        <button className="btn-chart" onClick={onCancel}>✕</button>
      </td>
    </tr>
  );
}

export default function DataManagement({ ctx }) {
  const { orgId } = ctx;
  const { isAdmin } = useAuth();

  const [storeEvents, setStoreEvents] = useState([]);
  const [allRegs,     setAllRegs]     = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [search,      setSearch]      = useState('');
  // Which event has an active terminal open: eventId | null
  const [activeTerminal, setActiveTerminal] = useState(null);
  // Purge-only loading state per event
  const [purging,     setPurging]     = useState({});
  const [isVercel,    setIsVercel]    = useState(false);
  const [recomputing, setRecomputing] = useState(false);

  useEffect(() => { loadAll(); }, []);
  useEffect(() => {
    fetch('/api/runtime').then(r => r.json()).then(d => setIsVercel(!!d.vercel)).catch(() => {});
  }, []);

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

  async function handleRecomputeStats() {
    if (!window.confirm('Recompute per-event sync counts and dashboard stats from the actual Convex data? Fixes Smart Update skipping events that are missing rows, and double-counted daily stats. Takes ~1–2 minutes; run Smart Update afterward to pull any missing rows.')) return;
    setRecomputing(true);
    try {
      const res = await api.recomputeStats();
      toast.success(res.data.message);
    } catch (err) {
      toast.error('Failed: ' + err.message);
    } finally {
      setRecomputing(false);
    }
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
          { label:'Saved Results',       val:totalSaved,                    color:'var(--accent-light)' },
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
        background:'var(--surface-1)', border:'1px solid var(--line)', borderRadius:10,
        padding:'12px 16px', marginBottom:20, fontSize:13, color:'var(--text-3)', lineHeight:1.7,
      }}>
        <strong style={{color:'var(--text-2)'}}>↺ Purge & Reload</strong> — deletes saved results for that
        league then immediately re-fetches fresh data from SportsEngine. A live terminal appears below
        the row showing every step.&nbsp;&nbsp;
        <strong style={{color:'var(--text-2)'}}>✕ Purge</strong> — removes locally-saved data only (no re-fetch).
        All operations are <strong style={{color:'#22c55e'}}>read-only on SportsEngine</strong> — nothing is
        written to the remote server.
      </div>

      {/* Search */}
      <input type="text" placeholder="Search by name or ID…"
        value={search} onChange={e=>setSearch(e.target.value)}
        style={{
          width:'100%', background:'var(--surface-2)', border:'1px solid var(--line)',
          color:'var(--text-1)', borderRadius:8, padding:'10px 14px', fontSize:14,
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
                      <tr style={{ background: isActive ? 'var(--bg-hover)' : 'transparent' }}>
                        {/* Name */}
                        <td style={{ color:'var(--text-1)', maxWidth:340 }}>
                          {reg.name}
                        </td>

                        {/* ID */}
                        <td style={{ fontFamily:'monospace', color:'var(--accent-light)', fontSize:12 }}>{reg.id}</td>

                        {/* Status */}
                        <td>
                          {reg.status===1
                            ? <span className="badge badge-green">Open</span>
                            : <span className="badge" style={{background:'var(--surface-1)',color:'var(--text-3)'}}>Closed</span>}
                        </td>

                        {/* Saved count */}
                        <td>
                          {reg.inStore
                            ? <span className="badge badge-orange">{reg.savedCount}</span>
                            : <span style={{color:'var(--text-5)',fontSize:12}}>—</span>}
                        </td>

                        {/* Last fetched */}
                        <td style={{fontSize:12,color:'var(--text-4)',whiteSpace:'nowrap'}}>
                          {reg.fetchedAt
                            ? new Date(reg.fetchedAt).toLocaleString()
                            : <span style={{color:'var(--text-5)'}}>Never</span>}
                        </td>

                        {/* Actions */}
                        <td style={{whiteSpace:'nowrap'}}>
                          <div style={{display:'flex',gap:6}}>
                            {/* Purge & Reload — admin only (purges data) */}
                            {isAdmin ? (
                              <button
                                onClick={() => setActiveTerminal(isActive ? null : String(reg.id))}
                                title="Purge saved data then re-fetch from SportsEngine with live terminal"
                                style={{
                                  padding:'5px 12px', borderRadius:6, fontSize:12, fontWeight:600,
                                  border:'none', cursor:'pointer', transition:'all 0.15s',
                                  background: isActive ? '#1d4ed8' : 'var(--chip-bg)',
                                  color: isActive ? '#fff' : 'var(--accent-light)',
                                }}>
                                {isActive ? '▲ Close' : '↺ Purge & Reload'}
                              </button>
                            ) : (
                              <span
                                title="Only admins can purge and reload data"
                                style={{
                                  padding:'5px 12px', borderRadius:6, fontSize:12, fontWeight:600,
                                  background:'var(--surface-1)', color:'var(--text-4)', cursor:'not-allowed',
                                }}>
                                ↺ Purge & Reload
                              </span>
                            )}

                            {/* Purge only — admin only (purges data) */}
                            {reg.inStore && (
                              isAdmin ? (
                                <button
                                  onClick={() => handlePurgeOnly(reg)}
                                  disabled={isPurging}
                                  title="Delete cached data only — no re-fetch"
                                  style={{
                                    padding:'5px 10px', borderRadius:6, fontSize:12, fontWeight:600,
                                    border:'none', cursor: isPurging?'not-allowed':'pointer',
                                    background: isPurging?'var(--surface-1)':'rgba(239,68,68,0.12)', color: isPurging?'var(--text-4)':'var(--danger-text)',
                                    transition:'all 0.15s',
                                  }}>
                                  {isPurging ? '…' : '✕ Purge'}
                                </button>
                              ) : (
                                <span
                                  title="Only admins can purge data"
                                  style={{
                                    padding:'5px 10px', borderRadius:6, fontSize:12, fontWeight:600,
                                    background:'var(--surface-1)', color:'var(--text-4)', cursor:'not-allowed',
                                  }}>
                                  ✕ Purge
                                </span>
                              )
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
                              eventStatus={reg.status}
                              resultsCompleted={reg.resultsCompleted}
                              isVercel={isVercel}
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

      {/* Registration deadlines — scraped from midwest3on3.com, editable */}
      {isAdmin && <DeadlinesCard />}

      {isAdmin && (
        <div className="card" style={{ marginTop:20 }}>
          <h2>SportsEngine Webhook Inspector</h2>
          <WebhookInspector />
        </div>
      )}

      {/* Admin: Recompute dashboard stats (fixes double-counting after purge+refetch on Vercel) */}
      {isAdmin && isVercel && (
        <div className="card" style={{ marginTop:20 }}>
          <h2 style={{ marginBottom:6 }}>Recompute Stats & Sync Counts</h2>
          <p style={{ color:'var(--text-3)', fontSize:12, marginBottom:14, lineHeight:1.6 }}>
            Fixes two Convex-only issues: (1) Smart Update skipping events that are actually
            missing rows (stale/inflated per-event counts), and (2) inaccurate "This Week — Day
            by Day" and other dashboard charts. Recomputes everything from the real data in
            Convex. Takes ~1–2 minutes — then run <strong>Smart Update</strong> to pull any
            rows that were missing.
          </p>
          <button
            disabled={recomputing}
            onClick={handleRecomputeStats}
            style={{ padding:'10px 20px', borderRadius:8, fontSize:13, fontWeight:700,
              border:'1px solid #1e3a5f', cursor:recomputing?'not-allowed':'pointer',
              background:'rgba(59,130,246,0.08)', color:'#3b82f6', opacity:recomputing?0.5:1 }}>
            {recomputing ? '⟳ Starting recompute…' : '⟳ Recompute Stats from Convex Data'}
          </button>
        </div>
      )}
    </div>
  );
}
