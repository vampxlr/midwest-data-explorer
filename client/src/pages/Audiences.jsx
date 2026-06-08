/**
 * FB Audiences page — two-panel layout:
 *   Left:  Contact Store (fetch contacts from SE, event-by-event status)
 *   Right: Audience Builder (filter by leagues/year/gender → instant CSV export)
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie,
} from 'recharts';
import { api, withToken } from '../api.jsx';
import { useAuth } from '../AuthContext.jsx';
import { toast } from 'react-hot-toast';

function fmt10(phone) {
  if (!phone) return '—';
  const d = String(phone).replace(/\D/g,'').slice(-10);
  if (d.length < 10) return phone;
  return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
}
import SearchableSelect from '../components/SearchableSelect.jsx';

const PIE_COLORS  = ['#3b82f6','#f97316','#22c55e','#a855f7','#ec4899','#14b8a6'];
const LOG_COLOR   = { info:'var(--text-3)', ok:'#22c55e', error:'#ef4444', warn:'#f97316', response:'#a78bfa', skip:'var(--text-2)' };
const curYear     = new Date().getFullYear().toString();

// ── Helpers ───────────────────────────────────────────────────────────────────
const Tip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background:'var(--surface-3)', border:'1px solid var(--line)', borderRadius:8, padding:'8px 12px' }}>
      {label && <p style={{ color:'var(--text-2)', fontSize:11, marginBottom:3 }}>{label}</p>}
      {payload.map((p,i)=><p key={i} style={{color:p.color||'var(--accent-light)',fontSize:13,fontWeight:700,margin:'2px 0'}}>{p.name}: {p.value}</p>)}
    </div>
  );
};

function StatCard({ label, value, sub, color='var(--accent-light)' }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ color, fontSize:28 }}>{value ?? '—'}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

// ── SSE Log Terminal ──────────────────────────────────────────────────────────
function ContactTerminal({ logs, status, onClose }) {
  const bottomRef = useRef(null);
  useEffect(()=>{ bottomRef.current?.scrollIntoView({behavior:'smooth'}); }, [logs]);

  const statusColor = status==='done'?'#22c55e':status==='error'?'#ef4444':status==='idle'?'var(--text-5)':'#3b82f6';
  return (
    <div style={{ background:'#080a0f', border:'1px solid var(--surface-1)', borderRadius:10, overflow:'hidden', fontFamily:'monospace', marginTop:12 }}>
      <div style={{ background:'var(--surface-3)', borderBottom:'1px solid var(--surface-1)', padding:'7px 14px', display:'flex', alignItems:'center', gap:10 }}>
        <div style={{ display:'flex', gap:4 }}>
          {['#ef4444','#f97316','#22c55e'].map(c=><div key={c} style={{width:10,height:10,borderRadius:'50%',background:c}}/>)}
        </div>
        <span style={{ color:'var(--text-4)', fontSize:11, flex:1 }}>Contact Fetch — SportsEngine</span>
        <span style={{ color:statusColor, fontSize:11, fontWeight:700 }}>
          {status==='done'?'DONE':status==='error'?'ERROR':status==='idle'?'IDLE':'RUNNING'}
        </span>
        {status!=='running'&&onClose&&(
          <button onClick={onClose} style={{background:'none',border:'none',color:'var(--text-4)',cursor:'pointer',fontSize:14}}>✕</button>
        )}
      </div>
      <div style={{ padding:'10px 14px', maxHeight:240, overflowY:'auto', fontSize:11, lineHeight:1.7 }}>
        {logs.length===0 && <span style={{color:'var(--text-5)'}}>Waiting to start…</span>}
        {logs.map((l,i)=>(
          <div key={i} style={{display:'flex',gap:8}}>
            <span style={{color:'#1e3a5f',flexShrink:0,minWidth:52}}>{l.ts}</span>
            <span style={{color:LOG_COLOR[l.level]||'var(--text-3)',whiteSpace:'pre-wrap',wordBreak:'break-all'}}>{l.msg}</span>
          </div>
        ))}
        {status==='running'&&<div style={{color:'#22c55e',animation:'blink 1s step-end infinite'}}>█</div>}
        <div ref={bottomRef}/>
      </div>
      <style>{`@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}`}</style>
    </div>
  );
}

// ── Left panel: Contact Store ─────────────────────────────────────────────────
function ContactStorePanel({ recentRegs, onStoreUpdated }) {
  const { isAdmin } = useAuth();
  const [cStatus,    setCStatus]    = useState(null);
  const [fetching,   setFetching]   = useState(false);
  const [logs,       setLogs]       = useState([]);
  const [termStatus, setTermStatus] = useState('idle');
  const [showTerm,   setShowTerm]   = useState(false);
  const [progress,   setProgress]   = useState({ current:0, total:0 });
  const esRef = useRef(null);

  useEffect(()=>{ loadStatus(); }, []);

  async function loadStatus() {
    try { const r = await api.contactsStatus(); setCStatus(r.data); } catch {}
  }

  function connectSSE() {
    if (esRef.current) esRef.current.close();
    const es = new EventSource(withToken('/api/contacts/stream'));
    esRef.current = es;
    es.addEventListener('state', e => {
      const s = JSON.parse(e.data);
      setProgress({ current:s.current||0, total:s.total||0 });
      setFetching(s.running||false);
    });
    es.addEventListener('log', e => {
      setLogs(prev=>[...prev,JSON.parse(e.data)].slice(-100));
    });
    es.addEventListener('complete', e => {
      setFetching(false);
      setTermStatus('done');
      loadStatus();
      if (onStoreUpdated) onStoreUpdated();
    });
    es.onerror = ()=>{};
    return es;
  }

  useEffect(()=>{
    const es = connectSSE();
    return ()=>es.close();
  }, []);

  async function startFetch(which, events, purgeFirst = false) {
    setLogs([]); setTermStatus('running'); setShowTerm(true);
    try {
      const eventObjs = events ? events.map(r => ({
        id: r.id, name: r.name, status: r.status,
        open: r.open, close: r.close, sport: r.sport,
        resultsCompleted: r.resultsCompleted,
      })) : null;
      const payload = { orgId:'8008', purgeFirst };
      if (eventObjs) payload.eventIds = eventObjs;
      const r = await api.contactsFetch(payload);
      if (!r.data.started) toast.error(r.data.message);
    } catch (err) { toast.error('Failed: '+err.message); setTermStatus('error'); }
  }

  const pct = progress.total>0 ? Math.round(progress.current/progress.total*100) : 0;
  const openEvents   = recentRegs.filter(r=>r.status===1);
  const closedEvents = recentRegs.filter(r=>r.status!==1);

  // Events not yet in contact store
  const fetchedIds   = new Set(Object.keys(cStatus?.events||{}));
  const notFetched   = recentRegs.filter(r=>!fetchedIds.has(String(r.id)));
  const needsRefresh = openEvents.filter(r=>fetchedIds.has(String(r.id)));

  return (
    <div>
      <h2 style={{marginBottom:16}}>Contact Store</h2>
      <p style={{color:'var(--text-3)',fontSize:12,marginBottom:16,lineHeight:1.6}}>
        Stores registrant contact details (email, name, phone) locally.
        <br/><strong style={{color:'var(--text-2)'}}>Closed events</strong> are fetched once and never re-fetched.
        <strong style={{color:'var(--text-2)'}}> Open events</strong> can be refreshed to pick up new registrations.
      </p>

      {/* Stats */}
      <div className="grid-2" style={{gap:12,marginBottom:16}}>
        <StatCard label="Total Contacts" value={cStatus?.totalContacts??0} color="var(--accent-light)" sub="emails + location"/>
        <StatCard label="Events Covered" value={cStatus?.totalEvents??0}   color="#22c55e" sub={`of ${recentRegs.length} total`}/>
        <StatCard label="Closed (cached)" value={cStatus?.closedFetched??0} color="var(--text-2)" sub="won't change"/>
        <StatCard label="Open (live)"     value={cStatus?.openFetched??0}   color="#f97316" sub="refresh anytime"/>
      </div>

      {/* Progress bar (shown when running) */}
      {fetching && (
        <div style={{marginBottom:12}}>
          <div style={{display:'flex',justifyContent:'space-between',fontSize:11,color:'var(--text-3)',marginBottom:4}}>
            <span>Fetching contacts…</span>
            <span>{progress.current}/{progress.total} events ({pct}%)</span>
          </div>
          <div style={{background:'var(--surface-1)',borderRadius:8,height:10,overflow:'hidden'}}>
            <div style={{width:`${pct}%`,height:'100%',background:'#3b82f6',borderRadius:8,transition:'width 0.3s'}}/>
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div style={{display:'flex',flexDirection:'column',gap:8,marginBottom:12}}>
        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
          <button disabled={fetching}
            onClick={()=>startFetch('all-closed', closedEvents)}
            style={{flex:1,padding:'10px 14px',borderRadius:8,fontSize:12,fontWeight:700,border:'1px solid #14532d',
              cursor:fetching?'not-allowed':'pointer',background:'rgba(34,197,94,0.08)',color:'#22c55e',opacity:fetching?0.4:1}}>
            ↺ Fetch All Closed ({closedEvents.length})
            <div style={{fontSize:10,color:'#14532d',fontWeight:400,marginTop:2}}>fetch once, cached permanently</div>
          </button>
          <button disabled={fetching}
            onClick={()=>startFetch('all-open', openEvents)}
            style={{flex:1,padding:'10px 14px',borderRadius:8,fontSize:12,fontWeight:700,border:'1px solid #431407',
              cursor:fetching?'not-allowed':'pointer',background:'rgba(249,115,22,0.08)',color:'#f97316',opacity:fetching?0.4:1}}>
            ↺ Refresh Open ({openEvents.length})
            <div style={{fontSize:10,color:'#431407',fontWeight:400,marginTop:2}}>pick up new registrations</div>
          </button>
        </div>

        {notFetched.length > 0 && (
          <button disabled={fetching}
            onClick={()=>startFetch('not-fetched', notFetched)}
            style={{padding:'8px 14px',borderRadius:8,fontSize:12,fontWeight:700,border:'1px solid var(--line)',
              cursor:fetching?'not-allowed':'pointer',background:'var(--surface-1)',color:'var(--text-2)',opacity:fetching?0.4:1}}>
            ↺ Fetch {notFetched.length} not-yet-fetched events
          </button>
        )}

        {/* Force re-fetch — purges stored contacts first so count-unchanged skip is bypassed. Admin only (purges data). */}
        {isAdmin ? (
          <button disabled={fetching}
            onClick={()=>{
              if (!window.confirm(`This will purge and re-fetch ALL ${recentRegs.length} events to rebuild emails for all players. Continue?`)) return;
              startFetch('all', null, true);
            }}
            style={{padding:'8px 14px',borderRadius:8,fontSize:12,fontWeight:700,border:'1px solid #3b1f5e',
              cursor:fetching?'not-allowed':'pointer',background:'rgba(124,58,237,0.08)',color:'#a855f7',opacity:fetching?0.4:1}}>
            ⟳ Force Re-fetch All — Rebuild Player Emails
            <div style={{fontSize:10,color:'#3b1f5e',fontWeight:400,marginTop:2}}>
              purges existing contacts · re-fetches every event · captures all player emails per team
            </div>
          </button>
        ) : (
          <div title="Only admins can purge contact data"
            style={{padding:'8px 14px',borderRadius:8,fontSize:12,fontWeight:700,border:'1px solid var(--line)',
              cursor:'not-allowed',background:'var(--surface-1)',color:'var(--text-4)',opacity:0.6}}>
            ⟳ Force Re-fetch All — Rebuild Player Emails
            <div style={{fontSize:10,fontWeight:400,marginTop:2}}>
              admin only — this action purges existing contact data
            </div>
          </div>
        )}
      </div>

      {/* Terminal */}
      {(showTerm || logs.length>0) && (
        <ContactTerminal logs={logs} status={fetching?'running':termStatus} onClose={()=>setShowTerm(false)}/>
      )}

      {/* Event list */}
      {cStatus?.events?.length > 0 && (
        <div style={{marginTop:16}}>
          <p style={{margin:'0 0 8px',fontSize:10,color:'var(--text-3)',fontWeight:700,textTransform:'uppercase',letterSpacing:'0.5px'}}>
            Fetched Events
          </p>
          <div style={{maxHeight:280,overflowY:'auto'}}>
            {cStatus.events.map(ev=>(
              <div key={ev.id} style={{display:'flex',alignItems:'center',gap:10,padding:'7px 10px',
                background:'var(--surface-2)',border:'1px solid var(--line)',borderRadius:8,marginBottom:4}}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:11,color:'#cbd5e1',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{ev.name}</div>
                  <div style={{fontSize:10,color:'var(--text-4)'}}>
                    {ev.status===1
                      ? <span style={{color:'#22c55e'}}>Open</span>
                      : <span style={{color:'var(--text-3)'}}>Closed</span>}
                    {' · '}fetched {new Date(ev.fetchedAt).toLocaleString()}
                  </div>
                </div>
                <span style={{color:'var(--accent-light)',fontWeight:700,fontSize:13,flexShrink:0}}>{ev.contactCount}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Right panel: Audience Builder ─────────────────────────────────────────────
function AudienceBuilder({ recentRegs, contactStatus }) {
  const [step,          setStep]          = useState(1);
  // Step 1: league selection mode
  const [leagueMode,    setLeagueMode]    = useState('all');        // 'all' | 'year' | 'custom'
  const [selectedYears, setSelectedYears] = useState(new Set([curYear])); // for 'year' mode — multi
  const [customLeagues, setCustomLeagues] = useState([]);               // for 'custom' mode
  // Step 2: grad year range
  const [yearFrom,      setYearFrom]      = useState('');
  const [yearTo,        setYearTo]        = useState('');
  // Step 3: gender
  const [selGenders,    setSelGenders]    = useState(new Set()); // empty = all
  // Preview
  const [preview,       setPreview]       = useState(null);
  const [previewing,    setPreviewing]    = useState(false);
  // Export label
  const [label,         setLabel]         = useState('');

  // All years from recentRegs
  const availableYears = [...new Set(
    recentRegs.map(r=>(r.close||r.open||'').slice(0,4)).filter(y=>/^20\d{2}$/.test(y))
  )].sort().reverse();

  // All unique grad years from contact store
  const allGradYears = contactStatus
    ? [...new Set(
        (contactStatus.events||[]).flatMap(()=>[]) // we'd need aggregate data
      )]
    : [];

  // Compute selected eventIds based on league mode
  function getEventIds() {
    if (leagueMode==='all') return null; // null = all
    if (leagueMode==='year') {
      if (!selectedYears.size) return null;
      return recentRegs
        .filter(r => selectedYears.has((r.close||r.open||'').slice(0,4)))
        .map(r => String(r.id));
    }
    return customLeagues.map(l=>String(l.id));
  }

  function getGenders() {
    return selGenders.size>0 ? [...selGenders] : null;
  }

  async function refreshPreview() {
    const params = new URLSearchParams();
    const ids = getEventIds();
    if (ids) params.set('eventIds', ids.join(','));
    if (yearFrom) params.set('gradYearFrom', yearFrom);
    if (yearTo)   params.set('gradYearTo',   yearTo);
    const genders = getGenders();
    if (genders) params.set('genders', genders.join(','));
    setPreviewing(true);
    try {
      const r = await api.contactsPreview(Object.fromEntries(params));
      setPreview(r.data);
    } catch {}
    finally { setPreviewing(false); }
  }

  useEffect(()=>{ if (step>=2) refreshPreview(); }, [step, leagueMode, selectedYears, customLeagues, yearFrom, yearTo, selGenders]);

  function downloadCSV() {
    const url = api.contactsExportUrl({
      eventIds:     getEventIds(),
      gradYearFrom: yearFrom || undefined,
      gradYearTo:   yearTo   || undefined,
      genders:      getGenders(),
      label:        label || buildLabel(),
    });
    window.location.href = url;
    toast.success(`Downloading ${preview?.total||'?'} contacts as CSV`);
  }

  function buildLabel() {
    const parts = [];
    if (leagueMode==='year') parts.push([...selectedYears].sort().join('-') || 'year');
    else if (leagueMode==='custom') parts.push(`${customLeagues.length}leagues`);
    else parts.push('all');
    if (yearFrom||yearTo) parts.push(`${yearFrom||'*'}-${yearTo||'*'}`);
    const g = getGenders();
    if (g) parts.push(g.join('-'));
    return parts.join('_');
  }

  // Known genders from events (simplify: standard options)
  const genderOptions = ['Boys','Girls','Mixed'];

  const StepBar = () => (
    <div style={{display:'flex',gap:0,marginBottom:20}}>
      {[{n:1,label:'Leagues'},{n:2,label:'Grad Year'},{n:3,label:'Gender + Export'}].map(({n,label},i)=>(
        <React.Fragment key={n}>
          <div onClick={()=>step>n&&setStep(n)}
            style={{display:'flex',alignItems:'center',gap:6,fontSize:11,fontWeight:700,
              color:step===n?'var(--accent-light)':step>n?'#22c55e':'var(--text-4)',
              cursor:step>n?'pointer':'default'}}>
            <div style={{width:22,height:22,borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',
              background:step===n?'var(--chip-bg)':step>n?'#14532d':'var(--surface-1)',
              border:`1px solid ${step===n?'#3b82f6':step>n?'#22c55e':'var(--text-5)'}`,
              color:step===n?'var(--accent-light)':step>n?'#4ade80':'var(--text-4)',fontSize:11,fontWeight:800}}>
              {step>n?'✓':n}
            </div>
            <span style={{whiteSpace:'nowrap'}}>{label}</span>
          </div>
          {i<2&&<div style={{flex:1,height:1,background:step>n?'#22c55e':'var(--text-5)',margin:'11px 8px 0'}}/>}
        </React.Fragment>
      ))}
    </div>
  );

  return (
    <div>
      <h2 style={{marginBottom:4}}>Audience Builder</h2>
      <p style={{color:'var(--text-3)',fontSize:12,marginBottom:16,lineHeight:1.6}}>
        Build a Facebook Custom Audience CSV from your stored contacts. Instant — no API calls.
        {contactStatus && <span style={{color:'var(--accent-light)',fontWeight:700}}> {contactStatus.totalContacts} contacts available.</span>}
      </p>

      {(!contactStatus||contactStatus.totalContacts===0) && (
        <div style={{background:'rgba(249,115,22,0.12)',border:'1px solid rgba(249,115,22,0.35)',borderRadius:10,padding:'14px 16px',marginBottom:16,fontSize:13,color:'var(--accent-2)'}}>
          ⚠ No contacts stored yet. Use the Contact Store panel to fetch contact details from SportsEngine first.
        </div>
      )}

      <StepBar/>

      {/* ── Step 1: League Selection ─────────────────────────────── */}
      {step===1 && (
        <div>
          <p style={{fontSize:12,color:'var(--text-2)',marginBottom:14}}>Which leagues should this audience include?</p>

          {/* Mode selector cards */}
          <div style={{display:'flex',flexDirection:'column',gap:8,marginBottom:20}}>
            {[
              { id:'all',    label:'All Leagues', desc:`All ${recentRegs.length} leagues in the contact store` },
              { id:'year',   label:'By Year', desc:'All leagues from one or more season years (multi-select)' },
              { id:'custom', label:'Custom Selection', desc:'Pick individual leagues by name' },
            ].map(m=>(
              <label key={m.id} onClick={()=>setLeagueMode(m.id)}
                style={{display:'flex',alignItems:'center',gap:12,padding:'12px 16px',
                  background:leagueMode===m.id?'var(--chip-bg-soft)':'var(--surface-2)',
                  border:`1px solid ${leagueMode===m.id?'#3b82f6':'var(--line)'}`,
                  borderRadius:10,cursor:'pointer',transition:'all 0.12s'}}>
                <div style={{width:18,height:18,borderRadius:'50%',
                  border:`2px solid ${leagueMode===m.id?'#3b82f6':'var(--text-5)'}`,
                  background:leagueMode===m.id?'#2563eb':'transparent',
                  display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                  {leagueMode===m.id&&<div style={{width:6,height:6,borderRadius:'50%',background:'#fff'}}/>}
                </div>
                <div>
                  <div style={{fontSize:13,fontWeight:700,color:leagueMode===m.id?'var(--text-1)':'var(--text-3)'}}>{m.label}</div>
                  <div style={{fontSize:11,color:'var(--text-4)'}}>{m.desc}</div>
                </div>
              </label>
            ))}
          </div>

          {/* Year picker — multi-select */}
          {leagueMode==='year' && (
            <div style={{marginBottom:16}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:6}}>
                <label style={{fontSize:10,color:'var(--text-3)',fontWeight:600,textTransform:'uppercase',letterSpacing:'0.5px'}}>
                  Season Year(s) — click to toggle
                </label>
                {selectedYears.size > 0 && (
                  <button onClick={()=>setSelectedYears(new Set())}
                    style={{fontSize:10,background:'none',border:'none',color:'var(--text-4)',cursor:'pointer',padding:'0 4px'}}>
                    clear all
                  </button>
                )}
              </div>
              <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
                {availableYears.map(y=>{
                  const on = selectedYears.has(y);
                  return (
                    <button key={y} onClick={()=>setSelectedYears(prev=>{
                        const n = new Set(prev);
                        on ? n.delete(y) : n.add(y);
                        return n;
                      })}
                      style={{padding:'8px 20px',borderRadius:8,fontSize:13,fontWeight:700,border:'none',cursor:'pointer',
                        background:on?'#2563eb':'var(--surface-1)',color:on?'#fff':'var(--text-3)',
                        outline: on?'2px solid #3b82f6':'none', outlineOffset:1}}>
                      {y}
                    </button>
                  );
                })}
              </div>
              {selectedYears.size > 0 && (
                <div style={{marginTop:8,fontSize:11,color:'var(--text-3)'}}>
                  {(() => {
                    const ids = recentRegs.filter(r=>selectedYears.has((r.close||r.open||'').slice(0,4)));
                    return `${ids.length} league${ids.length!==1?'s':''} selected across ${[...selectedYears].sort().join(', ')}`;
                  })()}
                </div>
              )}
            </div>
          )}

          {/* Custom league picker */}
          {leagueMode==='custom' && (
            <div style={{marginBottom:16}}>
              <label style={{display:'block',fontSize:10,color:'var(--text-3)',marginBottom:6,fontWeight:600,textTransform:'uppercase',letterSpacing:'0.5px'}}>
                Add Leagues
              </label>
              <SearchableSelect
                value=""
                onChange={id=>{
                  const r = recentRegs.find(x=>String(x.id)===String(id));
                  if (r&&!customLeagues.find(l=>String(l.id)===String(r.id)))
                    setCustomLeagues(prev=>[...prev,{id:r.id,name:r.name}]);
                }}
                options={recentRegs.filter(r=>!customLeagues.find(l=>String(l.id)===String(r.id))).map(r=>({value:String(r.id),label:r.name}))}
                placeholder="Search and add a league…"
                style={{marginBottom:10}}
              />
              <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
                {customLeagues.map(l=>(
                  <div key={l.id} style={{display:'flex',alignItems:'center',gap:5,background:'var(--surface-1)',border:'1px solid var(--line)',borderRadius:20,padding:'4px 10px 4px 12px',fontSize:11}}>
                    <span style={{color:'#cbd5e1',maxWidth:220,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{l.name}</span>
                    <button onClick={()=>setCustomLeagues(prev=>prev.filter(x=>String(x.id)!==String(l.id)))}
                      style={{background:'none',border:'none',color:'var(--text-4)',cursor:'pointer',fontSize:14,lineHeight:1,padding:'0 2px'}}>×</button>
                  </div>
                ))}
              </div>
              {customLeagues.length===0&&<p style={{color:'var(--text-5)',fontSize:11,margin:'6px 0 0'}}>No leagues selected yet.</p>}
            </div>
          )}

          {(() => {
            const disabled = (leagueMode==='custom' && customLeagues.length===0) ||
                             (leagueMode==='year'   && selectedYears.size===0);
            return (
              <button onClick={()=>setStep(2)} disabled={disabled}
                style={{padding:'10px 28px',background:'#2563eb',color:'#fff',border:'none',borderRadius:8,
                  cursor:disabled?'not-allowed':'pointer',fontWeight:700,fontSize:13,opacity:disabled?0.4:1}}>
                Next: Grad Year Range →
              </button>
            );
          })()}
        </div>
      )}

      {/* ── Step 2: Grad Year Range ──────────────────────────────── */}
      {step===2 && (
        <div>
          <p style={{fontSize:12,color:'var(--text-2)',marginBottom:14}}>
            Filter by graduation year range. Leave both blank to include all years.
          </p>
          <div style={{display:'flex',gap:16,marginBottom:20,flexWrap:'wrap',alignItems:'flex-end'}}>
            <div>
              <label style={{display:'block',fontSize:10,color:'var(--text-3)',marginBottom:5,fontWeight:600,textTransform:'uppercase'}}>From Year</label>
              <input type="number" min="2020" max="2040" value={yearFrom}
                onChange={e=>setYearFrom(e.target.value)}
                placeholder="e.g. 2028"
                style={{background:'var(--surface-2)',border:'1px solid var(--line)',color:'var(--text-1)',borderRadius:8,padding:'8px 14px',fontSize:14,fontWeight:600,width:120,outline:'none'}}/>
            </div>
            <div>
              <label style={{display:'block',fontSize:10,color:'var(--text-3)',marginBottom:5,fontWeight:600,textTransform:'uppercase'}}>To Year</label>
              <input type="number" min="2020" max="2040" value={yearTo}
                onChange={e=>setYearTo(e.target.value)}
                placeholder="e.g. 2033"
                style={{background:'var(--surface-2)',border:'1px solid var(--line)',color:'var(--text-1)',borderRadius:8,padding:'8px 14px',fontSize:14,fontWeight:600,width:120,outline:'none'}}/>
            </div>
            <button onClick={()=>{setYearFrom('');setYearTo('');}}
              style={{padding:'8px 14px',borderRadius:8,fontSize:12,border:'1px solid var(--line)',background:'var(--surface-1)',color:'var(--text-3)',cursor:'pointer',fontWeight:600}}>
              Clear
            </button>
          </div>

          {/* Preview */}
          {previewing && <div style={{color:'var(--text-3)',fontSize:12,marginBottom:12}}>Computing preview…</div>}
          {!previewing && preview && (
            <div style={{background:'var(--surface-3)',border:'1px solid var(--line)',borderRadius:10,padding:'14px',marginBottom:16}}>
              <div style={{display:'flex',gap:20,marginBottom:12,flexWrap:'wrap'}}>
                <div><div style={{fontSize:10,color:'var(--text-3)',textTransform:'uppercase',letterSpacing:'0.5px'}}>Registrations</div>
                  <div style={{fontSize:28,fontWeight:800,color:'var(--text-2)'}}>{preview.total}</div></div>
                <div><div style={{fontSize:10,color:'var(--text-3)',textTransform:'uppercase',letterSpacing:'0.5px'}}>Unique Emails (all players)</div>
                  <div style={{fontSize:28,fontWeight:800,color:'var(--accent-light)'}}>{preview.uniqueEmails ?? preview.withEmail}</div>
                  <div style={{fontSize:9,color:'var(--text-5)'}}>1 row per email in CSV</div></div>
              </div>
              {preview.graduationYear?.length>0&&(
                <ResponsiveContainer width="100%" height={100}>
                  <BarChart data={preview.graduationYear} margin={{top:4,right:4,left:0,bottom:16}}>
                    <XAxis dataKey="name" tick={{fill:'var(--text-3)',fontSize:9}} angle={-30} textAnchor="end" interval={0}/>
                    <Tooltip content={<Tip/>}/>
                    <Bar dataKey="count" name="Contacts" fill="#3b82f6" radius={[2,2,0,0]}/>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          )}

          <div style={{display:'flex',gap:8}}>
            <button onClick={()=>setStep(1)} style={{padding:'10px 20px',background:'var(--surface-1)',color:'var(--text-2)',border:'1px solid var(--line)',borderRadius:8,cursor:'pointer',fontWeight:600,fontSize:13}}>← Back</button>
            <button onClick={()=>setStep(3)} style={{padding:'10px 28px',background:'#2563eb',color:'#fff',border:'none',borderRadius:8,cursor:'pointer',fontWeight:700,fontSize:13}}>Next: Gender →</button>
          </div>
        </div>
      )}

      {/* ── Step 3: Gender + Export ──────────────────────────────── */}
      {step===3 && (
        <div>
          <p style={{fontSize:12,color:'var(--text-2)',marginBottom:14}}>Select genders to include. Leave all unchecked for all genders.</p>

          <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:16}}>
            {genderOptions.map((g,i)=>{
              const sel = selGenders.has(g);
              return (
                <label key={g} onClick={()=>setSelGenders(prev=>{const n=new Set(prev);sel?n.delete(g):n.add(g);return n;})}
                  style={{display:'flex',alignItems:'center',gap:8,padding:'10px 18px',
                    background:sel?`${PIE_COLORS[i%PIE_COLORS.length]}22`:'var(--surface-2)',
                    border:`1px solid ${sel?PIE_COLORS[i%PIE_COLORS.length]:'var(--line)'}`,
                    borderRadius:10,cursor:'pointer',transition:'all 0.12s'}}>
                  <div style={{width:16,height:16,borderRadius:4,border:`2px solid ${sel?PIE_COLORS[i%PIE_COLORS.length]:'var(--text-5)'}`,
                    background:sel?PIE_COLORS[i%PIE_COLORS.length]:'transparent',display:'flex',alignItems:'center',justifyContent:'center'}}>
                    {sel&&<span style={{color:'#fff',fontSize:10,fontWeight:800}}>✓</span>}
                  </div>
                  <span style={{fontSize:13,fontWeight:700,color:sel?PIE_COLORS[i%PIE_COLORS.length]:'var(--text-3)'}}>{g}</span>
                </label>
              );
            })}
          </div>
          {selGenders.size===0&&<p style={{fontSize:11,color:'var(--text-4)',marginBottom:12}}>All genders included (none selected = all).</p>}

          {/* Final preview */}
          {!previewing && preview && (
            <div style={{background:'var(--surface-3)',border:'1px solid var(--line)',borderRadius:10,padding:'14px 16px',marginBottom:16}}>
              <div style={{display:'flex',gap:20,flexWrap:'wrap',marginBottom:preview.gender?.length>0?12:0}}>
                <div>
                  <div style={{fontSize:10,color:'var(--text-3)',textTransform:'uppercase',letterSpacing:'0.5px'}}>Registrations</div>
                  <div style={{fontSize:32,fontWeight:800,color:'var(--text-2)',letterSpacing:'-1px'}}>{preview.total}</div>
                  <div style={{fontSize:11,color:'var(--text-4)'}}>team sign-ups</div>
                </div>
                <div>
                  <div style={{fontSize:10,color:'var(--text-3)',textTransform:'uppercase',letterSpacing:'0.5px'}}>CSV Rows (all player emails)</div>
                  <div style={{fontSize:32,fontWeight:800,color:'#22c55e',letterSpacing:'-1px'}}>{preview.uniqueEmails ?? preview.withEmail}</div>
                  <div style={{fontSize:11,color:'var(--text-4)'}}>one row per unique email</div>
                </div>
                {preview.gender?.map((g,i)=>(
                  <div key={g.name}>
                    <div style={{fontSize:10,color:'var(--text-3)',textTransform:'uppercase',letterSpacing:'0.5px'}}>{g.name}</div>
                    <div style={{fontSize:24,fontWeight:700,color:PIE_COLORS[i%PIE_COLORS.length]}}>{g.count}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* File label */}
          <div style={{marginBottom:16}}>
            <label style={{display:'block',fontSize:10,color:'var(--text-3)',marginBottom:5,fontWeight:600,textTransform:'uppercase'}}>
              File Label (optional)
            </label>
            <input type="text" value={label} onChange={e=>setLabel(e.target.value)}
              placeholder={buildLabel()}
              style={{background:'var(--surface-2)',border:'1px solid var(--line)',color:'var(--text-1)',borderRadius:8,padding:'8px 14px',fontSize:13,width:'100%',outline:'none',boxSizing:'border-box'}}/>
          </div>

          <div style={{display:'flex',gap:8}}>
            <button onClick={()=>setStep(2)} style={{padding:'10px 20px',background:'var(--surface-1)',color:'var(--text-2)',border:'1px solid var(--line)',borderRadius:8,cursor:'pointer',fontWeight:600,fontSize:13}}>← Back</button>
            <button onClick={downloadCSV} disabled={!preview||preview.total===0}
              style={{padding:'12px 32px',background:'#22c55e',color:'var(--surface-3)',border:'none',borderRadius:8,cursor:'pointer',fontWeight:800,fontSize:14,flex:1,
                opacity:!preview||preview.total===0?0.4:1}}>
              ⬇ Download FB Audience CSV ({preview?.uniqueEmails ?? preview?.withEmail ?? 0} emails)
            </button>
          </div>
          <p style={{margin:'10px 0 0',fontSize:10,color:'var(--text-5)'}}>
            Instant download from stored contacts — no API call needed.
            Columns: email, phone, fn, ln, zip, city, state, country, gender, grad_years, league.
          </p>
        </div>
      )}
    </div>
  );
}

// ── Lapsed Contacts ───────────────────────────────────────────────────────────
function LapsedContactsPanel({ recentRegs }) {
  const curYear = new Date().getFullYear().toString();
  const years   = [...new Set(
    recentRegs.map(r => (r.close || r.open || '').slice(0,4)).filter(y => /^20\d{2}$/.test(y))
  )].sort().reverse();

  // Source side
  const [sourceMode,    setSourceMode]    = useState('year');
  const [sourceYear,    setSourceYear]    = useState(years[1] || '');
  const [customLeagues, setCustomLeagues] = useState([]);

  // Exclude side
  const [excludeMode,    setExcludeMode]    = useState('year');  // 'year' | 'league'
  const [excludeYear,    setExcludeYear]    = useState(curYear);
  const [excludeLeagues, setExcludeLeagues] = useState([]);       // [{id, name}]

  // Grad year filter (applied client-side to results)
  const [gyFrom, setGyFrom] = useState('');
  const [gyTo,   setGyTo]   = useState('');

  const [data,      setData]      = useState(null);
  const [loading,   setLoading]   = useState(false);
  const [showTable, setShowTable] = useState(false);

  const canRun = (sourceMode === 'year' ? !!sourceYear : customLeagues.length > 0) &&
                 (excludeMode === 'year' ? !!excludeYear : excludeLeagues.length > 0);

  const run = useCallback(async () => {
    if (!canRun) { toast.error('Select source and exclude first'); return; }
    setLoading(true); setData(null); setShowTable(false);
    try {
      const sourceEventIds = sourceMode === 'custom'
        ? customLeagues.map(l => String(l.id)).join(',') : undefined;
      const sy = sourceMode === 'year' ? sourceYear : undefined;
      const excludeEventIds = excludeMode === 'league'
        ? excludeLeagues.map(l => String(l.id)).join(',') : undefined;
      const ey = excludeMode === 'year' ? excludeYear : undefined;
      const res = await api.reportLapsedIndividuals(sy, ey, sourceEventIds, excludeEventIds);
      setData(res.data);
    } catch (err) { toast.error('Failed: ' + err.message); }
    finally { setLoading(false); }
  }, [sourceMode, sourceYear, customLeagues, excludeMode, excludeYear, excludeLeagues, canRun]);

  // ── Grad-year filtered lapsed list ────────────────────────────────────────────
  const filteredLapsed = useMemo(() => {
    if (!data) return [];
    return data.lapsed.filter(p => {
      if (!gyFrom && !gyTo) return true;
      const gys = p.gradYears || [];
      if (!gys.length) return false; // no grad year info — exclude when filtering
      return gys.some(y => {
        if (gyFrom && y < gyFrom) return false;
        if (gyTo   && y > gyTo)   return false;
        return true;
      });
    });
  }, [data, gyFrom, gyTo]);

  // ── Grad-year breakdown (of full unfiltered lapsed) ────────────────────────────
  const gyBreakdown = data?.gradYearBreakdown || [];

  function copyEmails() {
    const emails = filteredLapsed.map(p => p.email).filter(Boolean);
    if (!emails.length) { toast.error('No emails'); return; }
    navigator.clipboard.writeText(emails.join('\n'));
    toast.success(`${emails.length} emails copied`);
  }
  function copyPhones() {
    const phones = [...new Set(filteredLapsed.flatMap(p => p.phones || []))];
    if (!phones.length) { toast.error('No phones'); return; }
    navigator.clipboard.writeText(phones.join('\n'));
    toast.success(`${phones.length} phones copied`);
  }
  function downloadCSV() {
    const srcLabel    = sourceMode === 'year' ? sourceYear : `${customLeagues.length}leagues`;
    const exclLabel   = excludeMode === 'year' ? excludeYear : `${excludeLeagues.length}excl-leagues`;
    const gyLabel     = gyFrom || gyTo ? `-gy${gyFrom||''}to${gyTo||(new Date().getFullYear()+10)}` : '';
    const hdr  = 'Name,Email,Phones,Grad Years,Source Leagues';
    const rows = filteredLapsed.map(p => [
      `"${(p.name||'').replace(/"/g,'""')}"`,
      `"${(p.email||'').replace(/"/g,'""')}"`,
      `"${(p.phones||[]).join('; ').replace(/"/g,'""')}"`,
      `"${(p.gradYears||[]).join('; ').replace(/"/g,'""')}"`,
      `"${(p.sourceLeagues||[]).join('; ').replace(/"/g,'""')}"`,
    ].join(','));
    const blob = new Blob([hdr + '\n' + rows.join('\n')], { type:'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `lapsed-${srcLabel}-not-${exclLabel}${gyLabel}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  const lapsedPct = data ? Math.round(data.lapsedCount / (data.totalIndividuals || 1) * 100) : 0;

  const availableSrcLeagues  = recentRegs.filter(r => !customLeagues.find(l => String(l.id) === String(r.id)));
  const availableExclLeagues = recentRegs.filter(r => !excludeLeagues.find(l => String(l.id) === String(r.id)));

  // ── Small chip-list helper ─────────────────────────────────────────────────────
  function LeagueChips({ items, onRemove }) {
    return (
      <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginTop:8 }}>
        {items.map(l => (
          <div key={l.id} style={{ display:'flex', alignItems:'center', gap:5, background:'var(--surface-1)',
            border:'1px solid var(--line)', borderRadius:20, padding:'4px 10px 4px 12px', fontSize:11 }}>
            <span style={{ color:'#cbd5e1', maxWidth:200, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{l.name}</span>
            <button onClick={() => onRemove(l.id)}
              style={{ background:'none', border:'none', color:'var(--text-4)', cursor:'pointer', fontSize:14, lineHeight:1, padding:'0 2px' }}>×</button>
          </div>
        ))}
        {items.length === 0 && <p style={{ color:'var(--text-5)', fontSize:11, margin:0 }}>No leagues selected yet.</p>}
      </div>
    );
  }

  return (
    <div className="card" style={{ marginTop: 24 }}>
      <h2 style={{ margin: '0 0 4px' }}>Lapsed Contacts</h2>
      <p style={{ color:'var(--text-4)', fontSize:12, margin:'0 0 16px', lineHeight:1.6 }}>
        Find every individual player from past leagues who did <strong style={{color:'var(--text-2)'}}>not</strong> sign up
        for the exclude target (year or specific league). All player emails — not just primary contacts.
        Deduplicated. Filter by grad year to focus on current players.
      </p>

      {/* ── Two-column: Source | Exclude ─────────────────────────────────────── */}
      <div className="grid-2" style={{ gap:16, marginBottom:16 }}>

        {/* SOURCE */}
        <div style={{ background:'var(--surface-3)', borderRadius:10, padding:'12px 14px', border:'1px solid var(--surface-1)' }}>
          <div style={{ fontSize:10, color:'var(--text-4)', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:8 }}>
            📥 Source — who to look up
          </div>
          <div style={{ display:'flex', gap:6, marginBottom:10 }}>
            {[{id:'year',label:'By Year'},{id:'custom',label:'Pick Leagues'}].map(m => (
              <button key={m.id} onClick={() => { setSourceMode(m.id); setData(null); }}
                style={{ padding:'5px 14px', borderRadius:7, fontSize:11, fontWeight:700, border:'none', cursor:'pointer',
                  background: sourceMode===m.id ? 'var(--chip-bg)':'var(--surface-1)',
                  color:      sourceMode===m.id ? 'var(--accent-light)':'var(--text-3)',
                  outline:    sourceMode===m.id ? '1px solid #2563eb':'none' }}>
                {m.label}
              </button>
            ))}
          </div>
          {sourceMode === 'year' ? (
            <>
              <label style={{ display:'block', fontSize:10, color:'var(--text-3)', marginBottom:5, fontWeight:600, textTransform:'uppercase' }}>Source Year</label>
              <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                {years.map(y => (
                  <button key={y} onClick={() => { setSourceYear(y); setData(null); }}
                    style={{ padding:'6px 14px', borderRadius:7, fontSize:12, fontWeight:700, border:'none', cursor:'pointer',
                      background: sourceYear===y ? '#2563eb':'var(--surface-1)', color: sourceYear===y ? '#fff':'var(--text-3)' }}>
                    {y}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <label style={{ display:'block', fontSize:10, color:'var(--text-3)', marginBottom:5, fontWeight:600, textTransform:'uppercase' }}>Add Source Leagues</label>
              <SearchableSelect
                value=""
                onChange={id => {
                  const r = recentRegs.find(x => String(x.id) === String(id));
                  if (r && !customLeagues.find(l => String(l.id) === String(r.id))) {
                    setCustomLeagues(prev => [...prev, { id: r.id, name: r.name }]);
                    setData(null);
                  }
                }}
                options={availableSrcLeagues.map(r => ({ value: String(r.id), label: r.name }))}
                placeholder="Search and add leagues…"
              />
              <LeagueChips items={customLeagues} onRemove={id => { setCustomLeagues(prev => prev.filter(x => String(x.id) !== String(id))); setData(null); }} />
            </>
          )}
        </div>

        {/* EXCLUDE */}
        <div style={{ background:'var(--surface-3)', borderRadius:10, padding:'12px 14px', border:'1px solid var(--surface-1)' }}>
          <div style={{ fontSize:10, color:'var(--text-4)', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:8 }}>
            🚫 Exclude — already signed up here
          </div>
          <div style={{ display:'flex', gap:6, marginBottom:10 }}>
            {[{id:'year',label:'By Year'},{id:'league',label:'Specific League'}].map(m => (
              <button key={m.id} onClick={() => { setExcludeMode(m.id); setData(null); }}
                style={{ padding:'5px 14px', borderRadius:7, fontSize:11, fontWeight:700, border:'none', cursor:'pointer',
                  background: excludeMode===m.id ? '#3b1f5e':'var(--surface-1)',
                  color:      excludeMode===m.id ? '#c084fc':'var(--text-3)',
                  outline:    excludeMode===m.id ? '1px solid #7c3aed':'none' }}>
                {m.label}
              </button>
            ))}
          </div>
          {excludeMode === 'year' ? (
            <>
              <label style={{ display:'block', fontSize:10, color:'var(--text-3)', marginBottom:5, fontWeight:600, textTransform:'uppercase' }}>Exclude Year</label>
              <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                {years.map(y => (
                  <button key={y} onClick={() => { setExcludeYear(y); setData(null); }}
                    style={{ padding:'6px 14px', borderRadius:7, fontSize:12, fontWeight:700, border:'none', cursor:'pointer',
                      background: excludeYear===y ? '#7c3aed':'var(--surface-1)', color: excludeYear===y ? '#fff':'var(--text-3)' }}>
                    {y}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <label style={{ display:'block', fontSize:10, color:'var(--text-3)', marginBottom:5, fontWeight:600, textTransform:'uppercase' }}>Add Exclude Leagues</label>
              <SearchableSelect
                value=""
                onChange={id => {
                  const r = recentRegs.find(x => String(x.id) === String(id));
                  if (r && !excludeLeagues.find(l => String(l.id) === String(r.id))) {
                    setExcludeLeagues(prev => [...prev, { id: r.id, name: r.name }]);
                    setData(null);
                  }
                }}
                options={availableExclLeagues.map(r => ({ value: String(r.id), label: r.name }))}
                placeholder="Search and add leagues…"
              />
              <LeagueChips items={excludeLeagues} onRemove={id => { setExcludeLeagues(prev => prev.filter(x => String(x.id) !== String(id))); setData(null); }} />
            </>
          )}
        </div>
      </div>

      {/* Run button */}
      <button onClick={run} disabled={!canRun || loading}
        style={{ padding:'10px 28px', borderRadius:8, fontSize:13, fontWeight:700, border:'none',
          cursor: canRun && !loading ? 'pointer':'not-allowed',
          background: canRun ? '#2563eb':'var(--surface-1)', color: canRun ? '#fff':'var(--text-3)',
          opacity: loading ? 0.6:1, marginBottom:16 }}>
        {loading ? 'Analyzing…' : '▶ Find Lapsed'}
      </button>

      {data && (
        <>
          {/* Stats row */}
          <div style={{ display:'flex', gap:10, flexWrap:'wrap', marginBottom:12 }}>
            {[
              { label:'Total unique individuals', val: data.totalIndividuals, color:'var(--text-2)', sub:'from source leagues, deduplicated' },
              { label:`Already in ${data.excludeLabel}`, val: data.totalIndividuals - data.lapsedCount, color:'#22c55e', sub:`${100-lapsedPct}% retained` },
              { label:`Lapsed — not in ${data.excludeLabel}`, val: data.lapsedCount, color:'#ef4444', sub:`${lapsedPct}% lapsed` },
            ].map(s => (
              <div key={s.label} style={{ background:'var(--surface-1)', borderRadius:8, padding:'8px 14px', minWidth:110 }}>
                <div style={{ fontSize:9, color:'var(--text-4)', textTransform:'uppercase', letterSpacing:'0.5px' }}>{s.label}</div>
                <div style={{ fontSize:24, fontWeight:800, color:s.color }}>{s.val}</div>
                {s.sub && <div style={{ fontSize:9, color:'var(--text-5)' }}>{s.sub}</div>}
              </div>
            ))}
          </div>

          {/* Grad Year Breakdown */}
          {gyBreakdown.length > 0 && (
            <div style={{ marginBottom:14 }}>
              <div style={{ fontSize:10, color:'var(--text-3)', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:6 }}>
                Grad Year Breakdown (lapsed)
              </div>
              <div style={{ display:'flex', gap:6, flexWrap:'wrap' }}>
                {gyBreakdown.map(({ year, count }) => (
                  <div key={year} style={{ background:'var(--surface-1)', borderRadius:6, padding:'4px 10px', fontSize:11, cursor:'pointer',
                    border: (gyFrom===year || gyTo===year) ? '1px solid var(--accent-light)':'1px solid transparent' }}
                    title={`${count} lapsed from grad year ${year}`}
                    onClick={() => {
                      if (!gyFrom || gyFrom > year) setGyFrom(year);
                      if (!gyTo   || gyTo   < year) setGyTo(year);
                    }}>
                    <span style={{ color:'var(--text-2)', fontWeight:700 }}>{year}</span>
                    <span style={{ color:'var(--text-4)', marginLeft:5 }}>{count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Grad Year range filter */}
          {data.lapsedCount > 0 && (
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12, flexWrap:'wrap' }}>
              <span style={{ fontSize:10, color:'var(--text-3)', fontWeight:700, textTransform:'uppercase' }}>Filter by grad year:</span>
              <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                <input
                  type="number" min="2020" max="2040" placeholder="From"
                  value={gyFrom} onChange={e => setGyFrom(e.target.value)}
                  style={{ width:72, background:'var(--surface-1)', border:'1px solid var(--line)', color:'var(--text-1)', borderRadius:6, padding:'5px 8px', fontSize:12, outline:'none' }}
                />
                <span style={{ color:'var(--text-4)', fontSize:11 }}>–</span>
                <input
                  type="number" min="2020" max="2040" placeholder="To"
                  value={gyTo} onChange={e => setGyTo(e.target.value)}
                  style={{ width:72, background:'var(--surface-1)', border:'1px solid var(--line)', color:'var(--text-1)', borderRadius:6, padding:'5px 8px', fontSize:12, outline:'none' }}
                />
                {(gyFrom || gyTo) && (
                  <button onClick={() => { setGyFrom(''); setGyTo(''); }}
                    style={{ fontSize:11, background:'none', border:'none', color:'var(--text-4)', cursor:'pointer', padding:'2px 6px' }}>
                    ✕ clear
                  </button>
                )}
              </div>
              {(gyFrom || gyTo) && (
                <span style={{ fontSize:11, color:'var(--accent-light)' }}>
                  Showing {filteredLapsed.length} of {data.lapsedCount} lapsed
                </span>
              )}
            </div>
          )}

          {/* Action bar */}
          {filteredLapsed.length > 0 && (
            <>
              <div style={{ display:'flex', gap:8, flexWrap:'wrap', marginBottom:10 }}>
                <button onClick={copyEmails}
                  style={{ padding:'6px 14px', borderRadius:6, fontSize:11, fontWeight:700, border:'none', cursor:'pointer', background:'var(--chip-bg)', color:'var(--accent-light)' }}>
                  Copy {filteredLapsed.filter(p=>p.email).length} Emails
                </button>
                <button onClick={copyPhones}
                  style={{ padding:'6px 14px', borderRadius:6, fontSize:11, fontWeight:700, border:'none', cursor:'pointer', background:'var(--chip-bg)', color:'var(--accent-green)' }}>
                  Copy {[...new Set(filteredLapsed.flatMap(p=>p.phones||[]))].length} Phones
                </button>
                <button onClick={downloadCSV}
                  style={{ padding:'6px 14px', borderRadius:6, fontSize:11, fontWeight:700, border:'none', cursor:'pointer', background:'var(--surface-3)', color:'var(--text-2)' }}>
                  ⬇ CSV (Name, Email, Phone, Grad Year)
                </button>
                <button onClick={() => setShowTable(s => !s)}
                  style={{ padding:'6px 14px', borderRadius:6, fontSize:11, fontWeight:700, border:'none', cursor:'pointer', background:'var(--surface-1)', color:'var(--text-3)' }}>
                  {showTable ? '▲ Hide' : `▼ Show ${filteredLapsed.length} participants`}
                </button>
              </div>

              {showTable && (
                <div style={{ overflowX:'auto', maxHeight:420, overflowY:'auto' }}>
                  <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
                    <thead>
                      <tr style={{ borderBottom:'1px solid var(--surface-1)', position:'sticky', top:0, background:'var(--surface-3)' }}>
                        {['Name','Email','Phone(s)','Grad Year(s)','Source League(s)'].map(h => (
                          <th key={h} style={{ textAlign:'left', padding:'6px 10px', color:'var(--text-3)', fontSize:10, textTransform:'uppercase', whiteSpace:'nowrap' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredLapsed.map((p, i) => (
                        <tr key={i} style={{ borderBottom:'1px solid var(--surface-3)', background: i%2===0?'transparent':'var(--surface-3)' }}>
                          <td style={{ padding:'5px 10px', color:'var(--text-1)', whiteSpace:'nowrap' }}>{p.name || <span style={{color:'var(--text-5)'}}>—</span>}</td>
                          <td style={{ padding:'5px 10px', maxWidth:220 }}>
                            <a href={`mailto:${p.email}`} style={{ color:'var(--accent-light)', textDecoration:'none', fontSize:11 }}>{p.email}</a>
                          </td>
                          <td style={{ padding:'5px 10px' }}>
                            {(p.phones||[]).length > 0
                              ? (p.phones||[]).map((ph,pi) => (
                                  <div key={pi}><a href={`tel:${ph}`} style={{ color:'var(--accent-green)', textDecoration:'none' }}>{fmt10(ph)}</a></div>
                                ))
                              : <span style={{color:'var(--text-5)'}}>—</span>
                            }
                          </td>
                          <td style={{ padding:'5px 10px' }}>
                            {(p.gradYears||[]).length > 0
                              ? (p.gradYears||[]).map((gy, gi) => (
                                  <span key={gi} style={{ display:'inline-block', background:'var(--surface-1)', borderRadius:4,
                                    padding:'1px 6px', marginRight:3, fontSize:10, color:'#a78bfa', fontWeight:700 }}>
                                    {gy}
                                  </span>
                                ))
                              : <span style={{color:'var(--text-5)'}}>—</span>
                            }
                          </td>
                          <td style={{ padding:'5px 10px', color:'var(--text-3)', fontSize:10 }}>
                            {(p.sourceLeagues||[]).join(', ') || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          {data.lapsedCount === 0 && (
            <p style={{ color:'#22c55e', fontSize:13 }}>Everyone already signed up — no lapsed contacts found!</p>
          )}
        </>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Audiences({ ctx }) {
  const { recentRegs = [] } = ctx;
  const [cStatus, setCStatus] = useState(null);

  async function loadCStatus() {
    try { const r = await api.contactsStatus(); setCStatus(r.data); } catch {}
  }

  useEffect(()=>{ loadCStatus(); }, []);

  return (
    <div>
      <div className="page-header">
        <h1>FB Audiences</h1>
        <p>Store registrant contact details locally, then build targeted Facebook Custom Audience exports — no repeated API calls.</p>
      </div>

      <div className="grid-2" style={{ gap:24, alignItems:'start' }}>
        {/* Left: Contact Store */}
        <div className="card" style={{ position:'sticky', top:20 }}>
          <ContactStorePanel
            recentRegs={recentRegs}
            onStoreUpdated={loadCStatus}
          />
        </div>

        {/* Right: Audience Builder */}
        <div className="card">
          <AudienceBuilder
            recentRegs={recentRegs}
            contactStatus={cStatus}
          />
        </div>
      </div>

      {/* Lapsed Contacts — full width below */}
      <LapsedContactsPanel recentRegs={recentRegs} />
    </div>
  );
}
