/**
 * Per-league analytics panel with:
 *  - Grad year + gender charts
 *  - 3-step FB Audience export (year range → gender → live terminal → download)
 *  - Export history (all past exports for this league, with distribution preview)
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  PieChart, Pie, Cell, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { api } from '../api.jsx';
import { useAuth } from '../AuthContext.jsx';
import { toast } from 'react-hot-toast';

const PIE_COLORS = ['#3b82f6','#f97316','#22c55e','#a855f7','#ec4899','#14b8a6','#eab308','#06b6d4'];
const BUCKET_COLOR = {
  'K–2  (ages 5–8)'   : 'var(--accent-light)',
  '3–5  (ages 8–11)'  : 'var(--accent-green)',
  '6–8  (ages 11–14)' : '#f97316',
  '9–12 (ages 14–18)' : '#a855f7',
};
const LOG_COLOR = { info:'var(--text-3)', ok:'#22c55e', error:'#ef4444', warn:'#f97316', response:'#a78bfa' };

// ── Tooltip ───────────────────────────────────────────────────────────────────
const Tip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background:'var(--surface-3)', border:'1px solid var(--line)', borderRadius:8, padding:'8px 12px' }}>
      {label && <p style={{ color:'var(--text-2)', fontSize:11, marginBottom:3 }}>{label}</p>}
      {payload.map((p,i) => (
        <p key={i} style={{ color:p.color||'var(--accent-light)', fontSize:13, fontWeight:700, margin:'2px 0' }}>{p.name}: {p.value}</p>
      ))}
    </div>
  );
};
const PieTip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const p = payload[0]; const tot = p.payload.total||1;
  return (
    <div style={{ background:'var(--surface-3)', border:'1px solid var(--line)', borderRadius:8, padding:'8px 12px' }}>
      <p style={{ color:p.fill, fontSize:13, fontWeight:700, margin:0 }}>
        {p.name}: {p.value} ({((p.value/tot)*100).toFixed(1)}%)
      </p>
    </div>
  );
};
function withTotal(arr) {
  const t = arr.reduce((s,a)=>s+a.count,0);
  return arr.map(a=>({...a,total:t}));
}

// ── Grade bucket stacked bar ──────────────────────────────────────────────────
function BucketBar({ buckets }) {
  const tot = buckets.reduce((s,b)=>s+b.count,0)||1;
  return (
    <div>
      <div style={{ display:'flex', height:20, borderRadius:6, overflow:'hidden', marginBottom:8, boxShadow:'0 2px 6px rgba(0,0,0,0.3)' }}>
        {buckets.map((b,i) => (
          <div key={b.name} title={`${b.name}: ${b.count} (${Math.round(b.count/tot*100)}%)`}
            style={{ flex:b.count, background:BUCKET_COLOR[b.name]||PIE_COLORS[i], minWidth:2 }}/>
        ))}
      </div>
      <div style={{ display:'flex', gap:12, flexWrap:'wrap' }}>
        {buckets.map((b,i) => (
          <div key={b.name} style={{ display:'flex', alignItems:'center', gap:5, fontSize:11, color:'var(--text-2)' }}>
            <div style={{ width:9,height:9,borderRadius:2,background:BUCKET_COLOR[b.name]||PIE_COLORS[i],flexShrink:0 }}/>
            {b.name} — <span style={{color:'var(--text-1)',fontWeight:700}}>{b.count}</span>
            <span style={{color:'var(--text-4)'}}>({Math.round(b.count/tot*100)}%)</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── SSE Export Terminal ───────────────────────────────────────────────────────
function ExportTerminal({ streamUrl, onComplete, onClose }) {
  const [logs,   setLogs]   = useState([]);
  const [status, setStatus] = useState('connecting');
  const [result, setResult] = useState(null);
  const bottomRef = useRef(null);
  const doneRef   = useRef(false);

  useEffect(() => {
    const es = new EventSource(streamUrl);
    es.addEventListener('log', e => {
      setLogs(prev => [...prev, JSON.parse(e.data)]);
      setStatus('running');
    });
    es.addEventListener('complete', e => {
      doneRef.current = true;
      const d = JSON.parse(e.data);
      setResult(d); setStatus('done'); es.close();
      if (onComplete) onComplete(d);
    });
    es.addEventListener('error', e => {
      doneRef.current = true;
      try { const d = JSON.parse(e.data); setLogs(p=>[...p,{ts:'',msg:'✗ '+d.message,level:'error'}]); } catch {}
      setStatus('error'); es.close();
    });
    es.onerror = () => {
      if (doneRef.current) return;
      setTimeout(() => {
        if (doneRef.current) return;
        setLogs(p=>[...p,{ts:'',msg:'Connection lost.',level:'error'}]);
        setStatus('error'); es.close();
      }, 200);
    };
    return () => es.close();
  }, [streamUrl]);

  useEffect(() => { bottomRef.current?.scrollIntoView({behavior:'smooth'}); }, [logs]);

  const statusColor = status==='done'?'#22c55e':status==='error'?'#ef4444':status==='connecting'?'#f97316':'#3b82f6';

  return (
    <div style={{ background:'#080a0f', border:'1px solid var(--surface-1)', borderRadius:10, overflow:'hidden', fontFamily:'monospace' }}>
      {/* Title bar */}
      <div style={{ background:'var(--surface-3)', borderBottom:'1px solid var(--surface-1)', padding:'7px 14px', display:'flex', alignItems:'center', gap:10 }}>
        <div style={{ display:'flex', gap:4 }}>
          {['#ef4444','#f97316','#22c55e'].map(c=><div key={c} style={{width:10,height:10,borderRadius:'50%',background:c}}/>)}
        </div>
        <span style={{ color:'var(--text-4)', fontSize:11, flex:1 }}>FB Audience Export — fetching from SportsEngine</span>
        <span style={{ color:statusColor, fontSize:11, fontWeight:700 }}>
          {status==='done'?'DONE':status==='error'?'ERROR':status==='connecting'?'CONNECTING':'FETCHING'}
        </span>
        {status!=='running' && (
          <button onClick={onClose} style={{background:'none',border:'none',color:'var(--text-4)',cursor:'pointer',fontSize:14}}>✕</button>
        )}
      </div>

      {/* Logs */}
      <div style={{ padding:'10px 14px', maxHeight:200, overflowY:'auto', fontSize:11, lineHeight:1.7 }}>
        {logs.map((l,i) => (
          <div key={i} style={{ display:'flex', gap:8 }}>
            <span style={{ color:'#1e3a5f', flexShrink:0, minWidth:52 }}>{l.ts}</span>
            <span style={{ color:LOG_COLOR[l.level]||'var(--text-3)', whiteSpace:'pre-wrap', wordBreak:'break-all' }}>{l.msg}</span>
          </div>
        ))}
        {status==='running' && (
          <div style={{ display:'flex', gap:8 }}>
            <span style={{ color:'#1e3a5f', minWidth:52 }}/>
            <span style={{ color:'#22c55e', animation:'blink 1s step-end infinite' }}>█</span>
          </div>
        )}
        <div ref={bottomRef}/>
      </div>

      {/* Download bar */}
      {status==='done' && result && (
        <div style={{ borderTop:'1px solid var(--surface-1)', background:'rgba(34,197,94,0.1)', padding:'10px 14px',
          display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, flexWrap:'wrap' }}>
          <span style={{ fontSize:12, color:'var(--text-3)' }}>
            <span style={{ color:'#22c55e', fontWeight:700 }}>{result.rowCount}</span> rows · {result.filename}
          </span>
          <button onClick={() => { window.location.href = api.leagueCsvDownloadUrl(result.token); }}
            style={{ padding:'8px 20px', background:'#22c55e', color:'var(--surface-3)',
              border:'none', borderRadius:8, cursor:'pointer', fontWeight:800, fontSize:13 }}>
            ⬇ Download CSV
          </button>
        </div>
      )}
      <style>{`@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}`}</style>
    </div>
  );
}

// ── Quick "Download All" — no year/gender filters ────────────────────────────
function QuickDownloadAll({ eventId, totalComplete, onExportSaved }) {
  const [active,     setActive]     = useState(false);
  const [terminalKey, setTerminalKey] = useState(0);

  function start() {
    setTerminalKey(k => k+1);
    setActive(true);
  }

  return (
    <div style={{ background:'rgba(34,197,94,0.12)', border:'1px solid rgba(34,197,94,0.35)', borderRadius:10, padding:'14px 16px', marginBottom:16 }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, flexWrap:'wrap', marginBottom: active ? 12 : 0 }}>
        <div>
          <div style={{ fontSize:13, fontWeight:700, color:'#22c55e' }}>⬇ Download All Registrations</div>
          <div style={{ fontSize:11, color:'var(--text-4)', marginTop:2 }}>
            All <strong style={{color:'#4ade80'}}>{totalComplete}</strong> completed teams — no year or gender filter applied
          </div>
        </div>
        {!active && (
          <button onClick={start}
            style={{ padding:'9px 22px', background:'#22c55e', color:'var(--surface-3)', border:'none', borderRadius:8, cursor:'pointer', fontWeight:800, fontSize:13 }}>
            Generate & Download All
          </button>
        )}
      </div>
      {active && (
        <ExportTerminal
          key={terminalKey}
          streamUrl={api.leagueCsvStreamUrl(eventId, [], [])}
          onComplete={() => { if (onExportSaved) onExportSaved(); }}
          onClose={() => setActive(false)}
        />
      )}
    </div>
  );
}

// ── 3-step export config panel ────────────────────────────────────────────────
function ExportConfigPanel({ detail, eventId, onExportSaved }) {
  const curYear = new Date().getFullYear();
  const allYears = (detail.graduationYear||[]).map(g=>g.name).sort();
  const allGenders = [...new Set((detail.crossTab||[]).map(r=>r.gender).filter(g=>g&&g!=='(unknown)'))].sort();

  const [step,        setStep]        = useState(1);
  const [yearFrom,    setYearFrom]    = useState(allYears[0]  || '');
  const [yearTo,      setYearTo]      = useState(allYears[allYears.length-1] || '');
  const [selGenders,  setSelGenders]  = useState(new Set(allGenders));
  const [streamUrl,   setStreamUrl]   = useState('');
  const [terminalKey, setTerminalKey] = useState(0);

  // Compute estimates from cross-tab data
  const selectedYears = allYears.filter(y => y >= yearFrom && y <= yearTo);

  // Aggregate cross-tab for selected years + genders
  const crossTab = detail.crossTab || [];

  // Per-year counts for selected range
  const yearEst = selectedYears.map(y => {
    const count = crossTab.filter(r => r.year===y && (selGenders.size===0||selGenders.has(r.gender))).reduce((s,r)=>s+r.count,0);
    return { name:y, count, grade:`Grade ${12-(parseInt(y)-curYear)}`, bucket: getBucket(y) };
  });

  // Per-gender totals for selected range
  const genderEst = {};
  for (const row of crossTab) {
    if (!selectedYears.includes(row.year)) continue;
    if (!selGenders.has(row.gender)) continue;
    genderEst[row.gender] = (genderEst[row.gender]||0)+row.count;
  }
  const genderEstArr = Object.entries(genderEst).map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count);
  const totalEst = yearEst.reduce((s,r)=>s+r.count,0);

  function getBucket(gy) {
    const g = 12-(parseInt(gy)-curYear);
    if (g<=2) return 'K–2  (ages 5–8)';
    if (g<=5) return '3–5  (ages 8–11)';
    if (g<=8) return '6–8  (ages 11–14)';
    return '9–12 (ages 14–18)';
  }

  function toggleGender(g) {
    setSelGenders(prev => {
      const n = new Set(prev);
      if (n.has(g)) n.delete(g); else n.add(g);
      return n;
    });
  }

  function startDownload() {
    const years   = selectedYears;
    const genders = [...selGenders];
    const url     = api.leagueCsvStreamUrl(eventId, years, genders);
    setStreamUrl(url);
    setTerminalKey(k=>k+1);
    setStep(3);
  }

  function handleTerminalComplete(result) {
    if (onExportSaved) onExportSaved();
  }

  const stepStyle = (n) => ({
    display:'flex', alignItems:'center', gap:8, marginBottom:6,
    color: step===n?'var(--accent-light)':step>n?'#22c55e':'var(--text-4)',
    fontWeight:600, fontSize:13,
  });

  return (
    <div style={{ background:'#0b0e16', border:'1px solid var(--line)', borderRadius:12, padding:20 }}>
      <p style={{ margin:'0 0 16px', fontSize:13, fontWeight:700, color:'var(--accent-light)' }}>
        📤 Facebook Audience CSV — Export Builder
      </p>

      {/* Step indicators */}
      <div style={{ display:'flex', gap:0, marginBottom:20 }}>
        {[
          { n:1, label:'Grad Year Range' },
          { n:2, label:'Gender' },
          { n:3, label:'Generate & Download' },
        ].map(({n,label}, i) => (
          <React.Fragment key={n}>
            <div style={{
              display:'flex', alignItems:'center', gap:6, fontSize:11, fontWeight:700,
              color: step===n?'var(--accent-light)':step>n?'#22c55e':'var(--text-4)',
              cursor: step>n?'pointer':'default',
            }} onClick={() => step>n && setStep(n)}>
              <div style={{
                width:22,height:22,borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,fontWeight:800,
                background:step===n?'var(--chip-bg)':step>n?'#14532d':'var(--surface-1)',
                border:`1px solid ${step===n?'#3b82f6':step>n?'#22c55e':'var(--text-5)'}`,
                color:step===n?'var(--accent-light)':step>n?'#4ade80':'var(--text-4)',
              }}>{step>n?'✓':n}</div>
              <span style={{display:i>0&&'none'||undefined}}>{label}</span>
              {i<2 && <span style={{display:'none'}}>→</span>}
            </div>
            {i<2 && <div style={{flex:1,height:1,background:step>n?'#22c55e':'var(--text-5)',margin:'11px 8px 0'}}/>}
          </React.Fragment>
        ))}
      </div>

      {/* ── STEP 1: Year range ─────────────────────────────────────── */}
      {step===1 && (
        <div>
          <p style={{ margin:'0 0 14px', fontSize:12, color:'var(--text-2)' }}>
            Select the graduation year range for your audience. Estimated counts come from your stored data.
          </p>

          <div style={{ display:'flex', gap:16, marginBottom:20, flexWrap:'wrap' }}>
            <div>
              <label style={{ display:'block', fontSize:10, color:'var(--text-3)', marginBottom:5, fontWeight:600, textTransform:'uppercase' }}>From Year</label>
              <select value={yearFrom} onChange={e=>{ setYearFrom(e.target.value); if(e.target.value>yearTo) setYearTo(e.target.value); }}
                style={{ background:'var(--surface-2)', border:'1px solid var(--line)', color:'var(--text-1)', borderRadius:8, padding:'8px 14px', fontSize:14, fontWeight:600, minWidth:110 }}>
                {allYears.map(y=><option key={y} value={y}>{y} (Gr {12-(parseInt(y)-curYear)})</option>)}
              </select>
            </div>
            <div>
              <label style={{ display:'block', fontSize:10, color:'var(--text-3)', marginBottom:5, fontWeight:600, textTransform:'uppercase' }}>To Year</label>
              <select value={yearTo} onChange={e=>{ setYearTo(e.target.value); if(e.target.value<yearFrom) setYearFrom(e.target.value); }}
                style={{ background:'var(--surface-2)', border:'1px solid var(--line)', color:'var(--text-1)', borderRadius:8, padding:'8px 14px', fontSize:14, fontWeight:600, minWidth:110 }}>
                {allYears.filter(y=>y>=yearFrom).map(y=><option key={y} value={y}>{y} (Gr {12-(parseInt(y)-curYear)})</option>)}
              </select>
            </div>
            <div style={{ display:'flex', alignItems:'flex-end', paddingBottom:2, gap:10 }}>
              <div style={{ background:'var(--chip-bg)', borderRadius:10, padding:'8px 18px', textAlign:'center' }}>
                <div style={{ fontSize:10, color:'var(--text-4)', textTransform:'uppercase', letterSpacing:'0.5px' }}>Teams in range</div>
                <div style={{ fontSize:26, fontWeight:800, color:'var(--accent-light)', letterSpacing:'-1px' }}>
                  {/* Count distinct teams that have at least one player in this year range */}
                  {yearEst.length === allYears.length
                    ? detail.totalComplete  // all years selected = all teams
                    : yearEst.reduce((s,r)=>s+r.count,0)}
                </div>
                <div style={{ fontSize:10, color:'var(--text-4)' }}>of {detail.totalComplete} total</div>
              </div>
            </div>
          </div>

          {/* Year breakdown */}
          {yearEst.length > 0 && (
            <div style={{ marginBottom:20 }}>
              <p style={{ margin:'0 0 8px', fontSize:10, color:'var(--text-4)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.5px' }}>
                Breakdown by year
              </p>
              <ResponsiveContainer width="100%" height={130}>
                <BarChart data={yearEst} margin={{top:4,right:4,left:0,bottom:16}}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1a1d2a"/>
                  <XAxis dataKey="name" stroke="var(--text-5)" tick={{fill:'var(--text-3)',fontSize:10}} angle={-30} textAnchor="end" interval={0}/>
                  <YAxis stroke="var(--text-5)" tick={{fill:'var(--text-3)',fontSize:10}} width={28}/>
                  <Tooltip content={<Tip/>}/>
                  <Bar dataKey="count" name="Teams" radius={[3,3,0,0]}>
                    {yearEst.map(g=><Cell key={g.name} fill={BUCKET_COLOR[g.bucket]||PIE_COLORS[0]}/>)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          <button onClick={()=>setStep(2)} disabled={selectedYears.length===0}
            style={{ padding:'10px 28px', background:'#2563eb', color:'#fff', border:'none', borderRadius:8,
              cursor:'pointer', fontWeight:700, fontSize:13, opacity:selectedYears.length===0?0.4:1 }}>
            Next: Choose Gender →
          </button>
        </div>
      )}

      {/* ── STEP 2: Gender ─────────────────────────────────────────── */}
      {step===2 && (
        <div>
          <p style={{ margin:'0 0 14px', fontSize:12, color:'var(--text-2)' }}>
            Select the gender(s) to include. Counts are estimated from stored data for the year range you chose.
          </p>

          <div style={{ marginBottom:20 }}>
            {/* Select All / None */}
            <div style={{ display:'flex', gap:8, marginBottom:12 }}>
              <button onClick={()=>setSelGenders(new Set(allGenders))}
                style={{ padding:'4px 12px', borderRadius:6, fontSize:11, fontWeight:600, border:'1px solid var(--line)', background:'var(--surface-1)', color:'var(--text-2)', cursor:'pointer' }}>
                All
              </button>
              <button onClick={()=>setSelGenders(new Set())}
                style={{ padding:'4px 12px', borderRadius:6, fontSize:11, fontWeight:600, border:'1px solid var(--line)', background:'var(--surface-1)', color:'var(--text-2)', cursor:'pointer' }}>
                None
              </button>
            </div>

            {/* Gender checkboxes */}
            {allGenders.map((g,i) => {
              const est = crossTab.filter(r=>r.gender===g&&selectedYears.includes(r.year)).reduce((s,r)=>s+r.count,0);
              const checked = selGenders.has(g);
              return (
                <label key={g} onClick={()=>toggleGender(g)}
                  style={{
                    display:'flex', alignItems:'center', gap:12, padding:'12px 16px', marginBottom:6,
                    background: checked?'var(--chip-bg-soft)':'var(--surface-2)', border:`1px solid ${checked?'#3b82f6':'var(--line)'}`,
                    borderRadius:10, cursor:'pointer', transition:'all 0.12s',
                  }}>
                  <div style={{
                    width:20,height:20,borderRadius:6,border:`2px solid ${checked?'#3b82f6':'var(--text-5)'}`,
                    background:checked?'#2563eb':'transparent', display:'flex', alignItems:'center', justifyContent:'center',
                    flexShrink:0, transition:'all 0.12s',
                  }}>
                    {checked && <span style={{color:'#fff',fontSize:12,fontWeight:800}}>✓</span>}
                  </div>
                  <span style={{ fontSize:13, fontWeight:600, color:checked?'var(--text-1)':'var(--text-3)', flex:1 }}>{g}</span>
                  <span style={{ fontSize:20, fontWeight:800, color:checked?PIE_COLORS[i%PIE_COLORS.length]:'var(--text-5)' }}>{est}</span>
                  <span style={{ fontSize:11, color:'var(--text-4)' }}>teams</span>
                </label>
              );
            })}

            {allGenders.length === 0 && (
              <p style={{ color:'var(--text-4)', fontSize:12 }}>No gender data in stored records — export will include all registrants.</p>
            )}
          </div>

          {/* Total summary */}
          <div style={{ background:'var(--surface-2)', border:'1px solid var(--line)', borderRadius:10, padding:'12px 16px', marginBottom:16, display:'flex', gap:16, flexWrap:'wrap' }}>
            <div>
              <div style={{ fontSize:10, color:'var(--text-4)', textTransform:'uppercase', letterSpacing:'0.5px' }}>Teams to export</div>
              <div style={{ fontSize:24, fontWeight:800, color:'#22c55e' }}>
                {yearEst.length === allYears.length ? detail.totalComplete : totalEst}
              </div>
              <div style={{ fontSize:10, color:'var(--text-4)' }}>
                {yearEst.length === allYears.length ? 'all teams' : 'est. matching teams'}
              </div>
            </div>
            {genderEstArr.map((g,i)=>(
              <div key={g.name}>
                <div style={{ fontSize:10, color:'var(--text-4)', textTransform:'uppercase', letterSpacing:'0.5px' }}>{g.name}</div>
                <div style={{ fontSize:20, fontWeight:700, color:PIE_COLORS[i%PIE_COLORS.length] }}>{g.count}</div>
                <div style={{ fontSize:10, color:'var(--text-4)' }}>{totalEst>0?`${Math.round(g.count/totalEst*100)}%`:''}</div>
              </div>
            ))}
          </div>

          <div style={{ display:'flex', gap:8 }}>
            <button onClick={()=>setStep(1)}
              style={{ padding:'10px 20px', background:'var(--surface-1)', color:'var(--text-2)', border:'1px solid var(--line)', borderRadius:8, cursor:'pointer', fontWeight:600, fontSize:13 }}>
              ← Back
            </button>
            <button onClick={startDownload} disabled={selGenders.size===0&&allGenders.length>0}
              style={{ padding:'10px 28px', background:'#22c55e', color:'var(--surface-3)', border:'none', borderRadius:8,
                cursor:'pointer', fontWeight:800, fontSize:13, opacity:selGenders.size===0&&allGenders.length>0?0.4:1 }}>
              Generate & Download →
            </button>
          </div>
        </div>
      )}

      {/* ── STEP 3: Terminal ───────────────────────────────────────── */}
      {step===3 && streamUrl && (
        <div>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:12 }}>
            <button onClick={()=>setStep(2)}
              style={{ padding:'6px 14px', background:'var(--surface-1)', color:'var(--text-2)', border:'1px solid var(--line)', borderRadius:8, cursor:'pointer', fontWeight:600, fontSize:12 }}>
              ← Change Filters
            </button>
            <span style={{ fontSize:12, color:'var(--text-4)' }}>
              Years: <span style={{color:'var(--accent-light)'}}>{yearFrom}–{yearTo}</span> ·
              Genders: <span style={{color:'#22c55e'}}>{selGenders.size>0?[...selGenders].join(', '):'All'}</span>
            </span>
          </div>
          <ExportTerminal
            key={terminalKey}
            streamUrl={streamUrl}
            onComplete={handleTerminalComplete}
            onClose={()=>setStep(2)}
          />
        </div>
      )}
    </div>
  );
}

// ── Export history entry ──────────────────────────────────────────────────────
function ExportHistoryEntry({ entry, onDelete, onReExport }) {
  const { isAdmin } = useAuth();
  const [open, setOpen] = useState(false);
  const curYear = new Date().getFullYear();

  return (
    <div style={{ background:'#11141e', border:'1px solid var(--line)', borderRadius:10, overflow:'hidden', marginBottom:8 }}>
      {/* Header row */}
      <div style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px', cursor:'pointer' }}
        onClick={()=>setOpen(o=>!o)}>
        <span style={{ color:'var(--text-5)', fontSize:12 }}>{open?'▼':'▶'}</span>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:12, fontWeight:600, color:'var(--text-1)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
            {entry.filename}
          </div>
          <div style={{ fontSize:11, color:'var(--text-4)', marginTop:2 }}>
            {new Date(entry.createdAt).toLocaleString()} ·{' '}
            <span style={{color:'var(--accent-light)',fontWeight:700}}>{entry.rowCount}</span> rows
          </div>
        </div>
        <div style={{ display:'flex', gap:6, flexShrink:0, alignItems:'center' }}>
          {/* Permanent download link — always available since file is on disk */}
          <a href={api.leagueCsvDownloadUrl(entry.id)}
            onClick={e => e.stopPropagation()}
            style={{ padding:'4px 12px', background:'#14532d', color:'#4ade80', border:'none', borderRadius:6, cursor:'pointer', fontSize:11, fontWeight:700, textDecoration:'none', display:'inline-block' }}>
            ⬇ Download
          </a>
          <button onClick={e=>{e.stopPropagation();onReExport(entry);}}
            style={{ padding:'4px 10px', background:'var(--chip-bg)', color:'var(--accent-light)', border:'none', borderRadius:6, cursor:'pointer', fontSize:11, fontWeight:700 }}>
            ↺ Re-fetch
          </button>
          {isAdmin && (
            <button onClick={e=>{e.stopPropagation();onDelete(entry.id);}}
              title="Delete export"
              style={{ padding:'4px 10px', background:'rgba(239,68,68,0.12)', color:'var(--danger-text)', border:'none', borderRadius:6, cursor:'pointer', fontSize:11, fontWeight:700 }}>
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Expanded detail */}
      {open && (
        <div style={{ borderTop:'1px solid var(--line)', padding:'12px 14px', background:'var(--surface-3)' }}>
          <div className="grid-2" style={{ gap:16 }}>
            {/* Grad year dist */}
            <div>
              <p style={{ margin:'0 0 8px', fontSize:10, color:'var(--text-3)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.5px' }}>Grad Year Distribution</p>
              {(entry.gradYearDist||[]).length>0
                ? <ResponsiveContainer width="100%" height={110}>
                    <BarChart data={entry.gradYearDist} margin={{top:2,right:2,left:0,bottom:16}}>
                      <XAxis dataKey="name" tick={{fill:'var(--text-3)',fontSize:9}} angle={-30} textAnchor="end" interval={0}/>
                      <Tooltip content={<Tip/>}/>
                      <Bar dataKey="count" name="Rows" fill="#3b82f6" radius={[2,2,0,0]}/>
                    </BarChart>
                  </ResponsiveContainer>
                : <p style={{color:'var(--text-5)',fontSize:11}}>No data</p>}
            </div>
            {/* Gender dist */}
            <div>
              <p style={{ margin:'0 0 8px', fontSize:10, color:'var(--text-3)', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.5px' }}>Gender Distribution</p>
              {(entry.genderDist||[]).length>0
                ? <div style={{ paddingTop:8 }}>
                    {entry.genderDist.map((g,i)=>{
                      const tot = entry.genderDist.reduce((s,x)=>s+x.count,0)||1;
                      return (
                        <div key={g.name} style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
                          <div style={{width:8,height:8,borderRadius:2,background:PIE_COLORS[i%PIE_COLORS.length],flexShrink:0}}/>
                          <span style={{fontSize:12,color:'var(--text-2)',flex:1}}>{g.name}</span>
                          <span style={{fontSize:13,color:PIE_COLORS[i%PIE_COLORS.length],fontWeight:700}}>{g.count}</span>
                          <span style={{fontSize:11,color:'var(--text-4)'}}>{Math.round(g.count/tot*100)}%</span>
                        </div>
                      );
                    })}
                  </div>
                : <p style={{color:'var(--text-5)',fontSize:11}}>No data</p>}
            </div>
          </div>
          <div style={{ marginTop:8, fontSize:11, color:'var(--text-4)' }}>
            Filters: Years <span style={{color:'var(--text-2)'}}>{entry.gradYears?.join(', ')||'all'}</span> ·
            Genders <span style={{color:'var(--text-2)'}}>{entry.genders?.join(', ')||'all'}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────
export default function LeagueDetailPanel({ eventId, onClose }) {
  const [detail,   setDetail]   = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [history,  setHistory]  = useState([]);
  const [histTab,  setHistTab]  = useState('charts'); // 'charts' | 'export' | 'history'
  const [reExportEntry, setReExportEntry] = useState(null);

  const curYear = new Date().getFullYear();

  useEffect(() => {
    Promise.all([
      api.reportLeagueDetail(eventId),
      api.listExports(eventId),
    ]).then(([d, h]) => {
      setDetail(d.data);
      setHistory(h.data || []);
    }).catch(() => toast.error('Failed to load league detail'))
      .finally(() => setLoading(false));
  }, [eventId]);

  function refreshHistory() {
    api.listExports(eventId).then(r => setHistory(r.data||[]));
  }

  async function handleDelete(id) {
    await api.deleteExport(id);
    setHistory(prev => prev.filter(e=>e.id!==id));
  }

  if (loading) {
    return (
      <div style={{ padding:'32px 20px', textAlign:'center', color:'var(--text-3)' }}>
        <div className="spinner" style={{ margin:'0 auto 12px' }}/> Loading…
      </div>
    );
  }
  if (!detail) return null;

  const totalGe = (detail.gender||[]).reduce((s,g)=>s+g.count,0);

  const tabs = [
    { id:'charts',  label:'📊 Analytics' },
    { id:'export',  label:'📤 Export CSV' },
    { id:'history', label:`🗂 History (${history.length})` },
  ];

  return (
    <div style={{ paddingTop:16, borderTop:'1px solid var(--line)' }}>
      {/* Header */}
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:16, gap:12, flexWrap:'wrap' }}>
        <div>
          <h3 style={{ margin:'0 0 4px', color:'var(--text-1)', fontSize:15, fontWeight:700 }}>{detail.eventName}</h3>
          <span style={{ fontSize:12, color:'var(--text-3)' }}>{detail.totalStored} registrations · {detail.totalComplete} completed</span>
        </div>
        <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--text-4)', cursor:'pointer', fontSize:18 }}>✕</button>
      </div>

      {/* Sub-tabs */}
      <div style={{ display:'flex', gap:4, marginBottom:16, borderBottom:'1px solid var(--line)', paddingBottom:0 }}>
        {tabs.map(t=>(
          <button key={t.id} onClick={()=>setHistTab(t.id)}
            style={{ padding:'7px 14px', fontSize:12, fontWeight:600, border:'none', borderBottom:`2px solid ${histTab===t.id?'#3b82f6':'transparent'}`,
              background:'none', color:histTab===t.id?'var(--accent-light)':'var(--text-3)', cursor:'pointer', transition:'all 0.12s' }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Charts tab ──────────────────────────────────────────────── */}
      {histTab==='charts' && (
        <div>
          {(detail.gradeBuckets||[]).length>0 && (
            <div style={{marginBottom:22}}>
              <p style={{margin:'0 0 8px',fontSize:10,color:'var(--text-3)',fontWeight:700,textTransform:'uppercase',letterSpacing:'0.8px'}}>Grade Buckets</p>
              <BucketBar buckets={detail.gradeBuckets}/>
            </div>
          )}

          <div className="grid-2" style={{ gap:20, marginBottom:20 }}>
            <div>
              <p style={{margin:'0 0 8px',fontSize:10,color:'var(--text-3)',fontWeight:700,textTransform:'uppercase',letterSpacing:'0.8px'}}>Grad Year Distribution</p>
              {(detail.graduationYear||[]).length===0
                ? <p style={{color:'var(--text-5)',fontSize:12}}>No data.</p>
                : <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={detail.graduationYear} margin={{top:4,right:4,left:0,bottom:20}}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1a1d2a"/>
                      <XAxis dataKey="name" stroke="var(--text-5)" tick={{fill:'var(--text-3)',fontSize:9}} angle={-45} textAnchor="end" interval={0}/>
                      <YAxis stroke="var(--text-5)" tick={{fill:'var(--text-3)',fontSize:9}}/>
                      <Tooltip content={<Tip/>}/>
                      <Bar dataKey="count" name="Teams" radius={[3,3,0,0]}>
                        {detail.graduationYear.map(g=><Cell key={g.name} fill={BUCKET_COLOR[g.bucket]||PIE_COLORS[0]}/>)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>}
            </div>
            <div>
              <p style={{margin:'0 0 8px',fontSize:10,color:'var(--text-3)',fontWeight:700,textTransform:'uppercase',letterSpacing:'0.8px'}}>Gender Split</p>
              {(detail.gender||[]).length===0
                ? <p style={{color:'var(--text-5)',fontSize:12}}>No gender data.</p>
                : <div style={{display:'flex',alignItems:'center',gap:14}}>
                    <PieChart width={130} height={130}>
                      <Pie data={withTotal(detail.gender)} dataKey="count" nameKey="name" cx={65} cy={65} innerRadius={36} outerRadius={58}>
                        {detail.gender.map((_,i)=><Cell key={i} fill={PIE_COLORS[i%PIE_COLORS.length]}/>)}
                      </Pie>
                      <Tooltip content={<PieTip/>}/>
                    </PieChart>
                    <div style={{flex:1}}>
                      {detail.gender.map((g,i)=>(
                        <div key={g.name} style={{display:'flex',alignItems:'center',gap:8,marginBottom:7}}>
                          <div style={{width:9,height:9,borderRadius:2,background:PIE_COLORS[i%PIE_COLORS.length],flexShrink:0}}/>
                          <span style={{fontSize:12,color:'var(--text-2)',flex:1}}>{g.name}</span>
                          <span style={{fontSize:13,color:'var(--text-1)',fontWeight:700}}>{g.count}</span>
                          <span style={{fontSize:11,color:'var(--text-4)'}}>{totalGe>0?`${Math.round(g.count/totalGe*100)}%`:''}</span>
                        </div>
                      ))}
                    </div>
                  </div>}
            </div>
          </div>

          {(detail.graduationYear||[]).length>0 && (
            <div style={{marginBottom:18}}>
              <p style={{margin:'0 0 8px',fontSize:10,color:'var(--text-3)',fontWeight:700,textTransform:'uppercase',letterSpacing:'0.8px'}}>Grade → Grad Year</p>
              <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
                {detail.graduationYear.map(g=>(
                  <div key={g.name} style={{background:'#171b27',border:`1px solid ${BUCKET_COLOR[g.bucket]||'var(--line)'}44`,borderRadius:8,padding:'5px 12px',fontSize:11}}>
                    <span style={{color:'var(--text-2)'}}>{g.grade} </span>
                    <span style={{color:'var(--text-1)',fontWeight:700}}>({g.name})</span>
                    <span style={{color:BUCKET_COLOR[g.bucket]||'var(--accent-light)',marginLeft:6,fontWeight:700}}>×{g.count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Locations */}
          {((detail.state||[]).length>0||(detail.city||[]).length>0) && (
            <div className="grid-2" style={{gap:16}}>
              {(detail.state||[]).length>0 && (
                <div>
                  <p style={{margin:'0 0 6px',fontSize:10,color:'var(--text-3)',fontWeight:700,textTransform:'uppercase',letterSpacing:'0.8px'}}>Top States</p>
                  <div style={{display:'flex',flexWrap:'wrap',gap:4}}>
                    {detail.state.slice(0,8).map((s,i)=>(
                      <span key={s.name} style={{background:'#171b27',border:'1px solid var(--line)',borderRadius:20,padding:'3px 10px',fontSize:11,color:PIE_COLORS[i%PIE_COLORS.length]}}>
                        {s.name} <span style={{color:'var(--text-4)'}}>×{s.count}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {(detail.city||[]).length>0 && (
                <div>
                  <p style={{margin:'0 0 6px',fontSize:10,color:'var(--text-3)',fontWeight:700,textTransform:'uppercase',letterSpacing:'0.8px'}}>Top Cities</p>
                  <div style={{display:'flex',flexWrap:'wrap',gap:4}}>
                    {detail.city.slice(0,8).map(c=>(
                      <span key={c.name} style={{background:'#171b27',border:'1px solid var(--line)',borderRadius:20,padding:'3px 10px',fontSize:11,color:'var(--text-2)'}}>
                        {c.name} <span style={{color:'var(--text-4)'}}>×{c.count}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Export tab ──────────────────────────────────────────────── */}
      {histTab==='export' && (
        <div>
          {/* Quick "Download All" — no filters, all teams */}
          <QuickDownloadAll eventId={eventId} totalComplete={detail.totalComplete} onExportSaved={refreshHistory}/>

          {/* 3-step filtered export */}
          <ExportConfigPanel
            detail={detail}
            eventId={eventId}
            onExportSaved={refreshHistory}
          />
        </div>
      )}

      {/* ── History tab ─────────────────────────────────────────────── */}
      {histTab==='history' && (
        <div>
          {history.length===0
            ? <div style={{textAlign:'center',padding:'32px',color:'var(--text-4)',fontSize:13}}>
                No exports yet. Go to the Export tab to generate your first CSV.
              </div>
            : history.map(entry=>(
                <ExportHistoryEntry
                  key={entry.id}
                  entry={entry}
                  onDelete={async (id) => {
                    try { await api.deleteLeagueCsvExport(id); } catch {}
                    await api.deleteExport(id);
                    setHistory(prev => prev.filter(e=>e.id!==id));
                  }}
                  onReExport={(e)=>{ setHistTab('export'); }}
                />
              ))}
        </div>
      )}
    </div>
  );
}
