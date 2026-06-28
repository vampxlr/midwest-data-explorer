import React, { useEffect, useMemo, useState } from 'react';
import {
  ComposedChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, Cell,
} from 'recharts';
import { api } from '../api.jsx';
import { toast } from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';
import useSmartUpdate from '../hooks/useSmartUpdate.js';
import SmartUpdateBar from '../components/SmartUpdateBar.jsx';
import SmartUpdateLog from '../components/SmartUpdateLog.jsx';
import Collapsible from '../components/Collapsible.jsx';
import LeagueYoyCompare from '../components/LeagueYoyCompare.jsx';

const COLORS = ['#3b82f6','#f97316','#22c55e','#a855f7','#ec4899','#14b8a6','#eab308','#06b6d4','#f43f5e','#84cc16'];
const YEAR_COLORS = { '2023':'var(--text-3)','2024':'#a855f7','2025':'#f97316','2026':'#3b82f6','2027':'#22c55e','2028':'#ec4899' };

const ChartTip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background:'var(--surface-2)', border:'1px solid var(--line)', borderRadius:8, padding:'10px 14px', boxShadow:'0 8px 24px rgba(0,0,0,0.4)' }}>
      <p style={{ color:'var(--text-2)', fontSize:12, marginBottom:4 }}>{label}</p>
      {payload.map((p,i)=>(
        <p key={i} style={{ color:p.color||'var(--accent-light)', fontSize:13, fontWeight:700, margin:'2px 0' }}>{p.name}: {p.value}</p>
      ))}
    </div>
  );
};

// Mirrors classifyEvent() in convex/serverSync.ts — leagues are anything that
// isn't explicitly a camp/clinic or tournament.
function classifyEvent(name = '') {
  const n = name.toLowerCase();
  if (/\btournament\b|\btourney\b/.test(n)) return 'tournament';
  if (/\bcamp\b|\bclinic\b|\bshooting\b|\bscoring\b|\bskills?\b|\btraining\b|\bacademy\b|\bdevelopment\b/.test(n)) return 'camp';
  return 'league';
}

function fmtDate(d) {
  if (!d) return '—';
  return d.slice(0, 10);
}

export default function Dashboard({ ctx }) {
  const { orgId, recentRegs, setSelectedReg, refreshToken, onAggComplete } = ctx;
  const navigate = useNavigate();

  const [yoyDaily, setYoyDaily]   = useState(null);
  const [yoyLoading, setYoyLoading] = useState(false);
  const [recent, setRecent] = useState(null);
  const [storeStatus, setStoreStatus] = useState(null);

  const smartUpdate = useSmartUpdate({
    orgId, recentRegs,
    onComplete: async (d) => {
      if (onAggComplete) await onAggComplete(d);
      loadYoyDaily();
      loadRecentStats();
    },
  });

  useEffect(() => { loadYoyDaily(); loadRecentStats(); }, [refreshToken]);

  async function loadYoyDaily() {
    setYoyLoading(true);
    try {
      const res = await api.reportYoyDaily();
      setYoyDaily(res.data);
    } catch (err) { toast.error('Failed to load YoY data: ' + err.message); }
    finally { setYoyLoading(false); }
  }

  async function loadRecentStats() {
    try {
      const [r, s] = await Promise.all([api.reportRecent(), api.storeStatus()]);
      setRecent(r.data);
      setStoreStatus(s.data);
    } catch {}
  }

  // ── Most recent leagues (by close/open date, newest first) ──────────────
  // Skip records with implausible dates (typos like a 2040 close date) so they
  // don't crowd out genuinely recent leagues at the top of the list.
  const recentLeagues = useMemo(() => {
    const maxDate = `${new Date().getFullYear() + 1}-12-31`;
    return (recentRegs || [])
      .filter(r => classifyEvent(r.name) === 'league')
      .filter(r => (r.close || r.open || '0000') <= maxDate)
      .slice()
      .sort((a, b) => (b.close || b.open || '').localeCompare(a.close || a.open || ''))
      .slice(0, 8);
  }, [recentRegs]);

  // ── Year-over-year cumulative pace for leagues, latest two seasons ──────
  // Some event records have typo'd dates (e.g. close dates in the 2040s), which
  // can produce spurious "season years". Restrict to a sane window around today
  // so the comparison always lines up the current season against the prior one.
  const [yearA, yearB] = useMemo(() => {
    const thisYear = new Date().getFullYear();
    const years = [...(yoyDaily?.years || [])]
      .filter(y => /^20\d{2}$/.test(y) && Number(y) >= thisYear - 5 && Number(y) <= thisYear + 1)
      .sort()
      .reverse();
    return [years[0], years[1]];
  }, [yoyDaily]);

  const paceChartData = useMemo(() => {
    if (!yoyDaily || !yearA) return [];
    const dayMap = {};
    for (const y of [yearA, yearB].filter(Boolean)) {
      for (const pt of (yoyDaily.byYear[y]?.cumByDay || [])) {
        if (!dayMap[pt.day]) dayMap[pt.day] = { day: pt.day, date: pt.date };
        dayMap[pt.day][`${y}_val`] = pt.cumLeague;
      }
    }
    return Object.values(dayMap).sort((a,b) => a.day - b.day);
  }, [yoyDaily, yearA, yearB]);

  const totalA = yearA ? (yoyDaily?.byYear[yearA]?.totals?.league ?? 0) : 0;
  const totalB = yearB ? (yoyDaily?.byYear[yearB]?.totals?.league ?? 0) : 0;
  const yoyDelta = yearB ? totalA - totalB : null;
  const yoyPct = (yearB && totalB > 0) ? ((totalA - totalB) / totalB * 100) : null;

  // Same-point-in-season comparison: how far has yearA progressed vs where
  // yearB stood on the same day-of-year (fair "pace" comparison).
  const paceComparison = useMemo(() => {
    if (!yoyDaily || !yearA || !yearB) return null;
    const aPts = yoyDaily.byYear[yearA]?.cumByDay || [];
    const bPts = yoyDaily.byYear[yearB]?.cumByDay || [];
    if (!aPts.length) return null;
    const lastDay = aPts[aPts.length - 1]?.day;
    const aVal = aPts[aPts.length - 1]?.cumLeague ?? 0;
    const bMatch = [...bPts].reverse().find(p => p.day <= lastDay);
    const bVal = bMatch?.cumLeague ?? 0;
    return { lastDay, aVal, bVal, delta: aVal - bVal, pct: bVal > 0 ? ((aVal - bVal) / bVal * 100) : null };
  }, [yoyDaily, yearA, yearB]);

  return (
    <div>
      <div className="page-header">
        <h1>Dashboard — Recent Leagues</h1>
        <p>Midwest 3 on 3 · registration trends for recent leagues, {yearA || 'this year'} vs {yearB || 'last year'}</p>
      </div>

      {/* ── Quick glance: Smart Update + recent activity ──────────────────── */}
      <SmartUpdateBar {...smartUpdate} />

      <div className="grid-4" style={{ marginBottom:20 }}>
        <div className="stat-card">
          <div className="stat-label">Today (CDT)</div>
          <div className="stat-value" style={{color:'#22c55e'}}>{recent?.today ?? '—'}</div>
          <div className="stat-sub">new registrations</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Yesterday</div>
          <div className="stat-value" style={{color:'var(--accent-light)'}}>{recent?.yesterday ?? '—'}</div>
          <div className="stat-sub">registrations</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">This Month</div>
          <div className="stat-value" style={{color:'#f97316'}}>{recent?.thisMonth ?? '—'}</div>
          <div className="stat-sub">registrations</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Total in Store</div>
          <div className="stat-value" style={{color:'#a855f7'}}>{storeStatus?.totalResults ?? '—'}</div>
          <div className="stat-sub">{storeStatus?.totalEvents ?? '?'} events</div>
        </div>
      </div>

      <div className="grid-4" style={{ marginBottom:20 }}>
        <div className="stat-card">
          <div className="stat-label">{yearA || '—'} League Registrations</div>
          <div className="stat-value" style={{color:YEAR_COLORS[yearA]||'var(--accent-light)'}}>{yoyLoading?'…':totalA}</div>
          <div className="stat-sub">year to date</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">{yearB || '—'} League Registrations</div>
          <div className="stat-value" style={{color:YEAR_COLORS[yearB]||'var(--text-2)'}}>{yoyLoading?'…':totalB}</div>
          <div className="stat-sub">full season</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">YoY Change (full totals)</div>
          <div className="stat-value" style={{color: yoyDelta>=0 ? '#22c55e' : '#ef4444'}}>
            {yoyLoading ? '…' : (yoyDelta===null ? '—' : `${yoyDelta>=0?'+':''}${yoyDelta}`)}
          </div>
          <div className="stat-sub">{yoyPct!==null ? `${yoyPct>=0?'+':''}${yoyPct.toFixed(1)}%` : ''}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Pace vs Same Point Last Year</div>
          <div className="stat-value" style={{color: paceComparison?.delta>=0 ? '#22c55e' : '#ef4444'}}>
            {yoyLoading ? '…' : (paceComparison ? `${paceComparison.delta>=0?'+':''}${paceComparison.delta}` : '—')}
          </div>
          <div className="stat-sub">
            {paceComparison ? `day ${paceComparison.lastDay} · ${paceComparison.aVal} vs ${paceComparison.bVal}` : ''}
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom:20 }}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',flexWrap:'wrap',gap:8,marginBottom:4}}>
          <h2 style={{margin:0}}>League Registration Pace — {yearA || '—'} vs {yearB || '—'}</h2>
          <button onClick={loadYoyDaily} style={{fontSize:11,color:'var(--text-4)',background:'none',border:'none',cursor:'pointer'}}>↻ Refresh</button>
        </div>
        <p style={{color:'var(--text-4)',fontSize:12,margin:'0 0 14px'}}>
          Cumulative league registrations by day of year — same calendar date lines up across seasons so the curves are directly comparable.
        </p>

        {yoyLoading && <div className="no-data">Loading year-over-year pace…</div>}

        {!yoyLoading && paceChartData.length > 0 && (
          <ResponsiveContainer width="100%" height={320}>
            <ComposedChart data={paceChartData} margin={{top:8,right:16,left:0,bottom:30}}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--surface-1)"/>
              <XAxis dataKey="date" stroke="var(--text-5)" tick={{fill:'var(--text-3)',fontSize:10}}
                angle={-35} textAnchor="end" interval={Math.max(1, Math.floor(paceChartData.length/16))}/>
              <YAxis stroke="var(--text-5)" tick={{fill:'var(--text-3)',fontSize:11}}/>
              <Tooltip content={<ChartTip />} />
              <Legend wrapperStyle={{color:'var(--text-2)',fontSize:11,paddingTop:8}}/>
              {yearA && <Line type="monotone" dataKey={`${yearA}_val`} name={yearA} stroke={YEAR_COLORS[yearA]||COLORS[0]} strokeWidth={2.5} dot={false} connectNulls/>}
              {yearB && <Line type="monotone" dataKey={`${yearB}_val`} name={yearB} stroke={YEAR_COLORS[yearB]||COLORS[1]} strokeWidth={2.5} dot={false} connectNulls/>}
            </ComposedChart>
          </ResponsiveContainer>
        )}

        {!yoyLoading && paceChartData.length === 0 && <div className="no-data">No year-over-year data yet — try Reports → Year-over-Year.</div>}

        <div style={{textAlign:'right', marginTop:8}}>
          <button className="btn-secondary" onClick={()=>navigate('/reports')}>Open full Year-over-Year report →</button>
        </div>
      </div>

      <LeagueYoyCompare recentRegs={recentRegs} />

      <div className="card">
        <h2 style={{margin:'0 0 4px'}}>Most Recent Leagues</h2>
        <p style={{color:'var(--text-4)',fontSize:12,margin:'0 0 14px'}}>
          Latest league events by date — click to dive into that league's analytics.
        </p>
        {recentLeagues.length === 0 && <div className="no-data">No league events found yet.</div>}
        {recentLeagues.length > 0 && (
          <table className="data-table">
            <thead><tr><th>League</th><th>Dates</th><th>Status</th><th>Registrations</th></tr></thead>
            <tbody>
              {recentLeagues.map((r,i) => (
                <tr key={r.id} style={{cursor:'pointer'}} onClick={() => { setSelectedReg(r); navigate('/analytics'); }}>
                  <td style={{color:'var(--text-1)'}}>{r.name}</td>
                  <td style={{color:'var(--text-3)',fontSize:12,whiteSpace:'nowrap'}}>{fmtDate(r.open)} – {fmtDate(r.close)}</td>
                  <td>
                    <span className={`badge ${r.status===2?'badge-green':'badge-blue'}`}>{r.status===2?'Open':'Closed'}</span>
                  </td>
                  <td><span className="badge badge-orange">{r.resultsCompleted ?? 0}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Advanced / console — collapsed by default ─────────────────────── */}
      <Collapsible
        title="⚙ Smart Update Console"
        subtitle="Live log from the Smart Update run above — for troubleshooting, not needed day-to-day."
        badge={smartUpdate.running ? 'running' : null}
      >
        <SmartUpdateLog log={smartUpdate.log} />
      </Collapsible>
    </div>
  );
}
