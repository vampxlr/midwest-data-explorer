import React, { useEffect, useMemo, useState } from 'react';
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { api } from '../api.jsx';
import SearchableSelect from './SearchableSelect.jsx';
import Collapsible from './Collapsible.jsx';

const MAX_SLOTS     = 10;
const DEFAULT_COUNT = 5;
const COUNT_OPTIONS = Array.from({ length: MAX_SLOTS }, (_, i) => i + 1); // 1..10
const STORAGE_KEY   = 'mw3-dashboard-yoy-slots';

const emptySlot = () => ({ currentId: '', priorId: '' });

function loadSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { count: DEFAULT_COUNT, slots: Array.from({ length: DEFAULT_COUNT }, emptySlot) };
    const parsed = JSON.parse(raw);
    // Legacy format was a plain array of slots (always 5) — migrate gracefully.
    if (Array.isArray(parsed)) {
      const count = Math.min(MAX_SLOTS, Math.max(parsed.length, DEFAULT_COUNT));
      return { count, slots: Array.from({ length: count }, (_, i) => parsed[i] || emptySlot()) };
    }
    const count = Math.min(MAX_SLOTS, Math.max(1, parsed.count || DEFAULT_COUNT));
    return { count, slots: Array.from({ length: count }, (_, i) => (parsed.slots && parsed.slots[i]) || emptySlot()) };
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
            background: delta>=0 ? 'rgba(34,197,94,0.14)' : 'rgba(239,68,68,0.14)',
            color: delta>=0 ? '#22c55e' : '#ef4444',
          }}>
            {delta>=0?'▲':'▼'} {Math.abs(delta)}
          </span>
        )}
      </div>

      {loading && <div style={{ height:140, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--text-5)', fontSize:12 }}>Loading…</div>}

      {!loading && chartData.length > 0 && (
        <ResponsiveContainer width="100%" height={140}>
          <ComposedChart data={chartData} margin={{ top:4, right:8, left:0, bottom:0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--surface-1)" />
            <XAxis dataKey="label" stroke="var(--text-5)" tick={{ fill:'var(--text-4)', fontSize:9 }}
              interval={Math.max(1, Math.floor(chartData.length/6))} />
            <YAxis stroke="var(--text-5)" tick={{ fill:'var(--text-4)', fontSize:9 }} width={28} />
            <Tooltip contentStyle={{ background:'var(--surface-2)', border:'1px solid var(--line)', borderRadius:6, fontSize:11 }} />
            {asOfYesterday && (
              <ReferenceLine x={asOfYesterday.label} stroke="#f97316" strokeDasharray="3 3"
                label={{ value:'Yesterday', position:'insideTopRight', fill:'#f97316', fontSize:9 }} />
            )}
            <Line type="monotone" dataKey="cumA" name="Selected" stroke="#3b82f6" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="cumB" name="Compared" stroke="var(--text-4)" strokeWidth={2} dot={false} strokeDasharray="4 3" />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      {!loading && (
        <div style={{ display:'flex', gap:14, marginTop:6, fontSize:11, color:'var(--text-4)' }}>
          <span>Through today: <strong style={{ color:'#3b82f6' }}>{totalA}</strong></span>
          <span>Same day last yr: <strong style={{ color:'var(--text-3)' }}>{totalB}</strong></span>
        </div>
      )}
    </div>
  );
}

export default function LeagueYoyCompare({ recentRegs = [] }) {
  const [state, setState] = useState(loadSaved);
  const { count, slots } = state;

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
        <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:12 }}>
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
