/**
 * AggregatePanel — works in two modes:
 *
 *  LOCAL DEV  → connects to /api/aggregate/stream SSE (existing aggregator.js flow)
 *  VERCEL     → client-driven loop: calls /api/aggregate/plan then /api/aggregate/fetch-event
 *               one event at a time, shows progress in its own terminal-style log
 *
 * The mode is detected automatically: if the SSE stream immediately returns a
 * state with phase:'idle' and the server is Vercel, we switch to client-driven.
 */
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.jsx';
import { toast } from 'react-hot-toast';
import SearchableSelect from './SearchableSelect.jsx';

const BAR_COLOR = {
  idle: '#334155', discovering: '#f97316', fetching: '#3b82f6', done: '#22c55e', error: '#ef4444',
};

function eventYear(reg) {
  return (reg.close || reg.open || '').slice(0, 4);
}

function computeSmartEvents(recentRegs, storedMap, yearFilter) {
  const needs = [], upToDate = [], notFetched = [];
  for (const reg of recentRegs) {
    if (yearFilter && eventYear(reg) !== yearFilter) continue;
    const stored = storedMap[String(reg.id)];
    const current = reg.resultsCompleted || 0;
    if (!stored) { notFetched.push(reg); needs.push(reg); }
    else {
      const storedC = stored.resultsCompleted ?? stored.meta?.resultsCompleted ?? null;
      if (storedC === null || current > storedC) needs.push(reg);
      else upToDate.push(reg);
    }
  }
  return { needs, upToDate, notFetched };
}

export default function AggregatePanel({ orgId = '8008', onComplete, recentRegs = [] }) {
  // SSE state (local dev)
  const [sseState,  setSseState]  = useState(null);
  const [sseLog,    setSseLog]    = useState([]);
  // Client-driven state (Vercel)
  const [cdRunning, setCdRunning] = useState(false);
  const [cdLog,     setCdLog]     = useState([]);
  const [cdProgress,setCdProgress]= useState({ current:0, total:0, added:0, skipped:0, errors:0 });
  const [cdPhase,   setCdPhase]   = useState('idle'); // idle|planning|fetching|done

  const [open,      setOpen]      = useState(true);
  const [delay,     setDelay]     = useState(1200);
  const [mode,      setMode]      = useState('smart');
  const [yearFilter, setYearFilter] = useState(new Date().getFullYear().toString());
  const [selected,  setSelected]  = useState([]);
  const [purgeFirst, setPurgeFirst] = useState(false);
  const [storedMap, setStoredMap] = useState({});
  const [smartInfo, setSmartInfo] = useState(null);

  const esRef   = useRef(null);
  const cdAbort = useRef(false);
  const logRef  = useRef(null);

  // Detect Vercel vs local via explicit API endpoint — reliable, no guessing
  const [isVercel, setIsVercel] = useState(null); // null = still detecting

  useEffect(() => {
    loadStoredMap();
    fetch('/api/runtime')
      .then(r => r.json())
      .then(d => setIsVercel(!!d.vercel))
      .catch(() => setIsVercel(false)); // if endpoint missing, assume local
  }, []);

  // Connect SSE once we know we're NOT on Vercel
  useEffect(() => {
    if (isVercel !== false) return; // wait until detection done; skip if Vercel
    const es = new EventSource('/api/aggregate/stream');
    esRef.current = es;
    es.addEventListener('state', e => { const s=JSON.parse(e.data); setSseState(s); if(s.log) setSseLog(s.log.slice().reverse()); });
    es.addEventListener('progress', e => { const p=JSON.parse(e.data); setSseState(prev=>prev?{...prev,current:p.current}:prev); });
    es.addEventListener('log', e => setSseLog(prev=>[...prev,JSON.parse(e.data)].slice(-80)));
    es.addEventListener('complete', e => {
      const d = JSON.parse(e.data);
      toast.success(`Done — ${d.newResults} new results`);
      loadStoredMap();
      if (onComplete) onComplete(d);
    });
    es.onerror = () => {};
    return () => es.close();
  }, [isVercel]);

  useEffect(() => { if (recentRegs.length) recomputeSmart(); }, [recentRegs, storedMap, yearFilter, mode]);
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, [sseLog, cdLog]);

  async function loadStoredMap() {
    try {
      const res = await api.storeEvents();
      const m = {};
      for (const ev of (res.data.events||[])) m[String(ev.id)] = ev;
      setStoredMap(m);
    } catch {}
  }

  function recomputeSmart() {
    setSmartInfo(computeSmartEvents(recentRegs, storedMap, mode==='smart' ? yearFilter : null));
  }

  // ── CLIENT-DRIVEN AGGREGATION (Vercel) ─────────────────────────────────────

  function cdAddLog(msg, level='info') {
    const entry = { ts: new Date().toLocaleTimeString('en-US',{hour12:false}), msg, level };
    setCdLog(prev => [...prev, entry].slice(-100));
  }

  async function startClientDriven() {
    cdAbort.current = false;
    setCdRunning(true); setCdLog([]); setCdPhase('planning');
    setCdProgress({ current:0, total:0, added:0, skipped:0, errors:0 });

    cdAddLog('Planning — fetching event list from SportsEngine…', 'info');

    let eventsToFetch = [];
    try {
      if (mode === 'selected') {
        eventsToFetch = selected.map(s => {
          const full = recentRegs.find(r=>String(r.id)===String(s.id));
          return full || s;
        });
        cdAddLog(`Selective mode — ${eventsToFetch.length} league(s) chosen`, 'info');
      } else if (mode === 'smart') {
        // Use local smart computation (no round-trip for plan needed)
        if (smartInfo?.needs?.length === 0) {
          cdAddLog('All events are up-to-date — nothing to fetch', 'ok');
          setCdPhase('done');
          setCdRunning(false);
          if (onComplete) onComplete({ newResults: 0 });
          return;
        }
        eventsToFetch = smartInfo?.needs || [];
        cdAddLog(`Smart Update — ${eventsToFetch.length} event(s) need work (${smartInfo?.upToDate?.length||0} up-to-date, skipping)`, 'info');
      } else {
        // All mode — call server plan endpoint
        const year = yearFilter || undefined;
        const planRes = await api.aggregatePlan(orgId, year);
        eventsToFetch = planRes.data.needs || [];
        cdAddLog(`Discovered ${planRes.data.total} events — ${eventsToFetch.length} need fetching`, 'info');
      }
    } catch (err) {
      cdAddLog(`✗ Planning failed: ${err.message}`, 'error');
      setCdPhase('idle'); setCdRunning(false);
      return;
    }

    if (!eventsToFetch.length) {
      cdAddLog('Nothing to fetch — all up-to-date', 'ok');
      setCdPhase('done'); setCdRunning(false);
      return;
    }

    setCdPhase('fetching');
    setCdProgress(p => ({ ...p, total: eventsToFetch.length }));

    let added=0, skipped=0, errors=0;

    for (let i=0; i<eventsToFetch.length; i++) {
      if (cdAbort.current) { cdAddLog('⏹ Stopped by user', 'warn'); break; }
      const ev = eventsToFetch[i];
      cdAddLog(`[${i+1}/${eventsToFetch.length}] "${ev.name}"`, 'info');

      let evAdded=0, evFetched=0, nextPage=undefined, pageNum=0, wasSkipped=false;
      try {
        // Loop through pages — each call fetches one page (no server timeout risk)
        do {
          if (cdAbort.current) break;
          const res = await api.aggregateFetchEvent({
            orgId,
            eventId:          String(ev.id),
            eventName:        ev.name,
            eventStatus:      ev.status,
            resultsCompleted: ev.resultsCompleted || 0,
            purgeFirst:       purgeFirst && mode === 'selected',
            ...(nextPage != null ? { page: nextPage } : {}),
          });

          if (res.data.skipped) {
            wasSkipped = true;
            skipped++;
            cdAddLog(`  ↷ SKIP — count unchanged (${ev.resultsCompleted})`, 'skip');
            break;
          }

          evAdded   += res.data.added   || 0;
          evFetched += res.data.fetched  || 0;
          pageNum++;
          nextPage = res.data.hasMore ? res.data.nextPage : null;

          if (res.data.hasMore) {
            cdAddLog(`  ↓ page ${pageNum} (p${res.data.page}): +${res.data.added} — more pages…`, 'info');
            await new Promise(r => setTimeout(r, 400));
          }
        } while (nextPage != null);

        if (!wasSkipped) {
          added += evAdded;
          cdAddLog(`  ✓ +${evAdded} new results (${evFetched} fetched${pageNum>1?`, ${pageNum} pages`:''})`, evAdded>0?'ok':'skip');
        }
      } catch (err) {
        errors++;
        cdAddLog(`  ✗ FAILED: ${err.response?.data?.error || err.message}`, 'error');
      }

      setCdProgress({ current: i+1, total: eventsToFetch.length, added, skipped, errors });

      if (i < eventsToFetch.length-1 && !cdAbort.current) {
        await new Promise(r => setTimeout(r, delay));
      }
    }

    const finalDb = await api.storeEvents();
    cdAddLog(`════ DONE — ${added} new results saved · ${skipped} skipped · ${errors} errors ════`, added>0?'ok':'info');
    setCdPhase('done'); setCdRunning(false);
    await loadStoredMap();
    if (onComplete) onComplete({ newResults: added, eventsProcessed: eventsToFetch.length, skipped, errors });
    toast.success(`Done — ${added} new results saved`);
  }

  async function startAgg() {
    if (isVercel === true) { startClientDriven(); return; }

    // Local dev: use SSE aggregator
    const pack = r => ({ id:r.id, name:r.name, status:r.status, open:r.open, close:r.close, sport:r.sport, resultsCompleted:r.resultsCompleted });
    let events = [];
    if (mode==='selected') events = selected.map(s=>{const full=recentRegs.find(r=>String(r.id)===String(s.id));return pack(full||s);});
    else if (mode==='smart') events = (smartInfo?.needs||[]).map(pack);
    else if (yearFilter) events = recentRegs.filter(r=>eventYear(r)===yearFilter).map(pack);

    const doPurge = mode==='selected' && purgeFirst;
    try {
      const res = await api.startAggregate(orgId, delay, events, doPurge);
      if (!res.data.started) toast.error(res.data.message);
    } catch(err) { toast.error('Failed: '+err.message); }
  }

  function addLeague(id) {
    if (!id) return;
    const reg = recentRegs.find(r=>String(r.id)===String(id));
    if (!reg||selected.some(s=>String(s.id)===String(id))) return;
    setSelected(prev=>[...prev,{id:reg.id,name:reg.name}]);
  }

  const years = [...new Set(recentRegs.map(eventYear).filter(y=>/^20\d{2}$/.test(y)))].sort().reverse();
  const smartNeeds    = smartInfo?.needs?.length    || 0;
  const smartUpToDate = smartInfo?.upToDate?.length || 0;
  const running = isVercel === true ? cdRunning : !!sseState?.running;
  const phase   = isVercel === true ? cdPhase   : (sseState?.phase||'idle');
  const barColor = BAR_COLOR[phase]||'#334155';
  const cdPct = cdProgress.total > 0 ? Math.round(cdProgress.current/cdProgress.total*100) : 0;
  const ssePct = sseState?.total > 0 ? Math.round((sseState.current||0)/sseState.total*100) : 0;
  const pct = isVercel === true ? cdPct : ssePct;
  const log = isVercel === true ? cdLog : sseLog;

  function btnLabel() {
    if (running) return '⏳ Running…';
    if (mode==='smart') {
      if (smartNeeds===0) return '✓ All up-to-date';
      return `⚡ Smart Update — ${smartNeeds} event${smartNeeds!==1?'s':''} need work`;
    }
    if (mode==='selected') return purgeFirst?`↺ Purge & Re-fetch ${selected.length} league${selected.length!==1?'s':''}`:`▶ Fetch ${selected.length} league${selected.length!==1?'s':''}`;
    const n = yearFilter ? recentRegs.filter(r=>eventYear(r)===yearFilter).length : recentRegs.length;
    return `▶ Fetch All${yearFilter?' '+yearFilter:''} Events (${n})`;
  }

  return (
    <div className="card">
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
        <div>
          <h2 style={{margin:0}}>Data Aggregation {isVercel&&<span style={{fontSize:11,color:'#f97316',fontWeight:400,marginLeft:6}}>client-driven mode</span>}</h2>
          <p style={{color:'#475569',fontSize:12,marginTop:3}}>Fetches registration results from SportsEngine and saves locally.</p>
        </div>
        <button onClick={()=>setOpen(o=>!o)} style={{background:'none',border:'none',color:'#64748b',cursor:'pointer',fontSize:13}}>
          {open?'▲ Collapse':'▼ Expand'}
        </button>
      </div>

      {/* Progress bar */}
      <div style={{background:'#1e2235',borderRadius:8,height:10,overflow:'hidden',marginBottom:8}}>
        <div style={{width:`${pct}%`,height:'100%',borderRadius:8,background:barColor,transition:'width 0.4s ease',position:'relative'}}>
          {running&&<div style={{position:'absolute',top:0,left:0,right:0,bottom:0,background:'linear-gradient(90deg,transparent,rgba(255,255,255,0.2),transparent)',animation:'shimmer 1.5s infinite'}}/>}
        </div>
      </div>

      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:open?16:0}}>
        <span style={{fontSize:13,color:barColor,fontWeight:700}}>
          {phase==='idle'       &&'Ready'}
          {phase==='planning'   &&'Planning…'}
          {phase==='discovering'&&'Discovering events…'}
          {phase==='fetching'   &&(isVercel?`Fetching ${cdProgress.current}/${cdProgress.total} — ${pct}%`:`Fetching ${sseState?.current||0}/${sseState?.total||0} — ${pct}%`)}
          {phase==='done'       &&(isVercel?`Done — ${cdProgress.added} new results`:`Done — ${sseState?.newResults||0} new results`)}
        </span>
        <span style={{fontSize:11,color:'#475569'}}>
          {isVercel ? (cdProgress.skipped>0?`${cdProgress.skipped} skipped · `:'')+(cdProgress.errors>0?`${cdProgress.errors} errors · `:'')+(cdProgress.total>0?`${cdProgress.total} events`:'')
                    : (sseState?.skipped>0?`${sseState.skipped} skipped · `:'')+(sseState?.errors>0?`${sseState.errors} errors · `:'')+(sseState?.total>0?`${sseState.total} events`:'')}
        </span>
      </div>

      {open && (
        <>
          {/* Mode toggle */}
          <div style={{display:'flex',gap:6,marginBottom:14,flexWrap:'wrap'}}>
            {[{id:'smart',label:'⚡ Smart Update'},{id:'all',label:'All Events'},{id:'selected',label:'Custom Selection'}].map(m=>(
              <button key={m.id} onClick={()=>setMode(m.id)} disabled={running}
                style={{padding:'6px 14px',borderRadius:6,fontSize:12,fontWeight:700,
                  border:`1px solid ${mode===m.id?'#3b82f6':'#252838'}`,cursor:running?'not-allowed':'pointer',
                  background:mode===m.id?'#1e3a5f':'#1e2235',color:mode===m.id?'#60a5fa':'#64748b'}}>
                {m.label}
              </button>
            ))}
          </div>

          {/* Smart info */}
          {mode==='smart' && (
            <div style={{background:'#0d1520',border:'1px solid #1e3a5f',borderRadius:10,padding:'12px 14px',marginBottom:14}}>
              <p style={{margin:'0 0 8px',fontSize:12,color:'#60a5fa',fontWeight:600}}>⚡ Only fetches events with new registrations since last run</p>
              <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center',marginBottom:10}}>
                <span style={{fontSize:11,color:'#64748b',fontWeight:600}}>Year filter:</span>
                {[...years,''].map(y=>(
                  <button key={y||'all'} onClick={()=>setYearFilter(y)} disabled={running}
                    style={{padding:'4px 12px',borderRadius:20,fontSize:11,fontWeight:700,border:'none',cursor:'pointer',
                      background:yearFilter===y?'#2563eb':'#1e2235',color:yearFilter===y?'#fff':'#64748b'}}>
                    {y||'All years'}
                  </button>
                ))}
              </div>
              {smartInfo && (
                <div style={{display:'flex',gap:12,flexWrap:'wrap'}}>
                  <div style={{background:'#13161f',borderRadius:8,padding:'8px 14px'}}>
                    <div style={{fontSize:10,color:'#475569',textTransform:'uppercase',letterSpacing:'0.5px'}}>Need fetching</div>
                    <div style={{fontSize:22,fontWeight:800,color:'#f97316'}}>{smartNeeds}</div>
                  </div>
                  <div style={{background:'#13161f',borderRadius:8,padding:'8px 14px'}}>
                    <div style={{fontSize:10,color:'#475569',textTransform:'uppercase',letterSpacing:'0.5px'}}>Up-to-date</div>
                    <div style={{fontSize:22,fontWeight:800,color:'#22c55e'}}>{smartUpToDate}</div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* All Events year filter */}
          {mode==='all' && (
            <div style={{background:'#0d0f17',border:'1px solid #252838',borderRadius:10,padding:'12px 14px',marginBottom:14}}>
              <p style={{margin:'0 0 8px',fontSize:11,color:'#94a3b8',fontWeight:600}}>Year filter</p>
              <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                {[...years,''].map(y=>(
                  <button key={y||'all'} onClick={()=>setYearFilter(y)} disabled={running}
                    style={{padding:'5px 14px',borderRadius:20,fontSize:12,fontWeight:700,border:'none',cursor:'pointer',
                      background:yearFilter===y?'#2563eb':'#1e2235',color:yearFilter===y?'#fff':'#64748b'}}>
                    {y||'All years'}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Custom selection */}
          {mode==='selected' && (
            <div style={{background:'#0d0f17',border:'1px solid #1e2235',borderRadius:10,padding:'12px 14px',marginBottom:14}}>
              <div style={{display:'flex',gap:10,alignItems:'flex-end',flexWrap:'wrap',marginBottom:10}}>
                <div style={{flex:1,minWidth:200}}>
                  <label style={{fontSize:11,color:'#64748b',display:'block',marginBottom:4}}>Add League</label>
                  <SearchableSelect value="" onChange={addLeague} disabled={running}
                    options={recentRegs.filter(r=>!selected.some(s=>String(s.id)===String(r.id))).map(r=>({value:String(r.id),label:r.name}))}
                    placeholder="Search and pick…"/>
                </div>
                <label style={{display:'flex',alignItems:'center',gap:6,fontSize:12,color:'#f87171',cursor:running?'not-allowed':'pointer',paddingBottom:4}}>
                  <input type="checkbox" checked={purgeFirst} onChange={e=>setPurgeFirst(e.target.checked)} disabled={running} style={{accentColor:'#ef4444',width:14,height:14}}/>
                  Purge first, then re-fetch
                </label>
                {selected.length>0&&<button onClick={()=>setSelected([])} disabled={running} style={{padding:'5px 10px',borderRadius:6,fontSize:11,border:'none',cursor:'pointer',background:'#1e2235',color:'#64748b'}}>Clear all</button>}
              </div>
              {selected.length===0?<p style={{color:'#334155',fontSize:12,margin:0}}>No leagues selected.</p>:(
                <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                  {selected.map(s=>(
                    <div key={s.id} style={{display:'flex',alignItems:'center',gap:5,background:'#1e2235',border:'1px solid #2a2d3e',borderRadius:20,padding:'4px 10px 4px 12px',fontSize:12}}>
                      <span style={{color:'#cbd5e1',maxWidth:260,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{s.name}</span>
                      {!running&&<button onClick={()=>setSelected(prev=>prev.filter(x=>String(x.id)!==String(s.id)))} style={{background:'none',border:'none',color:'#64748b',cursor:'pointer',fontSize:14,padding:'0 2px'}}>×</button>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Controls */}
          <div style={{display:'flex',gap:12,alignItems:'center',marginBottom:12,flexWrap:'wrap'}}>
            <div>
              <label style={{fontSize:11,color:'#64748b',display:'block',marginBottom:4}}>Delay between fetches</label>
              <select value={delay} onChange={e=>setDelay(Number(e.target.value))} disabled={running}
                style={{background:'#1e2235',border:'1px solid #2a2d3e',color:'#e2e8f0',borderRadius:6,padding:'6px 10px',fontSize:13}}>
                <option value={800}>800ms</option>
                <option value={1200}>1.2s (recommended)</option>
                <option value={2000}>2s</option>
                <option value={3000}>3s</option>
              </select>
            </div>
            <div style={{marginTop:18}}>
              {!running?(
                <button className="btn-primary" onClick={startAgg}
                  disabled={(mode==='selected'&&selected.length===0)||(mode==='smart'&&smartNeeds===0)}
                  style={{opacity:((mode==='selected'&&selected.length===0)||(mode==='smart'&&smartNeeds===0))?0.4:1}}>
                  {btnLabel()}
                </button>
              ):(
                <button disabled className="btn-primary" style={{background:'#1e3a5f',cursor:'not-allowed'}}>⏳ Running…</button>
              )}
              {isVercel && running && (
                <button onClick={()=>{cdAbort.current=true;}} style={{marginLeft:8,padding:'8px 14px',background:'#2b0d0d',color:'#f87171',border:'none',borderRadius:6,cursor:'pointer',fontSize:12,fontWeight:700}}>⏹ Stop</button>
              )}
            </div>
          </div>

          {/* Stats */}
          {(isVercel ? cdProgress.total>0 : sseState) && (
            <div style={{display:'flex',gap:10,marginBottom:12,flexWrap:'wrap'}}>
              {[
                {label:'New Results',    val:isVercel?cdProgress.added:sseState?.newResults||0,    color:'#22c55e'},
                {label:'Events Done',    val:isVercel?cdProgress.current:sseState?.current||0,     color:'#60a5fa'},
                {label:'Events Skipped',val:isVercel?cdProgress.skipped:sseState?.skipped||0,     color:'#f97316'},
                {label:'Errors',         val:isVercel?cdProgress.errors:sseState?.errors||0,      color:'#ef4444'},
              ].map(s=>(
                <div key={s.label} style={{background:'#1e2235',borderRadius:6,padding:'8px 14px',flex:1,minWidth:90}}>
                  <div style={{color:'#64748b',fontSize:10,textTransform:'uppercase'}}>{s.label}</div>
                  <div style={{color:s.color,fontSize:20,fontWeight:700}}>{s.val}</div>
                </div>
              ))}
            </div>
          )}

          {/* Log */}
          <div ref={logRef} style={{background:'#0a0c12',borderRadius:8,padding:10,maxHeight:200,overflowY:'auto',fontFamily:'monospace',fontSize:11}}>
            {log.length===0
              ? <span style={{color:'#334155'}}>No log entries yet.</span>
              : log.map((entry,i)=>(
                <div key={i} style={{color:entry.level==='error'?'#ef4444':entry.level==='warn'?'#f97316':entry.level==='ok'?'#22c55e':'#64748b',marginBottom:2,lineHeight:1.5}}>
                  <span style={{color:'#334155',marginRight:6}}>{entry.ts?.slice?.(11,19)||entry.ts||''}</span>{entry.msg}
                </div>
              ))}
          </div>
          <p style={{color:'#334155',fontSize:11,marginTop:8}}>
            {isVercel?'Running on Vercel — one event per request, no timeout. ':''}
            Smart Update skips events with unchanged counts. Closed events cached permanently.
          </p>
        </>
      )}
      <style>{`@keyframes shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(200%)}}`}</style>
    </div>
  );
}
