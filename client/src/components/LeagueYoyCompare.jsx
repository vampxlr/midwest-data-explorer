import React, { useEffect, useMemo, useState } from 'react';
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { api } from '../api.jsx';
import { toast } from 'react-hot-toast';
import SearchableSelect from './SearchableSelect.jsx';
import Collapsible from './Collapsible.jsx';

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
    return { count, slots: Array.from({ length: count }, (_, i) => parsed[i] || emptySlot()) };
  }
  const count = Math.min(MAX_SLOTS, Math.max(1, parsed?.count || DEFAULT_COUNT));
  return { count, slots: Array.from({ length: count }, (_, i) => (parsed?.slots && parsed.slots[i]) || emptySlot()) };
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

function PairChart({ currentEv, priorEv }) {
  const [seriesA, setSeriesA] = useState([]);
  const [seriesB, setSeriesB] = useState([]);
  const [loading, setLoading] = useState(true);

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

  const chartData = useMemo(() => {
    const map = {};
    for (const r of seriesA) {
      const mmdd = r.date.slice(5);
      if (!map[mmdd]) map[mmdd] = { mmdd, label: fmtMD(mmdd), A: 0, B: 0 };
      map[mmdd].A += r.total;
    }
    for (const r of seriesB) {
      const mmdd = r.date.slice(5);
      if (!map[mmdd]) map[mmdd] = { mmdd, label: fmtMD(mmdd), A: 0, B: 0 };
      map[mmdd].B += r.total;
    }
    const sorted = Object.values(map).sort((a, b) => a.mmdd.localeCompare(b.mmdd));
    let cumA = 0, cumB = 0;
    for (const d of sorted) { cumA += d.A; cumB += d.B; d.cumA = cumA; d.cumB = cumB; }
    return sorted;
  }, [seriesA, seriesB]);

  // "As of today" — clip the comparison to the same calendar day so a fully-
  // completed prior season isn't compared against a still-in-progress one.
  const todayMD     = todayCDT().slice(5);
  const yesterdayMD = shiftDay(todayCDT(), -1).slice(5);
  const asOfToday     = [...chartData].filter(d => d.mmdd <= todayMD).pop()     || null;
  const asOfYesterday = [...chartData].filter(d => d.mmdd <= yesterdayMD).pop() || null;

  const totalA = asOfToday ? asOfToday.cumA : 0;
  const totalB = asOfToday ? asOfToday.cumB : 0;
  const delta  = totalA - totalB;

  // Forecast: current count + the registrations the PRIOR season still gained
  // after this same calendar day. Scaled by current pace vs prior pace so a
  // hotter year projects higher. Only meaningful once the prior season has
  // finished and we have some current data.
  const priorFinal = chartData.length ? chartData[chartData.length - 1].cumB : 0;
  const priorRemaining = Math.max(0, priorFinal - totalB);
  const paceRatio = totalB > 0 ? totalA / totalB : 1;
  const projected = (totalA > 0 && priorFinal > totalB)
    ? Math.round(totalA + priorRemaining * Math.min(Math.max(paceRatio, 0.5), 2))
    : null;

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
          <ComposedChart data={chartData} margin={{ top:4, right:8, left:0, bottom:0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--viz-grid)" vertical={false} />
            <XAxis dataKey="label" stroke="var(--viz-grid)" tickLine={false} tick={{ fill:'var(--viz-axis)', fontSize:9 }}
              interval={Math.max(1, Math.floor(chartData.length/6))} />
            <YAxis stroke="transparent" tickLine={false} tick={{ fill:'var(--viz-axis)', fontSize:9 }} width={28} />
            <Tooltip contentStyle={{ background:'var(--bg-card)', border:'1px solid var(--line)', borderRadius:10, fontSize:11, boxShadow:'var(--shadow-md)' }} />
            {asOfYesterday && (
              <ReferenceLine x={asOfYesterday.label} stroke="var(--accent-2)" strokeDasharray="3 3"
                label={{ value:'Yesterday', position:'insideTopRight', fill:'var(--accent-2)', fontSize:9 }} />
            )}
            <Line type="monotone" dataKey="cumA" name="Selected" stroke="var(--viz-1)" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="cumB" name="Compared" stroke="var(--viz-muted)" strokeWidth={2} dot={false} strokeDasharray="4 3" />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      {!loading && (
        <div style={{ display:'flex', gap:14, marginTop:6, fontSize:11, color:'var(--text-4)', fontVariantNumeric:'tabular-nums', flexWrap:'wrap' }}>
          <span>Through today: <strong style={{ color:'var(--viz-1)' }}>{totalA}</strong></span>
          <span>Same day last yr: <strong style={{ color:'var(--text-3)' }}>{totalB}</strong></span>
          {projected !== null && (
            <span title="Current count + what the prior season still gained after this date, scaled by this year's pace">
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
  const { count, slots } = state;
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
            const compareOptions = eventOptions.filter(o => o.value !== slot.currentId);
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
                  onChange={v => updateSlot(i, { currentId: v, priorId: '' })}
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
            return <PairChart key={i} currentEv={currentEv} priorEv={priorEv} />;
          })}
        </div>
        {slots.every(s => !s.currentId || !s.priorId) && (
          <div className="no-data">Select leagues above to see comparison charts.</div>
        )}
      </div>
    </div>
  );
}
