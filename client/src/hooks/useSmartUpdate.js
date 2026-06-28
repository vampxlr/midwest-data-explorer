/**
 * useSmartUpdate — minimal "Smart Update" runner shared by the Dashboard's
 * top quick-glance bar and Reports' top bar. Only runs SMART mode (fetch
 * events whose registration count changed since last run) — no purge, no
 * year/type filters, no mode switching. Full control over those lives in
 * <AggregatePanel/> (Reports' collapsible Data Aggregation section).
 *
 * Mirrors the smart-mode logic in components/AggregatePanel.jsx so both
 * stay behaviorally identical; kept separate (rather than shared) since the
 * panel's full mode-switching logic would be dead weight here.
 */
import { useEffect, useRef, useState } from 'react';
import { api, withToken } from '../api.jsx';
import { toast } from 'react-hot-toast';

export default function useSmartUpdate({ orgId = '8008', recentRegs = [], onComplete } = {}) {
  const [isVercel, setIsVercel] = useState(null);
  const [sseState, setSseState] = useState(null);
  const [sseLog,   setSseLog]   = useState([]);
  const [cdRunning, setCdRunning] = useState(false);
  const [cdLog,     setCdLog]     = useState([]);
  const [cdProgress, setCdProgress] = useState({ current:0, total:0, added:0, skipped:0, errors:0 });
  const [cdPhase,   setCdPhase]   = useState('idle');
  const [storedMap, setStoredMap] = useState({});

  const esRef   = useRef(null);
  const cdAbort = useRef(false);

  useEffect(() => {
    loadStoredMap();
    fetch('/api/runtime')
      .then(r => r.json())
      .then(d => setIsVercel(!!d.vercel))
      .catch(() => setIsVercel(false));
  }, []);

  useEffect(() => {
    if (isVercel !== false) return;
    const es = new EventSource(withToken('/api/aggregate/stream'));
    esRef.current = es;
    es.addEventListener('state', e => { const s=JSON.parse(e.data); setSseState(s); if(s.log) setSseLog(s.log.slice().reverse()); });
    es.addEventListener('progress', e => { const p=JSON.parse(e.data); setSseState(prev=>prev?{...prev,current:p.current}:prev); });
    es.addEventListener('log', e => setSseLog(prev=>[...prev,JSON.parse(e.data)].slice(-80)));
    es.addEventListener('complete', e => {
      const d = JSON.parse(e.data);
      toast.success(`Smart Update done — ${d.newResults} new results`);
      loadStoredMap();
      if (onComplete) onComplete(d);
    });
    es.onerror = () => {};
    return () => es.close();
  }, [isVercel]);

  async function loadStoredMap() {
    try {
      const res = await api.storeEvents();
      const m = {};
      for (const ev of (res.data.events||[])) m[String(ev.id)] = ev;
      setStoredMap(m);
    } catch {}
  }

  function computeNeeds() {
    const needs = [];
    for (const reg of recentRegs) {
      const stored = storedMap[String(reg.id)];
      const current = reg.resultsCompleted || 0;
      if (!stored) { needs.push(reg); continue; }
      const storedC = stored.resultsCompleted ?? stored.meta?.resultsCompleted ?? null;
      if (storedC === null || current > storedC) needs.push(reg);
    }
    return needs;
  }

  function cdAddLog(msg, level='info') {
    const entry = { ts: new Date().toLocaleTimeString('en-US',{hour12:false}), msg, level };
    setCdLog(prev => [...prev, entry].slice(-100));
  }

  async function startClientDriven() {
    cdAbort.current = false;
    setCdRunning(true); setCdLog([]); setCdPhase('planning');
    setCdProgress({ current:0, total:0, added:0, skipped:0, errors:0 });

    const eventsToFetch = computeNeeds();
    if (!eventsToFetch.length) {
      cdAddLog('All events are up-to-date — nothing to fetch', 'ok');
      setCdPhase('done'); setCdRunning(false);
      if (onComplete) onComplete({ newResults: 0 });
      return;
    }
    cdAddLog(`Smart Update — ${eventsToFetch.length} event(s) need work`, 'info');
    setCdPhase('fetching');
    setCdProgress(p => ({ ...p, total: eventsToFetch.length }));

    let added=0, skipped=0, errors=0;
    for (let i=0; i<eventsToFetch.length; i++) {
      if (cdAbort.current) { cdAddLog('⏹ Stopped by user', 'warn'); break; }
      const ev = eventsToFetch[i];
      cdAddLog(`[${i+1}/${eventsToFetch.length}] "${ev.name}"`, 'info');

      let evAdded=0, nextPage, prevCompact=[];
      try {
        do {
          if (cdAbort.current) break;
          const res = await api.aggregateFetchEvent({
            orgId, eventId: String(ev.id), eventName: ev.name, eventStatus: ev.status,
            resultsCompleted: ev.resultsCompleted || 0,
            ...(nextPage != null ? { page: nextPage } : {}),
            ...(prevCompact.length > 0 ? { prevCompact } : {}),
          });
          if (res.data.skipped) { skipped++; cdAddLog(`  ↷ SKIP — count unchanged (${ev.resultsCompleted})`, 'skip'); break; }
          if (res.data.hasMore) {
            prevCompact = res.data.compact || [];
            nextPage    = res.data.nextPage;
            await new Promise(r => setTimeout(r, 400));
          } else {
            evAdded = res.data.added || 0;
            nextPage = null;
            prevCompact = [];
          }
        } while (nextPage != null);
        added += evAdded;
        cdAddLog(`  ✓ +${evAdded} new results`, evAdded>0?'ok':'skip');
      } catch (err) {
        errors++;
        cdAddLog(`  ✗ FAILED: ${err.response?.data?.error || err.message}`, 'error');
      }
      setCdProgress({ current: i+1, total: eventsToFetch.length, added, skipped, errors });
      if (i < eventsToFetch.length-1 && !cdAbort.current) await new Promise(r => setTimeout(r, 1200));
    }

    cdAddLog(`════ DONE — ${added} new results · ${skipped} skipped · ${errors} errors ════`, errors>0?'warn':'ok');
    setCdPhase('done'); setCdRunning(false);
    await loadStoredMap();
    if (onComplete) onComplete({ newResults: added, eventsProcessed: eventsToFetch.length, skipped, errors });
    toast.success(`Smart Update done — ${added} new results saved`);
  }

  async function start() {
    if (isVercel === true) { startClientDriven(); return; }
    const needs = computeNeeds();
    if (!needs.length) { toast.success('All events are up-to-date'); return; }
    try {
      const res = await api.startAggregate(orgId, 1200, needs, false);
      if (!res.data.started) toast.error(res.data.message);
    } catch (err) { toast.error('Failed: ' + err.message); }
  }

  const running = isVercel === true ? cdRunning : !!sseState?.running;
  const phase   = isVercel === true ? cdPhase   : (sseState?.phase || 'idle');
  const total   = isVercel === true ? cdProgress.total   : (sseState?.total   || 0);
  const current = isVercel === true ? cdProgress.current : (sseState?.current || 0);
  const added   = isVercel === true ? cdProgress.added   : (sseState?.newResults || 0);
  const skipped = isVercel === true ? cdProgress.skipped : (sseState?.skipped || 0);
  const errors  = isVercel === true ? cdProgress.errors  : (sseState?.errors  || 0);
  const pct     = total > 0 ? Math.round(current/total*100) : 0;
  const log     = isVercel === true ? cdLog : sseLog;

  return {
    isVercel, running, phase, total, current, added, skipped, errors, pct, log,
    start, stop: () => { cdAbort.current = true; },
  };
}
