import React, { useMemo, useState } from 'react';
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { api } from '../api.jsx';
import { toast } from 'react-hot-toast';

function classifyEvent(name = '') {
  const n = name.toLowerCase();
  if (/\btournament\b|\btourney\b/.test(n)) return 'tournament';
  if (/\bcamp\b|\bclinic\b|\bshooting\b|\bscoring\b|\bskills?\b|\btraining\b|\bacademy\b|\bdevelopment\b/.test(n)) return 'camp';
  return 'league';
}
function eventYear(reg) {
  const m = (reg.name || '').match(/\b(20\d{2})\b/);
  if (m) return Number(m[1]);
  const d = (reg.close || reg.open || '').slice(0, 4);
  return /^20\d{2}$/.test(d) ? Number(d) : null;
}
function stripYear(name = '') {
  return name.replace(/\b20\d{2}\b/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}
// Finds the same league/camp/tournament from an earlier year by matching the
// name with the year token stripped out (e.g. "2026 Blaine League" ~ "2025 Blaine League").
function findPriorYearMatch(ev, allRegs) {
  const base = stripYear(ev.name);
  const year = eventYear(ev);
  if (!base || !year) return null;
  let best = null, bestYear = -Infinity;
  for (const c of allRegs) {
    if (c.id === ev.id) continue;
    if (stripYear(c.name) !== base) continue;
    const cy = eventYear(c);
    if (!cy || cy >= year) continue;
    if (cy > bestYear) { bestYear = cy; best = c; }
  }
  return best;
}
function fmtMD(mmdd) {
  if (!mmdd) return '';
  return new Date(`2000-${mmdd}T12:00:00`).toLocaleDateString('en-US', { month:'short', day:'numeric' });
}

function PairCard({ pair }) {
  const { current, prior, seriesA, seriesB, loading } = pair;
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

  const totalA = chartData.length ? chartData[chartData.length - 1].cumA : 0;
  const totalB = chartData.length ? chartData[chartData.length - 1].cumB : 0;
  const delta  = totalA - totalB;

  return (
    <div style={{ background:'var(--surface-2)', border:'1px solid var(--line)', borderRadius:10, padding:'12px 14px' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', gap:8, marginBottom:6 }}>
        <div style={{ minWidth:0 }}>
          <div style={{ fontSize:13, color:'var(--text-1)', fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
            {current.name}
          </div>
          <div style={{ fontSize:11, color:'var(--text-4)' }}>
            {prior ? `vs ${prior.name}` : 'no prior-year match found'}
          </div>
        </div>
        {!loading && prior && (
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

      {!loading && prior && chartData.length > 0 && (
        <ResponsiveContainer width="100%" height={140}>
          <ComposedChart data={chartData} margin={{ top:4, right:8, left:0, bottom:0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--surface-1)" />
            <XAxis dataKey="label" stroke="var(--text-5)" tick={{ fill:'var(--text-4)', fontSize:9 }}
              interval={Math.max(1, Math.floor(chartData.length/6))} />
            <YAxis stroke="var(--text-5)" tick={{ fill:'var(--text-4)', fontSize:9 }} width={28} />
            <Tooltip contentStyle={{ background:'var(--surface-2)', border:'1px solid var(--line)', borderRadius:6, fontSize:11 }} />
            <Line type="monotone" dataKey="cumA" name="This year" stroke="#3b82f6" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="cumB" name="Prior year" stroke="var(--text-4)" strokeWidth={2} dot={false} strokeDasharray="4 3" />
          </ComposedChart>
        </ResponsiveContainer>
      )}

      {!loading && !prior && (
        <div style={{ height:140, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--text-5)', fontSize:12 }}>
          No matching event found from a prior year
        </div>
      )}

      {!loading && prior && (
        <div style={{ display:'flex', gap:14, marginTop:6, fontSize:11, color:'var(--text-4)' }}>
          <span>This year: <strong style={{ color:'#3b82f6' }}>{totalA}</strong></span>
          <span>Prior year: <strong style={{ color:'var(--text-3)' }}>{totalB}</strong></span>
        </div>
      )}
    </div>
  );
}

const N_OPTIONS = [5, 10];
const TYPE_OPTIONS = [
  { id: '',           label: 'All types' },
  { id: 'league',     label: 'League' },
  { id: 'camp',       label: 'Camp' },
  { id: 'tournament', label: 'Tournament' },
];

export default function LeagueYoyCompare({ recentRegs = [] }) {
  const [n,          setN]          = useState(5);
  const [customN,    setCustomN]    = useState('');
  const [typeFilter, setTypeFilter] = useState('league');
  const [pairs,       setPairs]      = useState(null); // null = not loaded yet
  const [loading,    setLoading]    = useState(false);

  const effectiveN = customN ? Math.max(1, Math.min(50, Number(customN) || 5)) : n;

  const topEvents = useMemo(() => {
    const maxDate = `${new Date().getFullYear() + 1}-12-31`;
    return (recentRegs || [])
      .filter(r => !typeFilter || classifyEvent(r.name) === typeFilter)
      .filter(r => (r.close || r.open || '0000') <= maxDate)
      .filter(r => (r.resultsCompleted || 0) > 0)
      .slice()
      .sort((a, b) => (b.close || b.open || '').localeCompare(a.close || a.open || ''))
      .slice(0, effectiveN);
  }, [recentRegs, typeFilter, effectiveN]);

  async function loadComparison() {
    if (!topEvents.length) { toast.error('No events match this filter'); return; }
    setLoading(true);
    const initial = topEvents.map(ev => ({
      current: ev, prior: findPriorYearMatch(ev, recentRegs), seriesA: [], seriesB: [], loading: true,
    }));
    setPairs(initial);

    const resolved = await Promise.all(initial.map(async p => {
      if (!p.prior) return { ...p, loading: false };
      try {
        const [a, b] = await Promise.all([
          api.reportDaily({ eventId: p.current.id }),
          api.reportDaily({ eventId: p.prior.id }),
        ]);
        return { ...p, seriesA: a.data.daily || [], seriesB: b.data.daily || [], loading: false };
      } catch {
        return { ...p, loading: false };
      }
    }));
    setPairs(resolved);
    setLoading(false);
  }

  return (
    <div className="card" style={{ marginBottom:20 }}>
      <h2 style={{ margin:'0 0 4px' }}>Year-over-Year Comparison — Top Leagues/Tournaments</h2>
      <p style={{ color:'var(--text-4)', fontSize:12, margin:'0 0 14px' }}>
        Pick how many of the most recent events to compare against their prior-year counterpart.
      </p>

      <div style={{ display:'flex', gap:16, flexWrap:'wrap', alignItems:'center', marginBottom:14 }}>
        <div style={{ display:'flex', gap:6, alignItems:'center' }}>
          <span style={{ fontSize:11, color:'var(--text-3)', fontWeight:600 }}>Show top:</span>
          {N_OPTIONS.map(opt => (
            <button key={opt} onClick={() => { setN(opt); setCustomN(''); }}
              style={{ padding:'4px 12px', borderRadius:20, fontSize:11, fontWeight:700, border:'none', cursor:'pointer',
                background: !customN && n===opt ? '#2563eb' : 'var(--surface-1)', color: !customN && n===opt ? '#fff' : 'var(--text-3)' }}>
              {opt}
            </button>
          ))}
          <input type="number" min={1} max={50} placeholder="custom N" value={customN}
            onChange={e => setCustomN(e.target.value)}
            style={{ width:80, padding:'4px 8px', borderRadius:20, fontSize:11, border:'1px solid var(--line)',
              background: customN ? '#2563eb22' : 'var(--surface-1)', color:'var(--text-2)', outline:'none' }} />
        </div>

        <div style={{ display:'flex', gap:6, alignItems:'center' }}>
          <span style={{ fontSize:11, color:'var(--text-3)', fontWeight:600 }}>Type:</span>
          {TYPE_OPTIONS.map(t => (
            <button key={t.id||'all'} onClick={() => setTypeFilter(t.id)}
              style={{ padding:'4px 12px', borderRadius:20, fontSize:11, fontWeight:700, border:'none', cursor:'pointer',
                background: typeFilter===t.id ? '#2563eb' : 'var(--surface-1)', color: typeFilter===t.id ? '#fff' : 'var(--text-3)' }}>
              {t.label}
            </button>
          ))}
        </div>

        <button className="btn-secondary" onClick={loadComparison} disabled={loading}>
          {loading ? '⏳ Loading…' : `📊 Compare ${topEvents.length} Event${topEvents.length!==1?'s':''}`}
        </button>
      </div>

      {pairs === null && <div className="no-data">Choose your filters and click Compare to load charts.</div>}

      {pairs !== null && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(280px, 1fr))', gap:12 }}>
          {pairs.map(p => <PairCard key={p.current.id} pair={p} />)}
        </div>
      )}
    </div>
  );
}
