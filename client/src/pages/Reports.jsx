import React, { useEffect, useState } from 'react';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, Cell,
  ComposedChart, Area,
} from 'recharts';
import { api } from '../api.jsx';
import { toast } from 'react-hot-toast';
import AggregatePanel from '../components/AggregatePanel.jsx';
import SearchableSelect from '../components/SearchableSelect.jsx';
import LeagueDetailPanel from '../components/LeagueDetailPanel.jsx';

const COLORS = ['#3b82f6','#f97316','#22c55e','#a855f7','#ec4899','#14b8a6','#eab308','#06b6d4','#f43f5e','#84cc16'];
const YEAR_COLORS = { '2023':'#64748b','2024':'#a855f7','2025':'#f97316','2026':'#3b82f6','2027':'#22c55e','2028':'#ec4899' };

const ChartTip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background:'#13161f', border:'1px solid #2a2d3e', borderRadius:8, padding:'10px 14px', boxShadow:'0 8px 24px rgba(0,0,0,0.4)' }}>
      <p style={{ color:'#94a3b8', fontSize:12, marginBottom:4 }}>{label}</p>
      {payload.map((p,i) => (
        <p key={i} style={{ color:p.color||'#60a5fa', fontSize:13, fontWeight:700, margin:'2px 0' }}>
          {p.name}: {p.value}
        </p>
      ))}
    </div>
  );
};

function todayCDT() {
  return new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
}
function shiftDay(dateStr, delta) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
function fmt(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric' });
}
// Month-day only, no year — for year-aligned compare chart
function fmtMD(mmdd) {
  if (!mmdd) return '';
  // Accept 'YYYY-MM-DD' or 'MM-DD'
  const md = mmdd.length > 5 ? mmdd.slice(5) : mmdd;
  return new Date(`2000-${md}T12:00:00`).toLocaleDateString('en-US', { month:'short', day:'numeric' });
}
function fmtFull(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
}
function monthLabel(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr + '-01T12:00:00').toLocaleDateString('en-US', { month:'short', year:'2-digit' });
}

// ── Pill toggle ───────────────────────────────────────────────────────────────
function Pill({ checked, onChange, label, color='#22c55e' }) {
  return (
    <label style={{
      display:'inline-flex', alignItems:'center', gap:6, cursor:'pointer',
      background: checked ? `${color}1a` : '#1a1d26',
      border:`1px solid ${checked ? color : '#2a2d3e'}`,
      borderRadius:20, padding:'5px 14px', fontSize:12, fontWeight:600,
      color: checked ? color : '#64748b', transition:'all 0.15s', userSelect:'none',
    }}>
      <input type="checkbox" checked={checked} onChange={e=>onChange(e.target.checked)} style={{display:'none'}}/>
      {checked ? '✓ ' : ''}{label}
    </label>
  );
}

// ── Delta badge ───────────────────────────────────────────────────────────────
function Delta({ value, suffix='' }) {
  if (value === null || value === undefined) return null;
  const up = value >= 0;
  return (
    <span style={{
      display:'inline-flex', alignItems:'center', gap:3,
      background: up ? '#0d2b1a' : '#2b0d0d',
      color: up ? '#22c55e' : '#ef4444',
      borderRadius:20, padding:'2px 8px', fontSize:11, fontWeight:700,
    }}>
      {up ? '▲' : '▼'} {Math.abs(value)}{suffix}
    </span>
  );
}

export default function Reports({ ctx }) {
  const { orgId, recentRegs = [], onAggComplete } = ctx;

  const [status,    setStatus]    = useState(null);
  const [recent,    setRecent]    = useState(null);
  const [daily,     setDaily]     = useState([]);
  const [monthly,   setMonthly]   = useState([]);
  const [events,    setEvents]    = useState([]);
  const [gradYears, setGradYears] = useState([]);
  const [loading,   setLoading]   = useState(false);
  const [quickLoading, setQuickLoading] = useState('');

  // Date / event filters
  const [tab,         setTab]         = useState('overview');
  const [chartType,   setChartType]   = useState('line');
  const [fromDate,    setFromDate]    = useState('');
  const [toDate,      setToDate]      = useState('');
  const [filterEvent, setFilterEvent] = useState('');

  // Display filters (client-side, affect event lists)
  const [openOnly,     setOpenOnly]     = useState(false);
  const [thisYearOnly, setThisYearOnly] = useState(false);

  // By League tab — expanded detail
  const [expandedLeague, setExpandedLeague] = useState(null); // eventId | null

  // Daily Activity tab
  const [activityDate, setActivityDate] = useState(todayCDT());
  const [activityData, setActivityData] = useState(null);
  const [activityLoading, setActivityLoading] = useState(false);

  // Year-over-Year tab
  const [yoyData,    setYoyData]    = useState(null);
  const [yoyLoading, setYoyLoading] = useState(false);

  // Compare tab
  const [compareEventA,  setCompareEventA]  = useState('');
  const [compareEventB,  setCompareEventB]  = useState('');
  const [seriesA,        setSeriesA]        = useState([]);
  const [seriesB,        setSeriesB]        = useState([]);
  const [compareAlign,   setCompareAlign]   = useState(true);  // true = align by MM-DD across years
  const [compareMetric,  setCompareMetric]  = useState('both'); // 'daily' | 'cumulative' | 'both'

  useEffect(() => { loadAll(); }, []);
  useEffect(() => {
    if (tab === 'daily-activity') loadActivity(activityDate);
  }, [tab]);
  useEffect(() => {
    if (tab === 'yoy' && !yoyData) loadYoY();
  }, [tab]);
  useEffect(() => {
    if (tab === 'compare') loadCompare();
  }, [tab, compareEventA, compareEventB]);

  // ── Derived event sets ────────────────────────────────────────────────────
  const currentYear = new Date().getFullYear().toString();
  const openIds = new Set(recentRegs.filter(r => r.status === 1).map(r => String(r.id)));
  const thisYearIds = new Set(
    recentRegs
      .filter(r => (r.open||'').slice(0,4) === currentYear || (r.close||'').slice(0,4) === currentYear)
      .map(r => String(r.id))
  );
  const filteredEvents = events.filter(ev => {
    if (openOnly     && !openIds.has(String(ev.id)))     return false;
    if (thisYearOnly && !thisYearIds.has(String(ev.id))) return false;
    return true;
  });

  useEffect(() => {
    if (filterEvent  && !filteredEvents.find(e => String(e.id) === filterEvent))  setFilterEvent('');
    if (compareEventA && !filteredEvents.find(e => String(e.id) === compareEventA)) setCompareEventA('');
    if (compareEventB && !filteredEvents.find(e => String(e.id) === compareEventB)) setCompareEventB('');
  }, [openOnly, thisYearOnly]);

  // ── Data loaders ──────────────────────────────────────────────────────────
  async function loadAll() {
    setLoading(true);
    try {
      const [s, r, d, e, gy] = await Promise.all([
        api.storeStatus(), api.reportRecent(),
        api.reportDaily({ fromDate, toDate, eventId: filterEvent||undefined }),
        api.reportEvents({ fromDate, toDate }),
        api.reportGradYears({ fromDate, toDate, eventId: filterEvent||undefined }),
      ]);
      setStatus(s.data); setRecent(r.data);
      const dailyData = d.data.daily || [];
      setDaily(dailyData.map(row => ({ ...row, label: fmt(row.date) })));
      const mmap = {};
      for (const row of dailyData) {
        const m = row.date.slice(0,7);
        if (!mmap[m]) mmap[m] = { month:m, label:monthLabel(m), total:0 };
        mmap[m].total += row.total;
      }
      setMonthly(Object.values(mmap).sort((a,b)=>a.month.localeCompare(b.month)));
      setEvents(e.data.events || []);
      setGradYears(gy.data.gradYears || []);
    } catch (err) { toast.error('Failed to load reports: ' + err.message); }
    finally { setLoading(false); }
  }

  async function applyFilters() {
    setLoading(true);
    try {
      const [d, e, gy] = await Promise.all([
        api.reportDaily({ fromDate:fromDate||undefined, toDate:toDate||undefined, eventId:filterEvent||undefined }),
        api.reportEvents({ fromDate:fromDate||undefined, toDate:toDate||undefined }),
        api.reportGradYears({ fromDate:fromDate||undefined, toDate:toDate||undefined, eventId:filterEvent||undefined }),
      ]);
      const dailyData = d.data.daily || [];
      setDaily(dailyData.map(row => ({ ...row, label: fmt(row.date) })));
      const mmap = {};
      for (const row of dailyData) {
        const m = row.date.slice(0,7);
        if (!mmap[m]) mmap[m] = { month:m, label:monthLabel(m), total:0 };
        mmap[m].total += row.total;
      }
      setMonthly(Object.values(mmap).sort((a,b)=>a.month.localeCompare(b.month)));
      setEvents(e.data.events||[]); setGradYears(gy.data.gradYears||[]);
    } catch (err) { toast.error('Filter error: ' + err.message); }
    finally { setLoading(false); }
  }

  async function loadActivity(date) {
    setActivityLoading(true);
    try {
      const res = await api.reportDailyActivity(date);
      setActivityData(res.data);
    } catch (err) { toast.error('Failed to load activity: ' + err.message); }
    finally { setActivityLoading(false); }
  }

  function navDay(delta) {
    const newDate = shiftDay(activityDate, delta);
    setActivityDate(newDate);
    loadActivity(newDate);
  }

  async function loadYoY() {
    setYoyLoading(true);
    try {
      const res = await api.reportYoY();
      setYoyData(res.data);
    } catch (err) { toast.error('Failed to load YoY data: ' + err.message); }
    finally { setYoyLoading(false); }
  }

  async function loadCompare() {
    if (!compareEventA && !compareEventB) return;
    setLoading(true);
    try {
      const [a, b] = await Promise.all([
        compareEventA ? api.reportDaily({ eventId:compareEventA }) : Promise.resolve({data:{daily:[]}}),
        compareEventB ? api.reportDaily({ eventId:compareEventB }) : Promise.resolve({data:{daily:[]}}),
      ]);
      setSeriesA(a.data.daily.map(row => ({ ...row, label:fmt(row.date) })));
      setSeriesB(b.data.daily.map(row => ({ ...row, label:fmt(row.date) })));
    } catch { toast.error('Compare load failed'); }
    finally { setLoading(false); }
  }

  // Absolute-date compare (original behaviour)
  const compareDataAbsolute = (() => {
    const map = {};
    for (const r of seriesA) map[r.date] = { date:r.date, label:fmt(r.date), A:r.total, B:0 };
    for (const r of seriesB) {
      if (map[r.date]) map[r.date].B = r.total;
      else map[r.date] = { date:r.date, label:fmt(r.date), A:0, B:r.total };
    }
    const sorted = Object.values(map).sort((a,b)=>a.date.localeCompare(b.date));
    let cumA=0, cumB=0;
    for (const d of sorted) { cumA+=d.A; cumB+=d.B; d.cumA=cumA; d.cumB=cumB; }
    return sorted;
  })();

  // Year-aligned compare — strip year, align by MM-DD so May 23 2025 meets May 23 2026
  const compareDataAligned = (() => {
    const map = {};
    for (const r of seriesA) {
      const mmdd = r.date.slice(5);
      if (!map[mmdd]) map[mmdd] = { mmdd, label:fmtMD(mmdd), A:0, B:0 };
      map[mmdd].A += r.total;  // sum in case the same MM-DD appears twice (leap year edge)
    }
    for (const r of seriesB) {
      const mmdd = r.date.slice(5);
      if (!map[mmdd]) map[mmdd] = { mmdd, label:fmtMD(mmdd), A:0, B:0 };
      map[mmdd].B += r.total;
    }
    const sorted = Object.values(map).sort((a,b)=>a.mmdd.localeCompare(b.mmdd));
    let cumA=0, cumB=0;
    for (const d of sorted) { cumA+=d.A; cumB+=d.B; d.cumA=cumA; d.cumB=cumB; }
    return sorted;
  })();

  const compareData = compareAlign ? compareDataAligned : compareDataAbsolute;

  // ── Quick purge actions ───────────────────────────────────────────────────
  async function startQuickAgg(which) {
    const eventsToFetch = recentRegs.filter(r => which==='open' ? r.status===1 : r.status!==1);
    if (!eventsToFetch.length) { toast('No matching events found'); return; }
    setQuickLoading(which);
    try {
      const res = await api.startAggregate(orgId, 1200, eventsToFetch, true);
      if (res.data.started) toast.success(`Started — purging & re-fetching ${eventsToFetch.length} ${which} events`);
      else toast.error(res.data.message);
    } catch (err) { toast.error('Failed: ' + err.message); }
    finally { setQuickLoading(''); }
  }

  const hasData = status?.totalResults > 0;

  // Display filter pills (shown globally above tabs)
  const DisplayFilters = (
    <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
      <span style={{ fontSize:11, color:'#475569', fontWeight:600, letterSpacing:'0.5px', textTransform:'uppercase' }}>Show:</span>
      <Pill checked={openOnly}     onChange={setOpenOnly}     label="Open only"            color="#22c55e" />
      <Pill checked={thisYearOnly} onChange={setThisYearOnly} label={`${currentYear} only`} color="#f97316" />
      {(openOnly||thisYearOnly) && (
        <span style={{ fontSize:11, color:'#475569' }}>
          {filteredEvents.length} of {events.length} events
        </span>
      )}
    </div>
  );

  return (
    <div>
      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div className="page-header">
        <h1>Reports & Analysis</h1>
        <p style={{ color:'#64748b' }}>
          {status
            ? <><span style={{color:'#60a5fa',fontWeight:700}}>{status.totalResults}</span> registrations saved · <span style={{color:'#a855f7',fontWeight:700}}>{status.totalEvents}</span> events</>
            : 'Loading…'}
          {status?.meta?.lastRunAt && ` · Updated ${new Date(status.meta.lastRunAt).toLocaleString()}`}
        </p>
      </div>

      {/* ── Quick Purge & Re-fetch ────────────────────────────────────────── */}
      <div className="card" style={{ marginBottom:16, borderLeft:'3px solid #1e3a5f' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:12 }}>
          <div>
            <h3 style={{ margin:'0 0 2px', fontSize:14 }}>Quick Purge & Re-fetch</h3>
            <p style={{ color:'#475569', fontSize:12, margin:0 }}>
              Wipes local data for a group then re-fetches fresh from SportsEngine — progress shows in Aggregation panel below.
            </p>
          </div>
          <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
            <button onClick={() => startQuickAgg('open')} disabled={!!quickLoading}
              className="btn-action-green">
              {quickLoading==='open' ? '⏳ Starting…'
                : `↺ Re-fetch Open (${recentRegs.filter(r=>r.status===1).length})`}
            </button>
            <button onClick={() => startQuickAgg('closed')} disabled={!!quickLoading}
              className="btn-action-orange">
              {quickLoading==='closed' ? '⏳ Starting…'
                : `↺ Re-fetch Closed (${recentRegs.filter(r=>r.status!==1).length})`}
            </button>
          </div>
        </div>
      </div>

      {/* ── Aggregate panel ───────────────────────────────────────────────── */}
      <AggregatePanel
        orgId={orgId}
        recentRegs={recentRegs}
        onComplete={async (d) => {
          if (onAggComplete) onAggComplete(d);
          await loadAll();
          if (tab === 'daily-activity') loadActivity(activityDate);
          if (tab === 'yoy') { setYoyData(null); loadYoY(); }
        }}
      />

      {/* ── Stats row ─────────────────────────────────────────────────────── */}
      {recent && (
        <div className="grid-4" style={{ margin:'20px 0' }}>
          {[
            { label:'Today (CDT)',    val:recent.today,         color:'#22c55e', sub:'new registrations' },
            { label:'Yesterday',      val:recent.yesterday,     color:'#60a5fa', sub:'registrations' },
            { label:'This Month',     val:recent.thisMonth,     color:'#f97316', sub:'registrations' },
            { label:'Total in Store', val:status?.totalResults, color:'#a855f7', sub:`${status?.totalEvents??'?'} events` },
          ].map(s => (
            <div key={s.label} className="stat-card">
              <div className="stat-label">{s.label}</div>
              <div className="stat-value" style={{ color:s.color }}>{s.val ?? '—'}</div>
              <div className="stat-sub">{s.sub}</div>
            </div>
          ))}
        </div>
      )}

      {!hasData && (
        <div style={{ textAlign:'center', padding:'60px 20px', color:'#475569' }}>
          <div style={{ fontSize:48, marginBottom:16 }}>📭</div>
          <p style={{ fontSize:15 }}>No saved data yet — run aggregation to populate reports.</p>
        </div>
      )}

      {hasData && (
        <>
          {/* ── Tabs ─────────────────────────────────────────────────────── */}
          <div className="tabs" style={{ marginBottom:0 }}>
            {[
              { id:'overview',       label:'📅 Day-by-Day' },
              { id:'daily-activity', label:'🏀 Daily Activity' },
              { id:'monthly',        label:'📆 Monthly' },
              { id:'events',         label:'🏆 By League' },
              { id:'gradyear',       label:'🎓 Grad Year' },
              { id:'yoy',            label:'📊 Year-over-Year' },
              { id:'compare',        label:'⚔️ Compare' },
            ].map(t => (
              <button key={t.id} className={`tab ${tab===t.id?'active':''}`} onClick={()=>setTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>

          {/* ── Global filter card ────────────────────────────────────────── */}
          <div className="card" style={{ borderRadius:'0 0 10px 10px', marginBottom:16 }}>
            {/* Display pills */}
            <div style={{ marginBottom: tab!=='compare' ? 12 : 0 }}>
              {DisplayFilters}
            </div>

            {/* Date/event filters — not on compare or daily-activity or yoy */}
            {!['compare','daily-activity','yoy'].includes(tab) && (
              <div style={{ display:'flex', gap:12, flexWrap:'wrap', alignItems:'flex-end', borderTop:'1px solid #1e2235', paddingTop:12 }}>
                <div>
                  <label className="field-label">From Date</label>
                  <input type="date" value={fromDate} onChange={e=>setFromDate(e.target.value)} className="field-input" />
                </div>
                <div>
                  <label className="field-label">To Date</label>
                  <input type="date" value={toDate} onChange={e=>setToDate(e.target.value)} className="field-input" />
                </div>
                <div>
                  <label className="field-label">Filter by League</label>
                  <SearchableSelect
                    value={filterEvent}
                    onChange={v=>setFilterEvent(v)}
                    options={[{value:'',label:'All Leagues'},...filteredEvents.map(ev=>({value:String(ev.id),label:ev.name}))]}
                    placeholder="All Leagues"
                    style={{ minWidth:260, maxWidth:340 }}
                  />
                </div>
                <div>
                  <label className="field-label">Chart Type</label>
                  <div style={{ display:'flex', gap:4 }}>
                    {['line','bar'].map(ct => (
                      <button key={ct} onClick={()=>setChartType(ct)} className={ct===chartType?'btn-chart-active':'btn-chart'}>
                        {ct==='line'?'📈 Line':'📊 Bar'}
                      </button>
                    ))}
                  </div>
                </div>
                <button className="btn-primary" onClick={applyFilters} disabled={loading} style={{marginBottom:0}}>
                  {loading?'…':'Apply'}
                </button>
                <button className="btn-secondary" style={{margin:0}} onClick={()=>{
                  setFromDate(''); setToDate(''); setFilterEvent('');
                  setTimeout(loadAll,0);
                }}>Reset</button>
              </div>
            )}
          </div>

          {/* ════════════════════════════════════════════════════════════════ */}
          {/* TAB: Day-by-Day                                                 */}
          {/* ════════════════════════════════════════════════════════════════ */}
          {tab === 'overview' && (
            <div>
              <div className="card">
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:16, flexWrap:'wrap', gap:8 }}>
                  <h2 style={{ margin:0 }}>Registrations Per Day</h2>
                  {daily.length > 0 && (
                    <div style={{ display:'flex', gap:20, alignItems:'baseline' }}>
                      <div style={{ textAlign:'right' }}>
                        <span style={{ fontSize:11, color:'#64748b', textTransform:'uppercase', letterSpacing:'0.5px', marginRight:8 }}>Total</span>
                        <span style={{ fontSize:26, fontWeight:800, color:'#60a5fa', letterSpacing:'-1px' }}>
                          {daily.reduce((s,d)=>s+d.total,0).toLocaleString()}
                        </span>
                        <span style={{ fontSize:12, color:'#475569', marginLeft:6 }}>registrations</span>
                      </div>
                      <div style={{ textAlign:'right' }}>
                        <span style={{ fontSize:11, color:'#64748b', textTransform:'uppercase', letterSpacing:'0.5px', marginRight:8 }}>Days</span>
                        <span style={{ fontSize:20, fontWeight:700, color:'#94a3b8' }}>{daily.length}</span>
                      </div>
                      <div style={{ textAlign:'right' }}>
                        <span style={{ fontSize:11, color:'#64748b', textTransform:'uppercase', letterSpacing:'0.5px', marginRight:8 }}>Avg/day</span>
                        <span style={{ fontSize:20, fontWeight:700, color:'#f97316' }}>
                          {daily.length>0 ? (daily.reduce((s,d)=>s+d.total,0)/daily.length).toFixed(1) : 0}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
                {daily.length === 0 ? <div className="no-data">No data for selected range.</div> : (
                  <ResponsiveContainer width="100%" height={340}>
                    {chartType==='line' ? (
                      <LineChart data={daily} margin={{top:10,right:20,left:0,bottom:24}}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e2235"/>
                        <XAxis dataKey="label" stroke="#334155" tick={{fill:'#64748b',fontSize:11}} angle={-30} textAnchor="end" interval={Math.max(0,Math.floor(daily.length/15))}/>
                        <YAxis stroke="#334155" tick={{fill:'#64748b',fontSize:12}}/>
                        <Tooltip content={<ChartTip/>}/>
                        <Line type="monotone" dataKey="total" name="Registrations" stroke="#3b82f6" strokeWidth={2} dot={daily.length<60}/>
                      </LineChart>
                    ) : (
                      <BarChart data={daily} margin={{top:10,right:20,left:0,bottom:24}}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e2235"/>
                        <XAxis dataKey="label" stroke="#334155" tick={{fill:'#64748b',fontSize:11}} angle={-30} textAnchor="end" interval={Math.max(0,Math.floor(daily.length/15))}/>
                        <YAxis stroke="#334155" tick={{fill:'#64748b',fontSize:12}}/>
                        <Tooltip content={<ChartTip/>}/>
                        <Bar dataKey="total" name="Registrations" fill="#3b82f6" radius={[3,3,0,0]}/>
                      </BarChart>
                    )}
                  </ResponsiveContainer>
                )}
              </div>
              {recent?.daily30?.length > 0 && (
                <div className="card">
                  <h2>Last 30 Days</h2>
                  <div style={{ overflowX:'auto', maxHeight:320, overflowY:'auto' }}>
                    <table className="data-table">
                      <thead><tr><th>Date</th><th>Registrations</th><th>Bar</th></tr></thead>
                      <tbody>
                        {[...recent.daily30].reverse().map((row,i) => (
                          <tr key={row.date}>
                            <td style={{ fontFamily:'monospace', color:'#cbd5e1' }}>
                              {row.date}
                              {row.date===todayCDT() && <span className="badge badge-green" style={{marginLeft:8,fontSize:10}}>today</span>}
                            </td>
                            <td><span className="badge badge-blue">{row.total}</span></td>
                            <td style={{ width:200 }}>
                              <div style={{ background:'#1e2235', borderRadius:4, height:8 }}>
                                <div style={{ background:COLORS[i%COLORS.length], width:`${(row.total/Math.max(...recent.daily30.map(r=>r.total),1))*100}%`, height:'100%', borderRadius:4 }}/>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ════════════════════════════════════════════════════════════════ */}
          {/* TAB: Daily Activity (which leagues registered today/any day)    */}
          {/* ════════════════════════════════════════════════════════════════ */}
          {tab === 'daily-activity' && (
            <div>
              {/* Date navigator */}
              <div className="card" style={{ marginBottom:16 }}>
                <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
                  <button onClick={()=>navDay(-1)} className="btn-secondary" style={{margin:0,padding:'8px 14px',fontSize:18}}>←</button>
                  <div style={{ flex:1, textAlign:'center' }}>
                    <div style={{ fontSize:18, fontWeight:700, color:'#f1f5f9' }}>
                      {fmtFull(activityDate)}
                    </div>
                    {activityDate===todayCDT() && <span className="badge badge-green" style={{fontSize:11}}>Today</span>}
                  </div>
                  <button onClick={()=>navDay(1)} disabled={activityDate>=todayCDT()} className="btn-secondary"
                    style={{margin:0,padding:'8px 14px',fontSize:18,opacity:activityDate>=todayCDT()?0.3:1}}>→</button>
                  <input type="date" value={activityDate}
                    onChange={e=>{setActivityDate(e.target.value);loadActivity(e.target.value);}}
                    max={todayCDT()}
                    className="field-input" style={{marginLeft:8}}/>
                </div>
              </div>

              {activityLoading && <div className="no-data">Loading…</div>}

              {!activityLoading && activityData && (
                <>
                  {/* Week summary */}
                  <div className="grid-4" style={{ marginBottom:16 }}>
                    <div className="stat-card" style={{ gridColumn:'span 1' }}>
                      <div className="stat-label">Registrations This Day</div>
                      <div className="stat-value" style={{ color:'#3b82f6' }}>{activityData.total}</div>
                      <div className="stat-sub">{activityData.leagues.length} leagues active</div>
                    </div>
                    <div className="stat-card">
                      <div className="stat-label">Week Total (Mon–Sun)</div>
                      <div className="stat-value" style={{ color:'#22c55e' }}>{activityData.weekTotal}</div>
                      <div className="stat-sub" style={{ display:'flex', alignItems:'center', gap:6 }}>
                        vs prev week&nbsp;<Delta value={activityData.weekTotal - activityData.prevWeekTotal}/>
                      </div>
                    </div>
                    <div className="stat-card">
                      <div className="stat-label">Prev Week Total</div>
                      <div className="stat-value" style={{ color:'#94a3b8' }}>{activityData.prevWeekTotal}</div>
                      <div className="stat-sub">7 days prior</div>
                    </div>
                    <div className="stat-card">
                      <div className="stat-label">Week Change</div>
                      <div className="stat-value" style={{ fontSize:28, color: activityData.weekTotal>=activityData.prevWeekTotal?'#22c55e':'#ef4444' }}>
                        {activityData.prevWeekTotal > 0
                          ? `${activityData.weekTotal>=activityData.prevWeekTotal?'+':''}${Math.round((activityData.weekTotal-activityData.prevWeekTotal)/activityData.prevWeekTotal*100)}%`
                          : '—'}
                      </div>
                      <div className="stat-sub">vs prior week</div>
                    </div>
                  </div>

                  {/* Week sparkline */}
                  {activityData.weekDays?.length > 0 && (
                    <div className="card" style={{ marginBottom:16 }}>
                      <h3 style={{ marginBottom:12 }}>This Week — Day by Day</h3>
                      <ResponsiveContainer width="100%" height={120}>
                        <BarChart data={activityData.weekDays.map(d=>({...d,label:fmt(d.date)}))} margin={{top:4,right:8,left:0,bottom:4}}>
                          <XAxis dataKey="label" stroke="#334155" tick={{fill:'#64748b',fontSize:11}}/>
                          <Tooltip content={<ChartTip/>}/>
                          <Bar dataKey="total" name="Registrations" radius={[4,4,0,0]}>
                            {activityData.weekDays.map((d,i)=>(
                              <Cell key={i} fill={d.date===activityDate?'#3b82f6':'#1e3a5f'}/>
                            ))}
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}

                  {/* League breakdown */}
                  {activityData.leagues.length === 0 ? (
                    <div className="card">
                      <div className="no-data" style={{ padding:'40px 20px' }}>
                        <div style={{ fontSize:32, marginBottom:8 }}>😶</div>
                        No registrations on this day.
                      </div>
                    </div>
                  ) : (
                    <div className="card">
                      <h2>League Breakdown — {fmt(activityDate)}</h2>
                      <div style={{ overflowX:'auto' }}>
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>#</th>
                              <th>League</th>
                              <th>Registrations</th>
                              <th>Share of Day</th>
                              <th>Top Grad Year</th>
                            </tr>
                          </thead>
                          <tbody>
                            {activityData.leagues.map((l,i)=>(
                              <tr key={l.id}>
                                <td style={{color:'#475569',fontSize:12}}>{i+1}</td>
                                <td style={{color:'#e2e8f0',fontWeight:500}}>
                                  {l.name}
                                  {openIds.has(String(l.id)) && (
                                    <span className="badge badge-green" style={{marginLeft:8,fontSize:10}}>Open</span>
                                  )}
                                </td>
                                <td>
                                  <span style={{
                                    background:COLORS[i%COLORS.length]+'22',
                                    color:COLORS[i%COLORS.length],
                                    borderRadius:20, padding:'3px 12px',
                                    fontSize:14, fontWeight:700,
                                  }}>{l.count}</span>
                                </td>
                                <td style={{width:160}}>
                                  <div style={{display:'flex',alignItems:'center',gap:8}}>
                                    <div style={{background:'#1e2235',borderRadius:4,height:8,flex:1}}>
                                      <div style={{
                                        background:COLORS[i%COLORS.length],
                                        width:`${activityData.total>0?(l.count/activityData.total*100):0}%`,
                                        height:'100%',borderRadius:4,
                                      }}/>
                                    </div>
                                    <span style={{color:'#475569',fontSize:11,minWidth:28,textAlign:'right'}}>
                                      {activityData.total>0?Math.round(l.count/activityData.total*100):0}%
                                    </span>
                                  </div>
                                </td>
                                <td style={{color:'#f97316',fontWeight:700}}>
                                  {l.gradYears?.[0]?.name||'—'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr style={{borderTop:'2px solid #2a2d3e'}}>
                              <td colSpan={2} style={{color:'#94a3b8',fontWeight:700}}>Total</td>
                              <td><span className="badge badge-orange">{activityData.total}</span></td>
                              <td colSpan={2} style={{color:'#475569',fontSize:12}}>{activityData.leagues.length} leagues</td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ════════════════════════════════════════════════════════════════ */}
          {/* TAB: Monthly                                                    */}
          {/* ════════════════════════════════════════════════════════════════ */}
          {tab === 'monthly' && (
            <div>
              <div className="card">
                <h2>Registrations Per Month</h2>
                {monthly.length===0 ? <div className="no-data">No data.</div> : (
                  <ResponsiveContainer width="100%" height={340}>
                    {chartType==='line' ? (
                      <LineChart data={monthly} margin={{top:10,right:20,left:0,bottom:10}}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e2235"/>
                        <XAxis dataKey="label" stroke="#334155" tick={{fill:'#64748b',fontSize:12}}/>
                        <YAxis stroke="#334155" tick={{fill:'#64748b',fontSize:12}}/>
                        <Tooltip content={<ChartTip/>}/>
                        <Line type="monotone" dataKey="total" name="Registrations" stroke="#f97316" strokeWidth={2} dot/>
                      </LineChart>
                    ) : (
                      <BarChart data={monthly} margin={{top:10,right:20,left:0,bottom:10}}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e2235"/>
                        <XAxis dataKey="label" stroke="#334155" tick={{fill:'#64748b',fontSize:12}}/>
                        <YAxis stroke="#334155" tick={{fill:'#64748b',fontSize:12}}/>
                        <Tooltip content={<ChartTip/>}/>
                        <Bar dataKey="total" name="Registrations" radius={[4,4,0,0]}>
                          {monthly.map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
                        </Bar>
                      </BarChart>
                    )}
                  </ResponsiveContainer>
                )}
              </div>
              <div className="card">
                <h2>Monthly Totals</h2>
                <table className="data-table">
                  <thead><tr><th>Month</th><th>Registrations</th><th>Share</th></tr></thead>
                  <tbody>
                    {[...monthly].reverse().map((row,i)=>{
                      const mx = Math.max(...monthly.map(m=>m.total),1);
                      return (
                        <tr key={row.month}>
                          <td style={{color:'#e2e8f0',fontWeight:600}}>{row.label}</td>
                          <td><span className="badge badge-orange">{row.total}</span></td>
                          <td style={{width:200}}>
                            <div style={{background:'#1e2235',borderRadius:4,height:8}}>
                              <div style={{background:COLORS[i%COLORS.length],width:`${(row.total/mx)*100}%`,height:'100%',borderRadius:4}}/>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ════════════════════════════════════════════════════════════════ */}
          {/* TAB: By League                                                  */}
          {/* ════════════════════════════════════════════════════════════════ */}
          {tab === 'events' && (
            <div>
              {/* Export bar */}
              <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:10, gap:8 }}>
                <a href={api.facebookCsvAllUrl(filteredEvents.map(e=>e.id))}
                  style={{ padding:'7px 14px', borderRadius:8, fontSize:12, fontWeight:700,
                    background:'#1e3a5f', color:'#60a5fa', textDecoration:'none', border:'1px solid #2d4a6f' }}>
                  ⬇ Export {filteredEvents.length} leagues → FB Audience CSV
                </a>
              </div>

              <div className="card">
                <h2>Registrations by League{(openOnly||thisYearOnly)&&<span style={{fontSize:13,fontWeight:400,color:'#64748b',marginLeft:8}}>({filteredEvents.length} shown)</span>}</h2>
                {filteredEvents.length===0 ? <div className="no-data">No events match filters.</div> : (
                  <ResponsiveContainer width="100%" height={Math.max(200,Math.min(filteredEvents.length,20)*28+40)}>
                    <BarChart data={filteredEvents.slice(0,20)} layout="vertical" margin={{top:10,right:30,left:10,bottom:10}}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e2235" horizontal={false}/>
                      <XAxis type="number" stroke="#334155" tick={{fill:'#64748b'}}/>
                      <YAxis dataKey="name" type="category" stroke="#334155" tick={{fill:'#94a3b8',fontSize:11}} width={200} tickFormatter={v=>v?.length>30?v.slice(0,28)+'…':v}/>
                      <Tooltip content={<ChartTip/>}/>
                      <Bar dataKey="count" name="Registrations" radius={[0,4,4,0]}>
                        {filteredEvents.slice(0,20).map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>

              <div className="card">
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:12,flexWrap:'wrap',gap:8}}>
                  <h2 style={{margin:0}}>League Detail</h2>
                  <span style={{fontSize:12,color:'#475569'}}>
                    {filteredEvents.length} events ·{' '}
                    <span style={{color:'#60a5fa',fontWeight:700}}>{filteredEvents.reduce((s,e)=>s+e.count,0)}</span> total entries
                  </span>
                </div>
                <div style={{overflowX:'auto',maxHeight:460,overflowY:'auto'}}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>#</th><th>League</th><th>Status</th>
                        <th>Entries</th><th>Top Grad Yr</th><th>Grad Years</th>
                        <th>Export</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredEvents.map((ev,i)=>{
                        const isOpen    = openIds.has(String(ev.id));
                        const isExpanded = expandedLeague === String(ev.id);
                        return (
                          <React.Fragment key={ev.id}>
                            <tr style={{ background: isExpanded ? '#0d1520' : 'transparent', cursor:'pointer' }}
                              onClick={() => setExpandedLeague(isExpanded ? null : String(ev.id))}>
                              <td style={{color:'#475569',fontSize:12}}>{i+1}</td>
                              <td style={{color: isExpanded?'#60a5fa':'#e2e8f0',maxWidth:240,fontWeight:600}}>
                                <span style={{marginRight:6,fontSize:10,color:'#334155'}}>{isExpanded?'▼':'▶'}</span>
                                {ev.name}
                              </td>
                              <td onClick={e=>e.stopPropagation()}>
                                {isOpen
                                  ? <span className="badge badge-green" style={{fontSize:10}}>Open</span>
                                  : <span className="badge" style={{background:'#1e2235',color:'#475569',fontSize:10}}>Closed</span>}
                              </td>
                              <td><span className="badge badge-blue">{ev.count}</span></td>
                              <td style={{color:'#f97316',fontWeight:700}}>
                                {ev.gradYears?.[0]?.name
                                  ? `${ev.gradYears[0].name} (Gr ${12-(parseInt(ev.gradYears[0].name)-new Date().getFullYear())})`
                                  : '—'}
                              </td>
                              <td style={{fontSize:11,color:'#64748b'}}>
                                {(ev.gradYears||[]).slice(0,3).map(g=>(
                                  <span key={g.name} style={{marginRight:5}}>
                                    <span style={{color:'#94a3b8'}}>{g.name}</span>
                                    <span style={{color:'#60a5fa',marginLeft:2}}>×{g.count}</span>
                                  </span>
                                ))}
                              </td>
                              <td onClick={e=>e.stopPropagation()}>
                                <a href={api.facebookCsvUrl(ev.id)}
                                  style={{color:'#60a5fa',fontSize:11,fontWeight:700,textDecoration:'none',
                                    background:'#1e3a5f',padding:'3px 8px',borderRadius:6,display:'inline-block'}}>
                                  FB CSV
                                </a>
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr>
                                <td colSpan={7} style={{padding:'0 16px 16px',background:'#0a0d14'}}>
                                  <LeagueDetailPanel
                                    eventId={String(ev.id)}
                                    eventName={ev.name}
                                    onClose={() => setExpandedLeague(null)}
                                  />
                                </td>
                              </tr>
                            )}
                          </React.Fragment>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr style={{borderTop:'2px solid #2a2d3e'}}>
                        <td colSpan={3} style={{color:'#94a3b8',fontWeight:700}}>Total</td>
                        <td><span className="badge badge-orange">{filteredEvents.reduce((s,e)=>s+e.count,0)}</span></td>
                        <td colSpan={3} style={{color:'#475569',fontSize:12}}>{filteredEvents.length} leagues</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ════════════════════════════════════════════════════════════════ */}
          {/* TAB: Grad Year                                                  */}
          {/* ════════════════════════════════════════════════════════════════ */}
          {tab === 'gradyear' && (
            <div>
              <div className="card">
                <h2>Graduation Year Distribution</h2>
                {gradYears.length===0 ? <div className="no-data">No grad year data.</div> : (
                  <ResponsiveContainer width="100%" height={320}>
                    <BarChart data={[...gradYears].sort((a,b)=>a.name.localeCompare(b.name))} margin={{top:10,right:20,left:0,bottom:24}}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#1e2235"/>
                      <XAxis dataKey="name" stroke="#334155" tick={{fill:'#64748b',fontSize:12}} angle={-30} textAnchor="end" interval={0}/>
                      <YAxis stroke="#334155" tick={{fill:'#64748b',fontSize:12}}/>
                      <Tooltip content={<ChartTip/>}/>
                      <Bar dataKey="count" name="Players" radius={[4,4,0,0]}>
                        {gradYears.map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </div>
              <div className="card">
                <h2>Grad Year Table</h2>
                <table className="data-table">
                  <thead><tr><th>Grad Year</th><th>Players</th><th>%</th></tr></thead>
                  <tbody>
                    {gradYears.map((row,i)=>{
                      const total = gradYears.reduce((s,r)=>s+r.count,0);
                      return (
                        <tr key={row.name}>
                          <td style={{color:COLORS[i%COLORS.length],fontWeight:700}}>{row.name}</td>
                          <td><span className="badge badge-blue">{row.count}</span></td>
                          <td style={{color:'#64748b'}}>{total>0?((row.count/total)*100).toFixed(1):0}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ════════════════════════════════════════════════════════════════ */}
          {/* TAB: Year-over-Year                                             */}
          {/* ════════════════════════════════════════════════════════════════ */}
          {tab === 'yoy' && (
            <div>
              {yoyLoading && <div className="no-data">Computing year-over-year…</div>}
              {!yoyLoading && yoyData && (
                <>
                  <div className="card" style={{ marginBottom:12, padding:'12px 16px', background:'#0d1520', border:'1px solid #1e3a5f' }}>
                    <p style={{ margin:0, fontSize:13, color:'#60a5fa', lineHeight:1.6 }}>
                      <strong>How this works:</strong> Leagues are grouped by base name (year stripped).
                      "Maple Grove 2025" and "Maple Grove 2026" appear as one row.
                      Use this to compare ad performance season-over-season.
                    </p>
                  </div>

                  {/* Grouped bar chart */}
                  {yoyData.groups.length > 0 && yoyData.allYears.length > 1 && (
                    <div className="card">
                      <h2>Registration Count by Season Year (top 15)</h2>
                      <ResponsiveContainer width="100%" height={380}>
                        <BarChart
                          data={yoyData.groups.slice(0,15).map(g => ({
                            name: g.baseName.length>22 ? g.baseName.slice(0,20)+'…' : g.baseName,
                            fullName: g.baseName,
                            ...Object.fromEntries(yoyData.allYears.map(y=>[y, g.years[y]?.count||0])),
                          }))}
                          layout="vertical"
                          margin={{top:10,right:30,left:12,bottom:10}}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="#1e2235" horizontal={false}/>
                          <XAxis type="number" stroke="#334155" tick={{fill:'#64748b'}}/>
                          <YAxis dataKey="name" type="category" stroke="#334155" tick={{fill:'#94a3b8',fontSize:11}} width={190}/>
                          <Tooltip content={<ChartTip/>}/>
                          <Legend wrapperStyle={{color:'#94a3b8',fontSize:12}}/>
                          {yoyData.allYears.map(y=>(
                            <Bar key={y} dataKey={y} name={y} fill={YEAR_COLORS[y]||COLORS[yoyData.allYears.indexOf(y)%COLORS.length]} radius={[0,3,3,0]}/>
                          ))}
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}

                  {/* Detail table */}
                  <div className="card">
                    <h2>Season-over-Season Table</h2>
                    <div style={{overflowX:'auto',maxHeight:500,overflowY:'auto'}}>
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>#</th>
                            <th>League (base name)</th>
                            {yoyData.allYears.map(y=><th key={y} style={{color:YEAR_COLORS[y]||'#94a3b8'}}>{y}</th>)}
                            <th>Total</th>
                            <th>YoY Δ</th>
                          </tr>
                        </thead>
                        <tbody>
                          {yoyData.groups.map((g,i)=>(
                            <tr key={i}>
                              <td style={{color:'#475569',fontSize:12}}>{i+1}</td>
                              <td style={{color:'#e2e8f0',fontWeight:500,maxWidth:260}}>{g.baseName}</td>
                              {yoyData.allYears.map(y=>(
                                <td key={y}>
                                  {g.years[y]
                                    ? <span style={{color:YEAR_COLORS[y]||'#60a5fa',fontWeight:700}}>{g.years[y].count}</span>
                                    : <span style={{color:'#334155'}}>—</span>}
                                </td>
                              ))}
                              <td><span className="badge badge-blue">{g.total}</span></td>
                              <td>
                                {g.delta !== null
                                  ? <Delta value={g.delta}/>
                                  : <span style={{color:'#334155',fontSize:12}}>—</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </>
              )}
              {!yoyLoading && !yoyData && (
                <div className="no-data">Loading year-over-year data…</div>
              )}
            </div>
          )}

          {/* ════════════════════════════════════════════════════════════════ */}
          {/* TAB: Compare                                                    */}
          {/* ════════════════════════════════════════════════════════════════ */}
          {tab === 'compare' && (() => {
            const nameA = filteredEvents.find(e=>String(e.id)===compareEventA)?.name?.slice(0,32) || 'League A';
            const nameB = filteredEvents.find(e=>String(e.id)===compareEventB)?.name?.slice(0,32) || 'League B';

            // Custom tooltip showing daily count + cumulative for each league
            const CompareTip = ({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0]?.payload || {};
              return (
                <div style={{ background:'#0e1018', border:'1px solid #252838', borderRadius:10, padding:'12px 16px', minWidth:220 }}>
                  <p style={{ color:'#94a3b8', fontSize:12, marginBottom:8, fontWeight:600 }}>{label}</p>
                  {compareEventA && (
                    <div style={{ marginBottom:8 }}>
                      <div style={{ color:'#60a5fa', fontSize:12, fontWeight:700, marginBottom:2 }}>{nameA}</div>
                      <div style={{ display:'flex', gap:16, fontSize:12 }}>
                        <span style={{ color:'#64748b' }}>New: <span style={{ color:'#60a5fa', fontWeight:700 }}>{d.A||0}</span></span>
                        <span style={{ color:'#64748b' }}>Total so far: <span style={{ color:'#93c5fd', fontWeight:700 }}>{d.cumA||0}</span></span>
                      </div>
                    </div>
                  )}
                  {compareEventB && (
                    <div>
                      <div style={{ color:'#f97316', fontSize:12, fontWeight:700, marginBottom:2 }}>{nameB}</div>
                      <div style={{ display:'flex', gap:16, fontSize:12 }}>
                        <span style={{ color:'#64748b' }}>New: <span style={{ color:'#f97316', fontWeight:700 }}>{d.B||0}</span></span>
                        <span style={{ color:'#64748b' }}>Total so far: <span style={{ color:'#fdba74', fontWeight:700 }}>{d.cumB||0}</span></span>
                      </div>
                    </div>
                  )}
                  {compareAlign && (
                    <p style={{ color:'#334155', fontSize:10, marginTop:8, marginBottom:0 }}>
                      Year-aligned: same calendar day across both seasons
                    </p>
                  )}
                </div>
              );
            };

            return (
              <div>
                {/* League selectors + view controls */}
                <div className="card" style={{marginBottom:16}}>
                  <div style={{display:'flex',gap:16,flexWrap:'wrap',marginBottom:16}}>
                    <div style={{flex:1}}>
                      <label className="field-label" style={{color:'#60a5fa'}}>League A</label>
                      <SearchableSelect value={compareEventA} onChange={v=>setCompareEventA(v)}
                        options={[{value:'',label:'Select league…'},...filteredEvents.map(ev=>({value:String(ev.id),label:ev.name}))]}
                        placeholder="Select league…" style={{width:'100%'}}/>
                    </div>
                    <div style={{flex:1}}>
                      <label className="field-label" style={{color:'#f97316'}}>League B</label>
                      <SearchableSelect value={compareEventB} onChange={v=>setCompareEventB(v)}
                        options={[{value:'',label:'Select league…'},...filteredEvents.map(ev=>({value:String(ev.id),label:ev.name}))]}
                        placeholder="Select league…" style={{width:'100%'}}/>
                    </div>
                  </div>

                  {/* View toggles */}
                  <div style={{display:'flex',gap:16,flexWrap:'wrap',alignItems:'center',borderTop:'1px solid #1e2235',paddingTop:12}}>
                    <div>
                      <span style={{fontSize:11,color:'#64748b',fontWeight:600,textTransform:'uppercase',letterSpacing:'0.5px',marginRight:8}}>Date Alignment</span>
                      <div style={{display:'inline-flex',gap:4,marginTop:4}}>
                        {[
                          {id:true,  label:'📅 Year-Aligned', desc:'May 23 ↔ May 23 across years'},
                          {id:false, label:'📆 Absolute Dates', desc:'Real calendar dates'},
                        ].map(({id,label,desc})=>(
                          <button key={String(id)} onClick={()=>setCompareAlign(id)}
                            style={{
                              padding:'5px 12px', borderRadius:6, fontSize:11, fontWeight:700, border:'none', cursor:'pointer',
                              background: compareAlign===id?'#1e3a5f':'#1e2235',
                              color:      compareAlign===id?'#60a5fa':'#64748b',
                            }} title={desc}>
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <span style={{fontSize:11,color:'#64748b',fontWeight:600,textTransform:'uppercase',letterSpacing:'0.5px',marginRight:8}}>Show</span>
                      <div style={{display:'inline-flex',gap:4,marginTop:4}}>
                        {[
                          {id:'both',       label:'Both'},
                          {id:'daily',      label:'Daily New'},
                          {id:'cumulative', label:'Cumulative'},
                        ].map(({id,label})=>(
                          <button key={id} onClick={()=>setCompareMetric(id)}
                            style={{
                              padding:'5px 12px', borderRadius:6, fontSize:11, fontWeight:700, border:'none', cursor:'pointer',
                              background: compareMetric===id?'#1e3a5f':'#1e2235',
                              color:      compareMetric===id?'#60a5fa':'#64748b',
                            }}>
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    {compareAlign && compareEventA && compareEventB && (
                      <span style={{fontSize:11,color:'#475569',marginLeft:'auto'}}>
                        Tip: pick the same league from different years (e.g. Maple Grove 2025 vs 2026)
                      </span>
                    )}
                  </div>
                </div>

                {/* League summary cards */}
                {(compareEventA||compareEventB) && (
                  <div className="grid-2" style={{marginBottom:16}}>
                    {[compareEventA,compareEventB].map((eid,si)=>{
                      const ev    = filteredEvents.find(e=>String(e.id)===eid);
                      const color = si===0?'#60a5fa':'#f97316';
                      const series = si===0 ? seriesA : seriesB;
                      const cumTotal = series.reduce((s,r)=>s+r.total,0);
                      return (
                        <div key={si} className="card" style={{borderTop:`3px solid ${color}`}}>
                          <h3 style={{color,marginBottom:8}}>League {si===0?'A':'B'}</h3>
                          {ev ? (
                            <>
                              <p style={{color:'#94a3b8',fontSize:12,marginBottom:12}}>{ev.name}</p>
                              <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
                                <div style={{background:'#1a1d26',borderRadius:8,padding:'10px 14px',flex:1,minWidth:70}}>
                                  <div style={{color:'#64748b',fontSize:10,textTransform:'uppercase',letterSpacing:'0.5px'}}>Stored</div>
                                  <div style={{color,fontSize:26,fontWeight:800}}>{ev.count}</div>
                                </div>
                                <div style={{background:'#1a1d26',borderRadius:8,padding:'10px 14px',flex:1,minWidth:70}}>
                                  <div style={{color:'#64748b',fontSize:10,textTransform:'uppercase',letterSpacing:'0.5px'}}>In Period</div>
                                  <div style={{color,fontSize:26,fontWeight:800}}>{cumTotal}</div>
                                </div>
                                <div style={{background:'#1a1d26',borderRadius:8,padding:'10px 14px',flex:1,minWidth:70}}>
                                  <div style={{color:'#64748b',fontSize:10,textTransform:'uppercase',letterSpacing:'0.5px'}}>Top Grad Yr</div>
                                  <div style={{color,fontSize:22,fontWeight:700}}>{ev.gradYears?.[0]?.name||'—'}</div>
                                </div>
                              </div>
                            </>
                          ) : (
                            <div style={{color:'#475569',fontSize:13}}>Select a league above</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Main chart */}
                {compareData.length > 0 && (
                  <div className="card">
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:12,flexWrap:'wrap',gap:8}}>
                      <h2 style={{margin:0}}>
                        {compareAlign ? 'Year-Aligned' : 'Day-by-Day'} — {nameA} vs {nameB}
                      </h2>
                      {compareAlign && (
                        <span style={{fontSize:11,color:'#475569'}}>
                          X-axis = calendar month-day (year stripped) · hover for cumulative total
                        </span>
                      )}
                    </div>

                    <ResponsiveContainer width="100%" height={380}>
                      <ComposedChart data={compareData} margin={{top:10,right:20,left:0,bottom:30}}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e2235"/>
                        <XAxis
                          dataKey="label"
                          stroke="#334155"
                          tick={{fill:'#64748b',fontSize:10}}
                          angle={-35}
                          textAnchor="end"
                          interval={Math.max(0,Math.floor(compareData.length/16))}
                        />
                        {/* Left Y: daily new */}
                        <YAxis yAxisId="daily" stroke="#334155" tick={{fill:'#64748b',fontSize:11}}
                          label={compareMetric!=='cumulative'?{value:'New',angle:-90,position:'insideLeft',fill:'#475569',fontSize:10}:undefined}/>
                        {/* Right Y: cumulative */}
                        {compareMetric!=='daily' && (
                          <YAxis yAxisId="cum" orientation="right" stroke="#334155" tick={{fill:'#64748b',fontSize:11}}
                            label={{value:'Total',angle:90,position:'insideRight',fill:'#475569',fontSize:10}}/>
                        )}
                        <Tooltip content={<CompareTip/>}/>
                        <Legend wrapperStyle={{color:'#94a3b8',fontSize:11,paddingTop:8}}/>

                        {/* Daily new bars */}
                        {compareMetric!=='cumulative' && compareEventA && (
                          <Bar yAxisId="daily" dataKey="A" name={`${nameA} (daily new)`} fill="#60a5fa" opacity={0.55} radius={[2,2,0,0]}/>
                        )}
                        {compareMetric!=='cumulative' && compareEventB && (
                          <Bar yAxisId="daily" dataKey="B" name={`${nameB} (daily new)`} fill="#f97316" opacity={0.55} radius={[2,2,0,0]}/>
                        )}

                        {/* Cumulative lines */}
                        {compareMetric!=='daily' && compareEventA && (
                          <Line yAxisId="cum" type="monotone" dataKey="cumA"
                            name={`${nameA} (cumulative)`} stroke="#60a5fa" strokeWidth={2.5} dot={false}/>
                        )}
                        {compareMetric!=='daily' && compareEventB && (
                          <Line yAxisId="cum" type="monotone" dataKey="cumB"
                            name={`${nameB} (cumulative)`} stroke="#f97316" strokeWidth={2.5} dot={false}/>
                        )}
                      </ComposedChart>
                    </ResponsiveContainer>

                    {/* Cumulative totals summary table */}
                    <div style={{marginTop:16,display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
                      {[
                        { key:'A', name:nameA, color:'#60a5fa', cum:compareData[compareData.length-1]?.cumA||0, data:seriesA },
                        { key:'B', name:nameB, color:'#f97316', cum:compareData[compareData.length-1]?.cumB||0, data:seriesB },
                      ].map(s=>(
                        <div key={s.key} style={{background:'#0e1018',border:`1px solid ${s.color}33`,borderRadius:8,padding:'10px 14px'}}>
                          <div style={{fontSize:11,color:'#64748b',marginBottom:4,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{s.name}</div>
                          <div style={{display:'flex',gap:16,flexWrap:'wrap'}}>
                            <div>
                              <div style={{fontSize:9,color:'#475569',textTransform:'uppercase',letterSpacing:'0.5px'}}>Cumulative in period</div>
                              <div style={{fontSize:22,fontWeight:800,color:s.color}}>{s.cum}</div>
                            </div>
                            <div>
                              <div style={{fontSize:9,color:'#475569',textTransform:'uppercase',letterSpacing:'0.5px'}}>Peak day</div>
                              <div style={{fontSize:22,fontWeight:800,color:s.color}}>
                                {Math.max(...(s.data.map(r=>r.total)||[0]))}
                              </div>
                            </div>
                            <div>
                              <div style={{fontSize:9,color:'#475569',textTransform:'uppercase',letterSpacing:'0.5px'}}>Active days</div>
                              <div style={{fontSize:22,fontWeight:800,color:s.color}}>{s.data.filter(r=>r.total>0).length}</div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
        </>
      )}
    </div>
  );
}
