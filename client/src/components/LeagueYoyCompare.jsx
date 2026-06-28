import React, { useEffect, useMemo, useState } from 'react';
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { api } from '../api.jsx';
import SearchableSelect from './SearchableSelect.jsx';

const SLOT_COUNT = 5;
const STORAGE_KEY = 'mw3-dashboard-yoy-slots';

function loadSavedSlots() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    const slots = Array.from({ length: SLOT_COUNT }, (_, i) => parsed[i] || { currentId: '', priorId: '' });
    return slots;
  } catch {
    return Array.from({ length: SLOT_COUNT }, () => ({ currentId: '', priorId: '' }));
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
  const [slots, setSlots] = useState(loadSavedSlots);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slots));
  }, [slots]);

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
    setSlots(prev => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s));
  }

  function clearSlot(i) {
    updateSlot(i, { currentId: '', priorId: '' });
  }

  return (
    <div className="card" style={{ marginBottom:20 }}>
      <h2 style={{ margin:'0 0 4px' }}>Year-over-Year Comparison</h2>
      <p style={{ color:'var(--text-4)', fontSize:12, margin:'0 0 14px' }}>
        Pick a league/camp/tournament, then pick what to compare it against. Your selections are saved.
      </p>

      <div style={{ display:'grid', gridTemplateColumns:`repeat(${SLOT_COUNT}, 1fr)`, gap:10 }}>
        {slots.map((slot, i) => {
          const compareOptions = eventOptions.filter(o => o.value !== slot.currentId);
          return (
            <div key={i} style={{ display:'flex', flexDirection:'column', gap:6 }}>
              <div style={{ display:'flex', alignItems:'center', gap:4 }}>
                <SearchableSelect
                  value={slot.currentId}
                  onChange={v => updateSlot(i, { currentId: v, priorId: '' })}
                  options={eventOptions}
                  placeholder={`Slot ${i+1}…`}
                  style={{ flex:1 }}
                />
                {slot.currentId && (
                  <button onClick={() => clearSlot(i)} title="Clear this slot"
                    style={{ background:'none', border:'none', color:'var(--text-4)', cursor:'pointer', fontSize:14, padding:'0 2px' }}>
                    ×
                  </button>
                )}
              </div>
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

      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(280px, 1fr))', gap:12, marginTop:18 }}>
        {slots.map((slot, i) => {
          if (!slot.currentId || !slot.priorId) return null;
          const currentEv = eventById[slot.currentId];
          const priorEv = eventById[slot.priorId];
          if (!currentEv || !priorEv) return null;
          return <PairChart key={i} currentEv={currentEv} priorEv={priorEv} />;
        })}
      </div>
    </div>
  );
}
