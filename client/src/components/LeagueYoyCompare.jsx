import React, { useEffect, useMemo, useState } from 'react';
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { api } from '../api.jsx';
import { toast } from 'react-hot-toast';
import SearchableSelect from './SearchableSelect.jsx';
import Collapsible from './Collapsible.jsx';
import { DeadlineToggle, useDeadlinesOn, useDeadlineMap, nearestLabel } from '../deadlines.jsx';

const MAX_SLOTS     = 10;
const DEFAULT_COUNT = 5;
const COUNT_OPTIONS = Array.from({ length: MAX_SLOTS }, (_, i) => i + 1); // 1..10
const STORAGE_KEY   = 'mw3-dashboard-yoy-slots';

const emptySlot = () => ({ currentId: '', priorId: '' });

const PREF_KEY = 'yoy-slots';

function normalizeState(parsed) {
  // Legacy format was a plain array of slots (always 5) — migrate gracefully.
  if (Array.isArray(parsed)) {
    const count = Math.min(MAX_SLOTS, Math.max(parsed.length, DEFAULT_COUNT));
    return { count, aiAssist: true, slots: Array.from({ length: count }, (_, i) => parsed[i] || emptySlot()) };
  }
  const count = Math.min(MAX_SLOTS, Math.max(1, parsed?.count || DEFAULT_COUNT));
  return {
    count,
    aiAssist: parsed?.aiAssist !== false, // default ON
    slots: Array.from({ length: count }, (_, i) => (parsed?.slots && parsed.slots[i]) || emptySlot()),
  };
}

// ── AI-assist matching ─────────────────────────────────────────────────────────
// Finds the prior-season counterpart of a league even when names differ
// ("2026 Wayzata…" vs "Wayzata…", Legacy Hoops "Session 1/2"). Combines
// name-token similarity, session-number agreement, and season-date proximity
// (counterparts run ~N whole years apart on the calendar).
const STOPWORDS = new Set(['the','of','and','a','an','in','on','at','registration','league','leagues','basketball']);
function nameTokens(name = '') {
  return name.toLowerCase()
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w && !STOPWORDS.has(w));
}
function sessionNum(name = '') {
  const m = name.match(/session\s*(\d+)/i);
  return m ? m[1] : null;
}
// Words that DON'T identify a location/program — anything else (Wayzata,
// Woodbury, Chanhassen, Brainerd…) is treated as distinctive, and two events
// whose distinctive words don't overlap at all are almost never counterparts.
const GENERIC = new Set(['legacy','hoops','session','sessions','spring','summer','fall','winter',
  'annual','camp','clinic','tournament','tourney','boys','girls','grade','august','play','game',
  'skills','shooting','scoring','training','academy','development','hub','site','new','v']);
export function matchScore(cur, cand) {
  const tA = nameTokens(cur.name), tB = new Set(nameTokens(cand.name));
  let inter = 0;
  for (const t of new Set(tA)) if (tB.has(t)) inter++;
  const union = new Set([...tA, ...tB]).size || 1;
  let s = inter / union;                                   // token similarity 0..1
  const distA = new Set(tA.filter(t => /[a-z]/.test(t) && !GENERIC.has(t)));
  const distB = new Set([...tB].filter(t => /[a-z]/.test(t) && !GENERIC.has(t)));
  if (distA.size && distB.size && ![...distA].some(t => distB.has(t))) s -= 0.8; // Woodbury ≠ Hopkins
  else if (distA.size && !distB.size) s -= 0.2;            // location-less candidate is a weaker match
  const sA = sessionNum(cur.name), sB = sessionNum(cand.name);
  if (sA !== null && sB !== null) s += (sA === sB ? 0.15 : -0.5); // sessions must agree
  const dA = new Date(cur.close || cur.open || 0), dB = new Date(cand.close || cand.open || 0);
  if (!isNaN(dA.getTime()) && !isNaN(dB.getTime()) && dB < dA) {
    const days = (dA - dB) / 86400000;
    const yearGap = Math.round(days / 365.25);
    const drift = Math.abs(days - yearGap * 365.25);       // same time of year?
    if (yearGap >= 1 && drift < 45) s += 0.25;
    else if (yearGap >= 1 && drift < 90) s += 0.12;
    s -= 0.06 * Math.max(0, yearGap - 1);                  // prefer the most recent season
  }
  return s;
}
export function findPriorMatch(cur, regs) {
  const dCur = new Date(cur.close || cur.open || 0);
  let best = null, bestScore = 0;
  for (const cand of regs) {
    if (String(cand.id) === String(cur.id)) continue;
    const dC = new Date(cand.close || cand.open || 0);
    if (isNaN(dC.getTime()) || dC >= dCur) continue;       // must be an EARLIER season
    const s = matchScore(cur, cand);
    if (s > bestScore) { bestScore = s; best = cand; }
  }
  return bestScore >= 0.5 ? best : null;
}

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { count: DEFAULT_COUNT, slots: Array.from({ length: DEFAULT_COUNT }, emptySlot) };
    return normalizeState(JSON.parse(raw));
  } catch {
    return { count: DEFAULT_COUNT, slots: Array.from({ length: DEFAULT_COUNT }, emptySlot) };
  }
}

function fmtMD(mmdd) {
  if (!mmdd) return '';
  return new Date(`2000-${mmdd}T12:00:00`).toLocaleDateString('en-US', { month:'short', day:'numeric' });
}
function todayCDT() {
  return new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
}
function shiftDay(dateStr, delta) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function PairChart({ currentEv, priorEv, deadlines }) {
  const [seriesA, setSeriesA] = useState([]);
  const [seriesB, setSeriesB] = useState([]);
  const [loading, setLoading] = useState(true);
  const showDeadlines = useDeadlinesOn();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.reportDaily({ eventId: currentEv.id }),
      api.reportDaily({ eventId: priorEv.id }),
    ]).then(([a, b]) => {
      if (cancelled) return;
      setSeriesA(a.data.daily || []);
      setSeriesB(b.data.daily || []);
      setLoading(false);
    }).catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [currentEv.id, priorEv.id]);

  const todayMD     = todayCDT().slice(5);
  const yesterdayMD = shiftDay(todayCDT(), -1).slice(5);

  // ── Deadline-anchored projection ──────────────────────────────────────────
  // Registrations spike on early-bird and final-deadline days, but the prior
  // season's deadlines fall on DIFFERENT calendar dates. So the prior curve
  // is used as a template and time-warped so its spikes land on THIS season's
  // scraped EB/FR dates. The prior season's own deadline days are detected
  // from its graph — its two largest single-day jumps.
  const { plotData, projected, priorFinal, totalA, totalB } = useMemo(() => {
    const dayNum  = (mmdd) => Math.round((new Date(`2000-${mmdd}T12:00:00Z`) - new Date('2000-01-01T12:00:00Z')) / 86400000);
    const numDay  = (n) => new Date(new Date('2000-01-01T12:00:00Z').getTime() + n * 86400000).toISOString().slice(5, 10);

    const addA = {}, addB = {};
    for (const r of seriesA) addA[r.date.slice(5)] = (addA[r.date.slice(5)] || 0) + r.total;
    for (const r of seriesB) addB[r.date.slice(5)] = (addB[r.date.slice(5)] || 0) + r.total;
    const keys = [...new Set([...Object.keys(addA), ...Object.keys(addB)])].sort();
    if (!keys.length) return { plotData: [], projected: null, priorFinal: 0, totalA: 0, totalB: 0 };

    const yNum = dayNum(yesterdayMD), tNum = dayNum(todayMD);
    const dMin = dayNum(keys[0]);
    const lastBNum = dayNum([...Object.keys(addB)].sort().pop() || keys[keys.length - 1]);
    const lastANum = dayNum([...Object.keys(addA)].sort().pop() || keys[0]);

    // Prior-season anchors = its two biggest single-day jumps, in date order
    const bSpikes = Object.entries(addB).sort((a, b) => b[1] - a[1]).slice(0, 2)
      .map(([d]) => dayNum(d)).sort((a, b) => a - b);
    const pEB = bSpikes[0], pFR = bSpikes[1], pEnd = lastBNum;
    // Current-season anchors = scraped deadlines
    const cEB = deadlines?.earlyBird     ? dayNum(deadlines.earlyBird.slice(5))     : null;
    const cFR = deadlines?.finalDeadline ? dayNum(deadlines.finalDeadline.slice(5)) : null;

    const canWarp = cEB != null && cFR != null && pEB != null && pFR != null &&
                    cEB < cFR && pEB < pFR && pFR <= pEnd;
    const cEnd = canWarp ? cFR + (pEnd - pFR) : Math.max(lastBNum, lastANum);
    const dMax = Math.max(lastBNum, lastANum, cEnd, tNum);

    // Daily grid with cumulative sums
    const rows = [];
    let cumA = 0, cumB = 0;
    for (let n = dMin; n <= dMax; n++) {
      const mmdd = numDay(n);
      cumA += addA[mmdd] || 0;
      cumB += addB[mmdd] || 0;
      rows.push({ n, mmdd, label: fmtMD(mmdd), cumA, cumB });
    }
    const at = (n) => rows[Math.min(Math.max(n - dMin, 0), rows.length - 1)];
    const yA = at(yNum).cumA, yB0 = at(yNum).cumB;
    const priorFinalV = at(pEnd).cumB;

    // Piecewise warp: current day → equivalent prior-season day
    const aStart = dayNum([...Object.keys(addA)].sort()[0] || keys[0]);
    const bStart = dayNum([...Object.keys(addB)].sort()[0] || keys[0]);
    const anchors = canWarp
      ? [[Math.min(aStart, cEB - 1), Math.min(bStart, pEB - 1)], [cEB, pEB], [cFR, pFR], [cEnd, pEnd]]
      : null;
    const warp = (n) => {
      if (!anchors) return n;
      for (let i = 1; i < anchors.length; i++) {
        const [c0, p0] = anchors[i - 1], [c1, p1] = anchors[i];
        if (n <= c1 || i === anchors.length - 1) {
          const f = c1 === c0 ? 1 : (n - c0) / (c1 - c0);
          return p0 + f * (p1 - p0);
        }
      }
      return pEnd;
    };
    const priorCumAt = (p) => {           // linear interp of cumB at (fractional) prior day
      const lo = at(Math.floor(p)), hi = at(Math.ceil(p));
      return lo.cumB + (hi.cumB - lo.cumB) * (p - Math.floor(p));
    };

    const baseline = priorCumAt(Math.min(warp(yNum), pEnd));
    let projectedV = null;
    for (const r of rows) {
      if (r.n > tNum)  r.cumA = undefined;                       // don't draw current line into the future
      if (r.n > pEnd)  r.cumB = undefined;
      if (yA > 0 && priorFinalV > 0 && r.n >= yNum) {
        const p = Math.min(warp(r.n), pEnd);
        r.proj = Math.round(yA + Math.max(0, priorCumAt(p) - baseline));
        projectedV = r.proj;                                     // last one = projected finish
      }
    }
    const asToday = at(Math.min(tNum, dMax));
    return { plotData: rows, projected: projectedV, priorFinal: priorFinalV, totalA: asToday.cumA ?? yA, totalB: asToday.cumB };
  }, [seriesA, seriesB, deadlines, todayMD, yesterdayMD]);

  const chartData = plotData;
  const delta = totalA - totalB;
  const asOfYesterday = chartData.find(d => d.mmdd === yesterdayMD) || null;

  return (
    <div style={{ background:'var(--surface-2)', border:'1px solid var(--line)', borderRadius:10, padding:'12px 14px' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:8, marginBottom:6 }}>
        <div style={{ minWidth:0 }}>
          <div style={{ fontSize:13, color:'var(--text-1)', fontWeight:600, lineHeight:1.3 }}>
            {currentEv.name}
          </div>
          <div style={{ fontSize:11, color:'var(--text-4)' }}>vs {priorEv.name}</div>
        </div>
        {!loading && (
          <span style={{
            flexShrink:0, fontSize:12, fontWeight:700, borderRadius:14, padding:'2px 9px',
            fontVariantNumeric:'tabular-nums',
            background: delta>=0 ? 'rgba(34,197,94,0.14)' : 'rgba(239,68,68,0.14)',
            color: delta>=0 ? 'var(--viz-up)' : 'var(--viz-down)',
          }}>
            {delta>=0?'▲':'▼'} {Math.abs(delta)}
          </span>
        )}
      </div>

      {loading && <div style={{ height:140, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--text-5)', fontSize:12 }}>Loading…</div>}

      {!loading && chartData.length > 0 && (
        <ResponsiveContainer width="100%" height={140}>
          <ComposedChart data={plotData} margin={{ top:4, right:8, left:0, bottom:0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--viz-grid)" vertical={false} />
            <XAxis dataKey="label" stroke="var(--viz-grid)" tickLine={false} tick={{ fill:'var(--viz-axis)', fontSize:9 }}
              interval={Math.max(1, Math.floor(chartData.length/6))} />
            <YAxis stroke="transparent" tickLine={false} tick={{ fill:'var(--viz-axis)', fontSize:9 }} width={28} />
            <Tooltip contentStyle={{ background:'var(--bg-card)', border:'1px solid var(--line)', borderRadius:10, fontSize:11, boxShadow:'var(--shadow-md)' }} />
            {asOfYesterday && (
              <ReferenceLine x={asOfYesterday.label} stroke="var(--accent-2)" strokeDasharray="3 3"
                label={{ value:'Yesterday', position:'insideTopRight', fill:'var(--accent-2)', fontSize:9 }} />
            )}
            {/* Registration deadlines (scraped from midwest3on3.com) — snap to nearest data point */}
            {showDeadlines && deadlines?.earlyBird && nearestLabel(chartData, deadlines.earlyBird) && (
              <ReferenceLine x={nearestLabel(chartData, deadlines.earlyBird)} stroke="var(--viz-2)" strokeDasharray="4 3"
                label={{ value:'EB', position:'insideTop', fill:'var(--viz-2)', fontSize:9 }} />
            )}
            {showDeadlines && deadlines?.finalDeadline && nearestLabel(chartData, deadlines.finalDeadline) && (
              <ReferenceLine x={nearestLabel(chartData, deadlines.finalDeadline)} stroke="var(--viz-6)" strokeDasharray="4 3"
                label={{ value:'Final', position:'insideTop', fill:'var(--viz-6)', fontSize:9 }} />
            )}
            <Line type="monotone" dataKey="cumA" name="Selected" stroke="var(--viz-1)" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="cumB" name="Compared" stroke="var(--viz-muted)" strokeWidth={2} dot={false} strokeDasharray="4 3" />
            {projected !== null && (
              <Line type="monotone" dataKey="proj" name="Projected" stroke="var(--accent-2)" strokeWidth={2} dot={false} strokeDasharray="2 5" />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      )}

      {!loading && (
        <div style={{ display:'flex', gap:14, marginTop:6, fontSize:11, color:'var(--text-4)', fontVariantNumeric:'tabular-nums', flexWrap:'wrap' }}>
          <span>Through today: <strong style={{ color:'var(--viz-1)' }}>{totalA}</strong></span>
          <span>Same day last yr: <strong style={{ color:'var(--text-3)' }}>{totalB}</strong></span>
          {projected !== null && (
            <span title="Count through yesterday + what the prior season still gained after the same date (prior-year extrapolation only)">
              🔮 Projected finish: <strong style={{ color:'var(--accent-2)' }}>~{projected}</strong>
              <span style={{ color:'var(--text-4)' }}> (prior: {priorFinal})</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default function LeagueYoyCompare({ recentRegs = [] }) {
  // localStorage paints instantly; the server copy is the source of truth so
  // selections survive across devices, browsers, and localhost vs production.
  const [state, setState] = useState(loadSaved);
  const { count, slots, aiAssist } = state;
  const deadlineMap = useDeadlineMap();
  const hydratedRef = React.useRef(false);
  const saveTimerRef = React.useRef(null);

  // Hydrate from the server once on mount — server wins over the local cache.
  useEffect(() => {
    let cancelled = false;
    api.getPref(PREF_KEY).then(res => {
      if (cancelled || !res.data?.value) { hydratedRef.current = true; return; }
      try {
        const server = normalizeState(JSON.parse(res.data.value));
        const hasContent = server.slots.some(s => s.currentId);
        if (hasContent) setState(server);
      } catch {}
      hydratedRef.current = true;
    }).catch(() => { hydratedRef.current = true; });
    return () => { cancelled = true; };
  }, []);

  // Persist on change: localStorage immediately, server debounced 800ms.
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    if (!hydratedRef.current) return; // don't echo the initial cache back over the server copy
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      api.setPref(PREF_KEY, state).catch(() => {});
    }, 800);
    return () => clearTimeout(saveTimerRef.current);
  }, [state]);

  function setCount(newCount) {
    setState(prev => ({
      count: newCount,
      slots: Array.from({ length: newCount }, (_, i) => prev.slots[i] || emptySlot()),
    }));
  }

  const eventOptions = useMemo(() => {
    return (recentRegs || [])
      .slice()
      .sort((a, b) => (b.close || b.open || '').localeCompare(a.close || a.open || ''))
      .map(r => ({ value: String(r.id), label: r.name }));
  }, [recentRegs]);

  const eventById = useMemo(() => {
    const m = {};
    for (const r of (recentRegs || [])) m[String(r.id)] = r;
    return m;
  }, [recentRegs]);

  function updateSlot(i, patch) {
    setState(prev => ({ ...prev, slots: prev.slots.map((s, idx) => idx === i ? { ...s, ...patch } : s) }));
  }

  // AI assist: picking a league auto-selects its prior-season counterpart.
  function pickCurrent(i, currentId) {
    let priorId = '';
    if (aiAssist && currentId) {
      const cur = eventById[String(currentId)];
      const match = cur ? findPriorMatch(cur, recentRegs) : null;
      if (match) priorId = String(match.id);
    }
    updateSlot(i, { currentId, priorId });
  }

  // Compare dropdown ordered by match quality when AI assist is on:
  // prior-year counterpart first, then two years back, etc.
  function compareOptionsFor(slot) {
    const base = eventOptions.filter(o => o.value !== slot.currentId);
    if (!aiAssist || !slot.currentId) return base;
    const cur = eventById[String(slot.currentId)];
    if (!cur) return base;
    return base
      .map(o => ({ o, s: matchScore(cur, eventById[o.value] || { name: o.label }) }))
      .sort((a, b) => b.s - a.s)
      .map(x => x.o);
  }

  function clearSlot(i) {
    updateSlot(i, { currentId: '', priorId: '' });
  }

  // ── Config file export / import — a portable backup of the comparison setup.
  // The file also carries event names so it stays human-readable.
  function exportConfig() {
    const payload = {
      app: 'midwest-3on3-data-explorer',
      kind: 'dashboard-config',
      exportedAt: new Date().toISOString(),
      yoySlots: {
        count,
        slots: slots.map(s => ({
          ...s,
          currentName: eventById[s.currentId]?.name || undefined,
          priorName:   eventById[s.priorId]?.name   || undefined,
        })),
      },
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `mw3-dashboard-config-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Config downloaded');
  }

  function importConfig(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        // Accept our export format, a bare {count,slots} state, or the legacy array.
        const raw = parsed?.yoySlots ?? parsed;
        const clean = s => ({ currentId: String(s?.currentId || ''), priorId: String(s?.priorId || '') });
        const next = normalizeState(Array.isArray(raw)
          ? raw.map(clean)
          : { count: raw?.count, slots: (raw?.slots || []).map(clean) });
        if (!next.slots.some(s => s.currentId)) {
          toast.error('No slot selections found in that file');
          return;
        }
        hydratedRef.current = true; // ensure the debounced save pushes to the server
        setState(next);
        const pairs = next.slots.filter(s => s.currentId && s.priorId).length;
        toast.success(`Imported ${pairs} comparison pair(s)`);
      } catch {
        toast.error('Not a valid config file');
      }
    };
    reader.readAsText(file);
  }

  return (
    <div style={{ marginBottom:20 }}>
      <h2 style={{ fontSize:15, fontWeight:700, color:'var(--text-1)', letterSpacing:'-0.2px', margin:'0 0 12px' }}>
        Year-over-Year Comparison
      </h2>

      <Collapsible
        title="Select Leagues to Compare"
        subtitle="Pick a league/camp/tournament, then pick what to compare it against. Your selections are saved."
        defaultOpen
      >
        <div style={{ display:'flex', justifyContent:'flex-end', alignItems:'center', gap:10, flexWrap:'wrap', marginBottom:12 }}>
          <DeadlineToggle />
          <button onClick={() => setState(prev => ({ ...prev, aiAssist: !prev.aiAssist }))}
            title="When ON: picking a league auto-selects its prior-season counterpart (matched by name, session number, and season timing), and the compare dropdown is ordered best-match-first"
            style={{ padding:'5px 12px', borderRadius:8, fontSize:11, fontWeight:700, cursor:'pointer',
              border: aiAssist ? '1px solid rgba(168,85,247,0.5)' : '1px solid var(--border)',
              background: aiAssist ? 'rgba(168,85,247,0.12)' : 'var(--bg-hover)',
              color: aiAssist ? '#a855f7' : 'var(--text-3)' }}>
            ✨ AI assist {aiAssist ? 'ON' : 'OFF'}
          </button>
          <button onClick={exportConfig}
            title="Download the current comparison setup as a JSON file"
            style={{ padding:'5px 12px', borderRadius:8, fontSize:11, fontWeight:600, border:'1px solid var(--border)',
              background:'var(--bg-hover)', color:'var(--text-2)', cursor:'pointer' }}>
            ⬇ Export config
          </button>
          <label
            title="Restore a previously downloaded config file"
            style={{ padding:'5px 12px', borderRadius:8, fontSize:11, fontWeight:600, border:'1px solid var(--border)',
              background:'var(--bg-hover)', color:'var(--text-2)', cursor:'pointer' }}>
            ⬆ Import config
            <input type="file" accept=".json,application/json" style={{ display:'none' }}
              onChange={e => { const f = e.target.files?.[0]; if (f) importConfig(f); e.target.value = ''; }} />
          </label>
          <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, color:'var(--text-3)', fontWeight:600 }}>
            Slots:
            <select value={count} onChange={e => setCount(Number(e.target.value))}
              style={{ background:'var(--surface-1)', border:'1px solid var(--line)', color:'var(--text-1)', borderRadius:6, padding:'4px 8px', fontSize:12 }}>
              {COUNT_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        </div>

        <div className="yoy-slot-grid">
          {slots.map((slot, i) => {
            const compareOptions = compareOptionsFor(slot);
            return (
              <div key={i} style={{
                display:'flex', flexDirection:'column', gap:8,
                background:'var(--surface-2)', border:'1px solid var(--line)', borderRadius:10, padding:'10px 12px',
              }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                  <span style={{ fontSize:10, color:'var(--text-4)', fontWeight:700, textTransform:'uppercase', letterSpacing:'0.5px' }}>
                    Slot {i+1}
                  </span>
                  {slot.currentId && (
                    <button onClick={() => clearSlot(i)} title="Clear this slot"
                      style={{ background:'none', border:'none', color:'var(--text-4)', cursor:'pointer', fontSize:14, padding:'0 2px' }}>
                      ×
                    </button>
                  )}
                </div>
                <SearchableSelect
                  value={slot.currentId}
                  onChange={v => pickCurrent(i, v)}
                  options={eventOptions}
                  placeholder="Select league…"
                />
                {slot.currentId && (
                  <SearchableSelect
                    value={slot.priorId}
                    onChange={v => updateSlot(i, { priorId: v })}
                    options={compareOptions}
                    placeholder="Compare with…"
                  />
                )}
              </div>
            );
          })}
        </div>
      </Collapsible>

      <div className="card" style={{ marginTop:16 }}>
        <div className="grid-3">
          {slots.map((slot, i) => {
            if (!slot.currentId || !slot.priorId) return null;
            const currentEv = eventById[slot.currentId];
            const priorEv = eventById[slot.priorId];
            if (!currentEv || !priorEv) return null;
            return <PairChart key={i} currentEv={currentEv} priorEv={priorEv} deadlines={deadlineMap[String(currentEv.id)]} />;
          })}
        </div>
        {slots.every(s => !s.currentId || !s.priorId) && (
          <div className="no-data">Select leagues above to see comparison charts.</div>
        )}
      </div>
    </div>
  );
}
