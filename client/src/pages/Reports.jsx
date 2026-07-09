import React, { useEffect, useState } from 'react';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, Cell,
  ComposedChart, Area,
} from 'recharts';
import { api } from '../api.jsx';
import { toast } from 'react-hot-toast';
import AggregatePanel from '../components/AggregatePanel.jsx';
import useSmartUpdate from '../hooks/useSmartUpdate.js';
import SmartUpdateBar from '../components/SmartUpdateBar.jsx';
import Collapsible from '../components/Collapsible.jsx';
import SearchableSelect from '../components/SearchableSelect.jsx';
import LeagueDetailPanel from '../components/LeagueDetailPanel.jsx';
import LeagueOverlap    from '../components/LeagueOverlap.jsx';
import LeagueScatter   from '../components/LeagueScatter.jsx';
import DailyActivityPanel from '../components/DailyActivityPanel.jsx';
import Panel from '../components/Panel.jsx';

const COLORS = ['#3b82f6','#f97316','#22c55e','#a855f7','#ec4899','#14b8a6','#eab308','#06b6d4','#f43f5e','#84cc16'];
const YEAR_COLORS = { '2023':'var(--text-3)','2024':'#a855f7','2025':'#f97316','2026':'#3b82f6','2027':'#22c55e','2028':'#ec4899' };

const ChartTip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background:'var(--surface-2)', border:'1px solid var(--line)', borderRadius:8, padding:'10px 14px', boxShadow:'0 8px 24px rgba(0,0,0,0.4)' }}>
      <p style={{ color:'var(--text-2)', fontSize:12, marginBottom:4 }}>{label}</p>
      {payload.map((p,i) => (
        <p key={i} style={{ color:p.color||'var(--accent-light)', fontSize:13, fontWeight:700, margin:'2px 0' }}>
          {p.name}: {p.value}
        </p>
      ))}
    </div>
  );
};

function todayCDT() {
  return new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
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
function monthLabel(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr + '-01T12:00:00').toLocaleDateString('en-US', { month:'short', year:'2-digit' });
}

// ── Pill toggle ───────────────────────────────────────────────────────────────
function Pill({ checked, onChange, label, color='#22c55e' }) {
  return (
    <label style={{
      display:'inline-flex', alignItems:'center', gap:6, cursor:'pointer',
      background: checked ? `${color}1a` : 'var(--surface-2)',
      border:`1px solid ${checked ? color : 'var(--line)'}`,
      borderRadius:20, padding:'5px 14px', fontSize:12, fontWeight:600,
      color: checked ? color : 'var(--text-3)', transition:'all 0.15s', userSelect:'none',
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
      background: up ? 'rgba(34,197,94,0.14)' : 'rgba(239,68,68,0.14)',
      color: up ? '#22c55e' : '#ef4444',
      borderRadius:20, padding:'2px 8px', fontSize:11, fontWeight:700,
    }}>
      {up ? '▲' : '▼'} {Math.abs(value)}{suffix}
    </span>
  );
}

export default function Reports({ ctx }) {
  const { orgId, recentRegs = [], onAggComplete, refreshToken } = ctx;

  const [status,    setStatus]    = useState(null);
  const [recent,    setRecent]    = useState(null);
  const [daily,     setDaily]     = useState([]);
  const [monthly,   setMonthly]   = useState([]);
  const [events,    setEvents]    = useState([]);
  const [gradYears, setGradYears] = useState([]);
  const [loading,   setLoading]   = useState(false);
  const [quickLoading, setQuickLoading] = useState('');

  const smartUpdate = useSmartUpdate({
    orgId, recentRegs,
    onComplete: async (d) => {
      if (onAggComplete) await onAggComplete(d);
      await loadAll();
      if (tab === 'yoy') { setYoyData(null); loadYoY(); }
    },
  });

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

  // Year-over-Year tab
  const [yoyData,       setYoyData]       = useState(null);
  const [yoyLoading,    setYoyLoading]    = useState(false);
  const [yoyDaily,      setYoyDaily]      = useState(null);
  const [yoyDailyLoad,  setYoyDailyLoad]  = useState(false);
  const [paceType,      setPaceType]      = useState('all');    // all|league|camp|tournament
  const [paceMetric,    setPaceMetric]    = useState('cum');    // cum|daily
  const [paceYears,     setPaceYears]     = useState({});       // year → boolean (visible)

  // Retention analysis
  const [retSrcYear,    setRetSrcYear]    = useState((new Date().getFullYear()-1).toString());
  const [retTgtYear,    setRetTgtYear]    = useState(new Date().getFullYear().toString());
  const [retSrcType,    setRetSrcType]    = useState('all');
  const [retTgtType,    setRetTgtType]    = useState('all');
  const [retData,       setRetData]       = useState(null);
  const [retLoading,    setRetLoading]    = useState(false);
  const [retExpanded,   setRetExpanded]   = useState(null);

  // League email export (compare tab)
  const [emailExportId,        setEmailExportId]        = useState('');
  const [emailExportData,      setEmailExportData]      = useState(null);
  const [emailExportLoad,      setEmailExportLoad]      = useState(false);
  const [emailExportShowTable, setEmailExportShowTable] = useState(false);

  // Compare tab
  const [compareEventA,  setCompareEventA]  = useState('');
  const [compareEventB,  setCompareEventB]  = useState('');
  const [seriesA,        setSeriesA]        = useState([]);
  const [seriesB,        setSeriesB]        = useState([]);
  const [compareAlign,   setCompareAlign]   = useState(true);  // true = align by MM-DD across years
  const [compareMetric,  setCompareMetric]  = useState('both'); // 'daily' | 'cumulative' | 'both'

  useEffect(() => { loadAll(); }, []);
  useEffect(() => {
    if (tab === 'yoy') {
      if (!yoyData)    loadYoY();
      if (!yoyDaily)   loadYoyDaily();
    }
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

  async function loadYoY() {
    setYoyLoading(true);
    try {
      const res = await api.reportYoY();
      setYoyData(res.data);
    } catch (err) { toast.error('Failed to load YoY data: ' + err.message); }
    finally { setYoyLoading(false); }
  }

  async function loadYoyDaily() {
    setYoyDailyLoad(true);
    try {
      const res = await api.reportYoyDaily();
      setYoyDaily(res.data);
      const visible = {};
      [...(res.data.years||[])].sort().reverse().forEach((y, i) => { visible[y] = i < 3; });
      setPaceYears(visible);
    } catch (err) { toast.error('Failed to load daily pace: ' + err.message); }
    finally { setYoyDailyLoad(false); }
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
      <span style={{ fontSize:11, color:'var(--text-4)', fontWeight:600, letterSpacing:'0.5px', textTransform:'uppercase' }}>Show:</span>
      <Pill checked={openOnly}     onChange={setOpenOnly}     label="Open only"            color="#22c55e" />
      <Pill checked={thisYearOnly} onChange={setThisYearOnly} label={`${currentYear} only`} color="#f97316" />
      {(openOnly||thisYearOnly) && (
        <span style={{ fontSize:11, color:'var(--text-4)' }}>
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
        <p style={{ color:'var(--text-3)' }}>
          {status
            ? <><span style={{color:'var(--accent-light)',fontWeight:700}}>{status.totalResults}</span> registrations saved · <span style={{color:'#a855f7',fontWeight:700}}>{status.totalEvents}</span> events</>
            : 'Loading…'}
          {status?.meta?.lastRunAt && ` · Updated ${new Date(status.meta.lastRunAt).toLocaleString()}`}
        </p>
      </div>

      {/* ── Quick glance: Smart Update only ───────────────────────────────── */}
      <SmartUpdateBar {...smartUpdate} />

      {/* ── Stats row ─────────────────────────────────────────────────────── */}
      {recent && (
        <div className="grid-4" style={{ margin:'20px 0' }}>
          {[
            { label:'Today (CDT)',    val:recent.today,         color:'#22c55e', sub:'new registrations' },
            { label:'Yesterday',      val:recent.yesterday,     color:'var(--accent-light)', sub:'registrations' },
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
        <div style={{ textAlign:'center', padding:'60px 20px', color:'var(--text-4)' }}>
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
          <Panel id="reports-panel-1" style={{ borderRadius:'0 0 10px 10px', marginBottom:16 }}>
            {/* Display pills */}
            <div style={{ marginBottom: tab!=='compare' ? 12 : 0 }}>
              {DisplayFilters}
            </div>

            {/* Date/event filters — not on compare or daily-activity or yoy */}
            {!['compare','daily-activity','yoy'].includes(tab) && (
              <div style={{ borderTop:'1px solid var(--surface-1)', paddingTop:12 }}>
                <div style={{ fontSize:11, color:'var(--text-5)', marginBottom:10 }}>
                  Applies to Day-by-Day, Monthly, By League &amp; Grad Year
                </div>
                <div style={{ display:'flex', gap:12, flexWrap:'wrap', alignItems:'flex-end' }}>
                  <div>
                    <label className="field-label">From Date</label>
                    <input type="date" value={fromDate} onChange={e=>setFromDate(e.target.value)} className="field-input" />
                  </div>
                  <div>
                    <label className="field-label">To Date</label>
                    <input type="date" value={toDate} onChange={e=>setToDate(e.target.value)} className="field-input" />
                  </div>
                  {tab !== 'events' && (
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
                  )}
                  {(tab === 'overview' || tab === 'monthly') && (
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
                  )}
                  <button className="btn-primary" onClick={applyFilters} disabled={loading} style={{marginBottom:0}}>
                    {loading?'…':'Apply'}
                  </button>
                  <button className="btn-secondary" style={{margin:0}} onClick={()=>{
                    setFromDate(''); setToDate(''); setFilterEvent('');
                    setTimeout(loadAll,0);
                  }}>Reset</button>
                </div>
              </div>
            )}
          </Panel>

          {/* ════════════════════════════════════════════════════════════════ */}
          {/* TAB: Day-by-Day                                                 */}
          {/* ════════════════════════════════════════════════════════════════ */}
          {tab === 'overview' && (
            <div>
              <Panel id="reports-panel-2">
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:16, flexWrap:'wrap', gap:8 }}>
                  <h2 style={{ margin:0 }}>Registrations Per Day</h2>
                  {daily.length > 0 && (
                    <div style={{ display:'flex', gap:20, alignItems:'baseline' }}>
                      <div style={{ textAlign:'right' }}>
                        <span style={{ fontSize:11, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'0.5px', marginRight:8 }}>Total</span>
                        <span style={{ fontSize:26, fontWeight:800, color:'var(--accent-light)', letterSpacing:'-1px' }}>
                          {daily.reduce((s,d)=>s+d.total,0).toLocaleString()}
                        </span>
                        <span style={{ fontSize:12, color:'var(--text-4)', marginLeft:6 }}>registrations</span>
                      </div>
                      <div style={{ textAlign:'right' }}>
                        <span style={{ fontSize:11, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'0.5px', marginRight:8 }}>Days</span>
                        <span style={{ fontSize:20, fontWeight:700, color:'var(--text-2)' }}>{daily.length}</span>
                      </div>
                      <div style={{ textAlign:'right' }}>
                        <span style={{ fontSize:11, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'0.5px', marginRight:8 }}>Avg/day</span>
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
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--surface-1)"/>
                        <XAxis dataKey="label" stroke="var(--text-5)" tick={{fill:'var(--text-3)',fontSize:11}} angle={-30} textAnchor="end" interval={Math.max(0,Math.floor(daily.length/15))}/>
                        <YAxis stroke="var(--text-5)" tick={{fill:'var(--text-3)',fontSize:12}}/>
                        <Tooltip content={<ChartTip/>}/>
                        <Line type="monotone" dataKey="total" name="Registrations" stroke="#3b82f6" strokeWidth={2} dot={daily.length<60}/>
                      </LineChart>
                    ) : (
                      <BarChart data={daily} margin={{top:10,right:20,left:0,bottom:24}}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--surface-1)"/>
                        <XAxis dataKey="label" stroke="var(--text-5)" tick={{fill:'var(--text-3)',fontSize:11}} angle={-30} textAnchor="end" interval={Math.max(0,Math.floor(daily.length/15))}/>
                        <YAxis stroke="var(--text-5)" tick={{fill:'var(--text-3)',fontSize:12}}/>
                        <Tooltip content={<ChartTip/>}/>
                        <Bar dataKey="total" name="Registrations" fill="#3b82f6" radius={[3,3,0,0]}/>
                      </BarChart>
                    )}
                  </ResponsiveContainer>
                )}
              </Panel>
              {recent?.daily30?.length > 0 && (
                <Panel id="reports-panel-3">
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
                              <div style={{ background:'var(--surface-1)', borderRadius:4, height:8 }}>
                                <div style={{ background:COLORS[i%COLORS.length], width:`${(row.total/Math.max(...recent.daily30.map(r=>r.total),1))*100}%`, height:'100%', borderRadius:4 }}/>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Panel>
              )}
            </div>
          )}

          {/* ════════════════════════════════════════════════════════════════ */}
          {/* TAB: Daily Activity (which leagues registered today/any day)    */}
          {/* ════════════════════════════════════════════════════════════════ */}
          {tab === 'daily-activity' && <DailyActivityPanel recentRegs={recentRegs} refreshToken={refreshToken} />}

          {/* ════════════════════════════════════════════════════════════════ */}
          {/* TAB: Monthly                                                    */}
          {/* ════════════════════════════════════════════════════════════════ */}
          {tab === 'monthly' && (
            <div>
              <Panel id="reports-panel-4">
                <h2>Registrations Per Month</h2>
                {monthly.length===0 ? <div className="no-data">No data.</div> : (
                  <ResponsiveContainer width="100%" height={340}>
                    {chartType==='line' ? (
                      <LineChart data={monthly} margin={{top:10,right:20,left:0,bottom:10}}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--surface-1)"/>
                        <XAxis dataKey="label" stroke="var(--text-5)" tick={{fill:'var(--text-3)',fontSize:12}}/>
                        <YAxis stroke="var(--text-5)" tick={{fill:'var(--text-3)',fontSize:12}}/>
                        <Tooltip content={<ChartTip/>}/>
                        <Line type="monotone" dataKey="total" name="Registrations" stroke="#f97316" strokeWidth={2} dot/>
                      </LineChart>
                    ) : (
                      <BarChart data={monthly} margin={{top:10,right:20,left:0,bottom:10}}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--surface-1)"/>
                        <XAxis dataKey="label" stroke="var(--text-5)" tick={{fill:'var(--text-3)',fontSize:12}}/>
                        <YAxis stroke="var(--text-5)" tick={{fill:'var(--text-3)',fontSize:12}}/>
                        <Tooltip content={<ChartTip/>}/>
                        <Bar dataKey="total" name="Registrations" radius={[4,4,0,0]}>
                          {monthly.map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
                        </Bar>
                      </BarChart>
                    )}
                  </ResponsiveContainer>
                )}
              </Panel>
              <Panel id="reports-panel-5">
                <h2>Monthly Totals</h2>
                <table className="data-table">
                  <thead><tr><th>Month</th><th>Registrations</th><th>Share</th></tr></thead>
                  <tbody>
                    {[...monthly].reverse().map((row,i)=>{
                      const mx = Math.max(...monthly.map(m=>m.total),1);
                      return (
                        <tr key={row.month}>
                          <td style={{color:'var(--text-1)',fontWeight:600}}>{row.label}</td>
                          <td><span className="badge badge-orange">{row.total}</span></td>
                          <td style={{width:200}}>
                            <div style={{background:'var(--surface-1)',borderRadius:4,height:8}}>
                              <div style={{background:COLORS[i%COLORS.length],width:`${(row.total/mx)*100}%`,height:'100%',borderRadius:4}}/>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Panel>
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
                    background:'var(--chip-bg)', color:'var(--accent-light)', textDecoration:'none', border:'1px solid var(--chip-border)' }}>
                  ⬇ Export {filteredEvents.length} leagues → FB Audience CSV
                </a>
              </div>

              <Panel id="reports-panel-6">
                <h2>Registrations by League{(openOnly||thisYearOnly)&&<span style={{fontSize:13,fontWeight:400,color:'var(--text-3)',marginLeft:8}}>({filteredEvents.length} shown)</span>}</h2>
                {filteredEvents.length===0 ? <div className="no-data">No events match filters.</div> : (
                  <ResponsiveContainer width="100%" height={Math.max(200,Math.min(filteredEvents.length,20)*28+40)}>
                    <BarChart data={filteredEvents.slice(0,20)} layout="vertical" margin={{top:10,right:30,left:10,bottom:10}}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--surface-1)" horizontal={false}/>
                      <XAxis type="number" stroke="var(--text-5)" tick={{fill:'var(--text-3)'}}/>
                      <YAxis dataKey="name" type="category" stroke="var(--text-5)" tick={{fill:'var(--text-2)',fontSize:11}} width={200} tickFormatter={v=>v?.length>30?v.slice(0,28)+'…':v}/>
                      <Tooltip content={<ChartTip/>}/>
                      <Bar dataKey="count" name="Registrations" radius={[0,4,4,0]}>
                        {filteredEvents.slice(0,20).map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </Panel>

              <Panel id="reports-panel-7">
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:12,flexWrap:'wrap',gap:8}}>
                  <h2 style={{margin:0}}>League Detail</h2>
                  <span style={{fontSize:12,color:'var(--text-4)'}}>
                    {filteredEvents.length} events ·{' '}
                    <span style={{color:'var(--accent-light)',fontWeight:700}}>{filteredEvents.reduce((s,e)=>s+e.count,0)}</span> total entries
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
                            <tr style={{ background: isExpanded ? 'var(--bg-hover)' : 'transparent', cursor:'pointer' }}
                              onClick={() => setExpandedLeague(isExpanded ? null : String(ev.id))}>
                              <td style={{color:'var(--text-4)',fontSize:12}}>{i+1}</td>
                              <td style={{color: isExpanded?'var(--accent-light)':'var(--text-1)',maxWidth:240,fontWeight:600}}>
                                <span style={{marginRight:6,fontSize:10,color:'var(--text-5)'}}>{isExpanded?'▼':'▶'}</span>
                                {ev.name}
                              </td>
                              <td onClick={e=>e.stopPropagation()}>
                                {isOpen
                                  ? <span className="badge badge-green" style={{fontSize:10}}>Open</span>
                                  : <span className="badge" style={{background:'var(--surface-1)',color:'var(--text-4)',fontSize:10}}>Closed</span>}
                              </td>
                              <td><span className="badge badge-blue">{ev.count}</span></td>
                              <td style={{color:'#f97316',fontWeight:700}}>
                                {ev.gradYears?.[0]?.name
                                  ? `${ev.gradYears[0].name} (Gr ${12-(parseInt(ev.gradYears[0].name)-new Date().getFullYear())})`
                                  : '—'}
                              </td>
                              <td style={{fontSize:11,color:'var(--text-3)'}}>
                                {(ev.gradYears||[]).slice(0,3).map(g=>(
                                  <span key={g.name} style={{marginRight:5}}>
                                    <span style={{color:'var(--text-2)'}}>{g.name}</span>
                                    <span style={{color:'var(--accent-light)',marginLeft:2}}>×{g.count}</span>
                                  </span>
                                ))}
                              </td>
                              <td onClick={e=>e.stopPropagation()}>
                                <a href={api.facebookCsvUrl(ev.id)}
                                  style={{color:'var(--accent-light)',fontSize:11,fontWeight:700,textDecoration:'none',
                                    background:'var(--chip-bg)',padding:'3px 8px',borderRadius:6,display:'inline-block'}}>
                                  FB CSV
                                </a>
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr>
                                <td colSpan={7} style={{padding:'0 16px 16px',background:'var(--surface-3)'}}>
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
                      <tr style={{borderTop:'2px solid var(--line)'}}>
                        <td colSpan={3} style={{color:'var(--text-2)',fontWeight:700}}>Total</td>
                        <td><span className="badge badge-orange">{filteredEvents.reduce((s,e)=>s+e.count,0)}</span></td>
                        <td colSpan={3} style={{color:'var(--text-4)',fontSize:12}}>{filteredEvents.length} leagues</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </Panel>
            </div>
          )}

          {/* ════════════════════════════════════════════════════════════════ */}
          {/* TAB: Grad Year                                                  */}
          {/* ════════════════════════════════════════════════════════════════ */}
          {tab === 'gradyear' && (
            <div>
              <Panel id="reports-panel-8">
                <h2>Graduation Year Distribution</h2>
                {gradYears.length===0 ? <div className="no-data">No grad year data.</div> : (
                  <ResponsiveContainer width="100%" height={320}>
                    <BarChart data={[...gradYears].sort((a,b)=>a.name.localeCompare(b.name))} margin={{top:10,right:20,left:0,bottom:24}}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--surface-1)"/>
                      <XAxis dataKey="name" stroke="var(--text-5)" tick={{fill:'var(--text-3)',fontSize:12}} angle={-30} textAnchor="end" interval={0}/>
                      <YAxis stroke="var(--text-5)" tick={{fill:'var(--text-3)',fontSize:12}}/>
                      <Tooltip content={<ChartTip/>}/>
                      <Bar dataKey="count" name="Players" radius={[4,4,0,0]}>
                        {gradYears.map((_,i)=><Cell key={i} fill={COLORS[i%COLORS.length]}/>)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </Panel>
              <Panel id="reports-panel-9">
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
                          <td style={{color:'var(--text-3)'}}>{total>0?((row.count/total)*100).toFixed(1):0}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Panel>
            </div>
          )}

          {/* ════════════════════════════════════════════════════════════════ */}
          {/* TAB: Year-over-Year                                             */}
          {/* ════════════════════════════════════════════════════════════════ */}
          {tab === 'yoy' && (
            <div>
              {/* ── Day-by-Day Pace ─────────────────────────────────── */}
              <Panel id="reports-panel-10" style={{marginBottom:16}}>
                <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',flexWrap:'wrap',gap:8,marginBottom:12}}>
                  <h2 style={{margin:0}}>Registration Pace — Year over Year</h2>
                  <button onClick={()=>loadYoyDaily()} style={{fontSize:11,color:'var(--text-4)',background:'none',border:'none',cursor:'pointer'}}>↻ Refresh</button>
                </div>

                {/* Controls row */}
                <div style={{display:'flex',gap:16,flexWrap:'wrap',alignItems:'center',marginBottom:12}}>
                  {/* Type filter */}
                  <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
                    <span style={{fontSize:11,color:'var(--text-3)',fontWeight:600,marginRight:4}}>Type:</span>
                    {[['all','All'],['league','League'],['camp','Camp / Clinic'],['tournament','Tournament']].map(([v,l])=>(
                      <button key={v} onClick={()=>setPaceType(v)}
                        style={{padding:'4px 10px',borderRadius:20,fontSize:11,fontWeight:700,border:'none',cursor:'pointer',
                          background:paceType===v?'#2563eb':'var(--surface-1)',color:paceType===v?'#fff':'var(--text-3)'}}>
                        {l}
                      </button>
                    ))}
                  </div>
                  {/* Metric toggle */}
                  <div style={{display:'flex',gap:4}}>
                    <span style={{fontSize:11,color:'var(--text-3)',fontWeight:600,marginRight:4}}>Show:</span>
                    {[['cum','Cumulative'],['daily','Daily New']].map(([v,l])=>(
                      <button key={v} onClick={()=>setPaceMetric(v)}
                        style={{padding:'4px 10px',borderRadius:20,fontSize:11,fontWeight:700,border:'none',cursor:'pointer',
                          background:paceMetric===v?'#2563eb':'var(--surface-1)',color:paceMetric===v?'#fff':'var(--text-3)'}}>
                        {l}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Year toggles + totals */}
                {yoyDaily && (
                  <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:12}}>
                    {[...yoyDaily.years].sort().reverse().map((y,i)=>{
                      const col = YEAR_COLORS[y]||COLORS[i%COLORS.length];
                      const totals = yoyDaily.byYear[y]?.totals;
                      const val = paceType==='all'?totals?.all:totals?.[paceType];
                      return (
                        <button key={y} onClick={()=>setPaceYears(p=>({...p,[y]:!p[y]}))}
                          style={{display:'flex',alignItems:'center',gap:6,padding:'6px 12px',borderRadius:8,border:`2px solid ${paceYears[y]?col:'var(--line)'}`,
                            background:paceYears[y]?col+'22':'var(--surface-2)',cursor:'pointer'}}>
                          <span style={{width:10,height:10,borderRadius:'50%',background:paceYears[y]?col:'var(--text-5)',display:'inline-block'}}/>
                          <span style={{fontSize:12,fontWeight:700,color:paceYears[y]?col:'var(--text-4)'}}>{y}</span>
                          <span style={{fontSize:11,color:'var(--text-3)'}}>{val??'—'}</span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {yoyDailyLoad && <div style={{color:'var(--text-3)',fontSize:13,padding:'20px 0'}}>Loading…</div>}

                {/* Chart */}
                {yoyDaily && (() => {
                  // Merge all visible years into a flat chart-data array
                  const visibleYears = (yoyDaily.years||[]).filter(y=>paceYears[y]);
                  const cumKey = paceType==='all'?'cum':`cum${paceType.charAt(0).toUpperCase()+paceType.slice(1)}`;
                  const dailyKey = paceType==='all'?'daily':`daily${paceType.charAt(0).toUpperCase()+paceType.slice(1)}`;

                  // Union of all days across visible years
                  const dayMap = {};
                  for (const y of visibleYears) {
                    for (const pt of (yoyDaily.byYear[y]?.cumByDay||[])) {
                      if (!dayMap[pt.day]) dayMap[pt.day] = { day:pt.day, date:pt.date };
                      dayMap[pt.day][`${y}_val`] = paceMetric==='cum' ? pt[cumKey] : pt[dailyKey];
                    }
                  }
                  const chartData = Object.values(dayMap).sort((a,b)=>a.day-b.day);
                  const intervalStep = Math.max(1,Math.floor(chartData.length/16));

                  if (!chartData.length) return <div style={{color:'var(--text-5)',fontSize:13}}>No data for selected filters.</div>;

                  return (
                    <ResponsiveContainer width="100%" height={340}>
                      <ComposedChart data={chartData} margin={{top:8,right:16,left:0,bottom:30}}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--surface-1)"/>
                        <XAxis dataKey="date" stroke="var(--text-5)" tick={{fill:'var(--text-3)',fontSize:10}}
                          angle={-35} textAnchor="end" interval={intervalStep}/>
                        <YAxis stroke="var(--text-5)" tick={{fill:'var(--text-3)',fontSize:11}}/>
                        <Tooltip
                          contentStyle={{background:'var(--surface-3)',border:'1px solid var(--line)',borderRadius:8,fontSize:12}}
                          labelStyle={{color:'var(--text-2)',marginBottom:4}}
                          formatter={(v,name)=>[v, name.replace('_val','')]}/>
                        <Legend wrapperStyle={{color:'var(--text-2)',fontSize:11,paddingTop:8}}/>
                        {visibleYears.map((y,i)=>{
                          const col = YEAR_COLORS[y]||COLORS[i%COLORS.length];
                          return paceMetric==='cum'
                            ? <Line key={y} type="monotone" dataKey={`${y}_val`} name={y} stroke={col} strokeWidth={2.5} dot={false} connectNulls/>
                            : <Bar key={y} dataKey={`${y}_val`} name={y} fill={col} opacity={0.7} radius={[2,2,0,0]}/>;
                        })}
                      </ComposedChart>
                    </ResponsiveContainer>
                  );
                })()}

                {/* Type breakdown summary table */}
                {yoyDaily && (
                  <div style={{marginTop:16,overflowX:'auto'}}>
                    <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                      <thead>
                        <tr style={{borderBottom:'1px solid var(--surface-1)'}}>
                          <th style={{textAlign:'left',padding:'6px 10px',color:'var(--text-3)',fontSize:10,textTransform:'uppercase'}}>Year</th>
                          <th style={{textAlign:'right',padding:'6px 10px',color:'var(--accent-light)',fontSize:10,textTransform:'uppercase'}}>Total</th>
                          <th style={{textAlign:'right',padding:'6px 10px',color:'#22c55e',fontSize:10,textTransform:'uppercase'}}>League</th>
                          <th style={{textAlign:'right',padding:'6px 10px',color:'#f97316',fontSize:10,textTransform:'uppercase'}}>Camp / Clinic</th>
                          <th style={{textAlign:'right',padding:'6px 10px',color:'#a855f7',fontSize:10,textTransform:'uppercase'}}>Tournament</th>
                          <th style={{textAlign:'right',padding:'6px 10px',color:'var(--text-4)',fontSize:10,textTransform:'uppercase'}}>vs Prior Yr</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[...yoyDaily.years].sort().reverse().map((y,i,arr)=>{
                          const t  = yoyDaily.byYear[y]?.totals||{};
                          const py = arr[i+1];
                          const pt = py ? yoyDaily.byYear[py]?.totals : null;
                          const delta = pt ? t.all - pt.all : null;
                          return (
                            <tr key={y} style={{borderBottom:'1px solid var(--surface-3)'}}>
                              <td style={{padding:'7px 10px',color:YEAR_COLORS[y]||'var(--text-2)',fontWeight:700}}>{y}</td>
                              <td style={{padding:'7px 10px',textAlign:'right',color:'var(--accent-light)',fontWeight:700}}>{t.all??0}</td>
                              <td style={{padding:'7px 10px',textAlign:'right',color:'#22c55e'}}>{t.league??0}</td>
                              <td style={{padding:'7px 10px',textAlign:'right',color:'#f97316'}}>{t.camp??0}</td>
                              <td style={{padding:'7px 10px',textAlign:'right',color:'#a855f7'}}>{t.tournament??0}</td>
                              <td style={{padding:'7px 10px',textAlign:'right'}}>
                                {delta===null ? <span style={{color:'var(--text-5)'}}>—</span>
                                  : <span style={{color:delta>=0?'#22c55e':'#ef4444',fontWeight:700}}>{delta>=0?'+':''}{delta}</span>}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                <p style={{color:'var(--text-5)',fontSize:11,marginTop:8,marginBottom:0}}>
                  X-axis = day of calendar year (Jan 1 – Dec 31), aligned so the same date compares across years.
                  League = 3-on-3 teams (1 registration = 1 team). Camp/Clinic = individual players. Tournament = single-elimination events.
                  Revenue data requires a separate SportsEngine price feed — not yet available.
                </p>
              </Panel>

              {/* ── Participant Retention Analysis ──────────────────── */}
              <Panel id="reports-panel-11" style={{marginBottom:16}}>
                <h2 style={{margin:'0 0 4px'}}>Participant Retention</h2>
                <p style={{color:'var(--text-4)',fontSize:12,margin:'0 0 14px'}}>
                  How many participants from one year's events came back the next year?
                  1 registration = 1 team (league) or 1 player (camp). Revenue shown if SportsEngine provides pricing.
                </p>

                {/* Source / Target selectors */}
                <div style={{display:'flex',gap:16,flexWrap:'wrap',marginBottom:12}}>
                  {[
                    {label:'Source year', year:retSrcYear, setYear:setRetSrcYear, type:retSrcType, setType:setRetSrcType, color:'#f97316'},
                    {label:'Target year', year:retTgtYear, setYear:setRetTgtYear, type:retTgtType, setType:setRetTgtType, color:'var(--accent-light)'},
                  ].map(({label,year,setYear,type,setType,color})=>(
                    <div key={label} style={{flex:1,minWidth:220,background:'var(--surface-3)',border:`1px solid ${color}44`,borderRadius:8,padding:'10px 12px'}}>
                      <div style={{fontSize:11,color,fontWeight:700,marginBottom:6}}>{label}</div>
                      <div style={{display:'flex',gap:4,flexWrap:'wrap',marginBottom:6}}>
                        {(yoyDaily?.years || [new Date().getFullYear()-1,new Date().getFullYear()].map(String)).filter(y=>/^20\d{2}$/.test(y)).sort().reverse().map(y=>(
                          <button key={y} onClick={()=>setYear(y)}
                            style={{padding:'3px 10px',borderRadius:20,fontSize:11,fontWeight:700,border:'none',cursor:'pointer',
                              background:year===y?color:'var(--surface-1)',color:year===y?'#fff':'var(--text-3)'}}>
                            {y}
                          </button>
                        ))}
                      </div>
                      <div style={{display:'flex',gap:4,flexWrap:'wrap'}}>
                        {[['all','All'],['league','League'],['camp','Camp'],['tournament','Tourn']].map(([v,l])=>(
                          <button key={v} onClick={()=>setType(v)}
                            style={{padding:'3px 8px',borderRadius:20,fontSize:10,fontWeight:700,border:'none',cursor:'pointer',
                              background:type===v?color+'33':'var(--surface-2)',color:type===v?color:'var(--text-4)',
                              outline:type===v?`1px solid ${color}`:'none'}}>
                            {l}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                  <div style={{display:'flex',alignItems:'flex-end'}}>
                    <button onClick={async()=>{
                      setRetLoading(true); setRetData(null); setRetExpanded(null);
                      try {
                        const r = await api.reportYoyRetention({sourceYear:retSrcYear,targetYear:retTgtYear,sourceType:retSrcType,targetType:retTgtType});
                        setRetData(r.data);
                      } catch(e){toast.error('Retention failed: '+e.message);}
                      finally{setRetLoading(false);}
                    }} disabled={retLoading}
                      style={{padding:'10px 20px',borderRadius:6,fontSize:13,fontWeight:700,border:'none',cursor:'pointer',
                        background:'#2563eb',color:'#fff',opacity:retLoading?0.6:1}}>
                      {retLoading?'Analyzing…':'▶ Analyze'}
                    </button>
                  </div>
                </div>

                {retData && (() => {
                  const {source,returned,lapsed,buckets,revenue} = retData;
                  const lapsedPct = source.uniqueParticipants ? Math.round(lapsed.count/source.uniqueParticipants*100) : 0;

                  function copyList(list, field) {
                    const vals = list.map(p=>p[field]).filter(Boolean);
                    if (!vals.length) return toast.error(`No ${field}s in lapsed list`);
                    navigator.clipboard.writeText(vals.join('\n'));
                    toast.success(`${vals.length} ${field}s copied`);
                  }
                  function downloadLapsed() {
                    const hdr = 'Email,Phone,Grad Year,Grade,Gender,City';
                    const rows = lapsed.participants.map(p=>[p.email||'',p.phone||'',p.gradYear||'',p.grade||'',p.gender||'',p.city||''].map(v=>`"${v}"`).join(','));
                    const blob = new Blob([hdr+'\n'+rows.join('\n')],{type:'text/csv'});
                    const url  = URL.createObjectURL(blob);
                    const a    = document.createElement('a'); a.href=url; a.download=`lapsed-${retSrcYear}-${retSrcType}.csv`; a.click();
                    URL.revokeObjectURL(url);
                  }

                  return (
                    <>
                      {/* Summary stats */}
                      <div style={{display:'flex',gap:10,flexWrap:'wrap',marginBottom:14}}>
                        {[
                          {label:`${retSrcYear} ${retSrcType==='all'?'all':retSrcType} registrations`, val:source.totalResults, color:'var(--text-2)', sub:'registration records'},
                          {label:`Unique participants (deduped)`, val:source.uniqueParticipants, color:'#f97316', sub:'1 person in 3 leagues = 1'},
                          {label:`Returned in ${retTgtYear}`, val:returned.unique, color:'#22c55e', sub:`${returned.pct}% of unique`},
                          {label:`Didn't return`, val:lapsed.count, color:'#ef4444', sub:`${lapsedPct}% — your outreach list`},
                          ...(revenue.hasData ? [{label:'Revenue from returned', val:`$${revenue.returned.toLocaleString()}`, color:'#a855f7', sub:`of $${revenue.allTarget.toLocaleString()} total ${retTgtYear}`}] : []),
                        ].map(s=>(
                          <div key={s.label} style={{background:'var(--surface-1)',borderRadius:8,padding:'8px 14px',minWidth:110}}>
                            <div style={{fontSize:9,color:'var(--text-4)',textTransform:'uppercase',letterSpacing:'0.5px'}}>{s.label}</div>
                            <div style={{fontSize:22,fontWeight:800,color:s.color}}>{s.val}</div>
                            {s.sub&&<div style={{fontSize:9,color:'var(--text-5)'}}>{s.sub}</div>}
                          </div>
                        ))}
                      </div>

                      {!revenue.hasData && (
                        <div style={{fontSize:11,color:'var(--text-4)',background:'var(--surface-3)',padding:'8px 12px',borderRadius:6,marginBottom:10}}>
                          Revenue data not yet available — run Backfill Contacts after the next aggregation to populate pricing fields from SportsEngine.
                        </div>
                      )}

                      {/* Where did they go — destination buckets */}
                      {buckets.length > 0 && (
                        <div style={{marginBottom:14}}>
                          <h3 style={{color:'var(--text-2)',fontSize:13,margin:'0 0 8px'}}>Where {retSrcYear} participants signed up in {retTgtYear}</h3>
                          {buckets.map((b,i)=>(
                            <div key={b.eventId} style={{border:'1px solid var(--surface-1)',borderLeft:`3px solid ${COLORS[i%COLORS.length]}`,borderRadius:6,marginBottom:4}}>
                              <div onClick={()=>setRetExpanded(x=>x===b.eventId?null:b.eventId)}
                                style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'8px 12px',cursor:'pointer',userSelect:'none'}}>
                                <div>
                                  <span style={{color:'var(--text-1)',fontSize:12,fontWeight:600}}>{b.eventName}</span>
                                  <span style={{color:'var(--text-4)',fontSize:10,marginLeft:8}}>{b.type}</span>
                                </div>
                                <div style={{display:'flex',gap:12,alignItems:'center'}}>
                                  <span style={{color:COLORS[i%COLORS.length],fontSize:18,fontWeight:800}}>{b.count}</span>
                                  <span style={{color:'var(--text-5)'}}>{retExpanded===b.eventId?'▲':'▼'}</span>
                                </div>
                              </div>
                              {retExpanded===b.eventId && (
                                <div style={{padding:'0 12px 10px'}}>
                                  <div style={{display:'flex',gap:6,marginBottom:6}}>
                                    {[['email','Emails'],['phone','Phones']].map(([f,l])=>(
                                      <button key={f} onClick={()=>{const v=b.participants.map(p=>p[f]).filter(Boolean);if(!v.length)return toast.error(`No ${f}s`);navigator.clipboard.writeText(v.join('\n'));toast.success(`${v.length} ${f}s copied`);}}
                                        style={{padding:'4px 10px',borderRadius:6,fontSize:11,fontWeight:700,border:'none',cursor:'pointer',background:'var(--chip-bg)',color:'var(--accent-light)'}}>
                                        Copy {l}
                                      </button>
                                    ))}
                                  </div>
                                  <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
                                    <thead><tr style={{borderBottom:'1px solid var(--surface-1)'}}>
                                      {['Email','Phone','Grad Yr (past)','Grad Yr (now)','Grade','Gender','City'].map(h=>(
                                        <th key={h} style={{textAlign:'left',padding:'4px 8px',color:'var(--text-3)',fontSize:9,textTransform:'uppercase'}}>{h}</th>
                                      ))}
                                    </tr></thead>
                                    <tbody>
                                      {b.participants.map((p,pi)=>(
                                        <tr key={pi} style={{borderBottom:'1px solid var(--surface-3)'}}>
                                          <td style={{padding:'4px 8px',color:'var(--accent-light)'}}>{p.email||'—'}</td>
                                          <td style={{padding:'4px 8px',color:'var(--accent-green)'}}>{p.phone||'—'}</td>
                                          <td style={{padding:'4px 8px',color:'#f97316'}}>{p.gradYearPast||'—'}</td>
                                          <td style={{padding:'4px 8px',color:'var(--accent-light)'}}>{p.gradYearNow||'—'}</td>
                                          <td style={{padding:'4px 8px',color:'var(--text-2)'}}>{p.grade||'—'}</td>
                                          <td style={{padding:'4px 8px',color:'var(--text-2)'}}>{p.gender||'—'}</td>
                                          <td style={{padding:'4px 8px',color:'var(--text-2)'}}>{p.city||'—'}</td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Lapsed / didn't return */}
                      <div style={{border:'1px solid rgba(239,68,68,0.3)',borderRadius:8,background:'rgba(239,68,68,0.1)',padding:'12px 14px'}}>
                        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:8,marginBottom:8}}>
                          <h3 style={{color:'#ef4444',margin:0}}>Didn't Return — {lapsed.count} ({lapsedPct}%)</h3>
                          <div style={{display:'flex',gap:6}}>
                            <button onClick={()=>copyList(lapsed.participants,'email')}
                              style={{padding:'5px 12px',borderRadius:6,fontSize:11,fontWeight:700,border:'none',cursor:'pointer',background:'var(--chip-bg)',color:'var(--accent-light)'}}>
                              Copy Emails
                            </button>
                            <button onClick={()=>copyList(lapsed.participants,'phone')}
                              style={{padding:'5px 12px',borderRadius:6,fontSize:11,fontWeight:700,border:'none',cursor:'pointer',background:'var(--chip-bg)',color:'var(--accent-light)'}}>
                              Copy Phones
                            </button>
                            <button onClick={downloadLapsed}
                              style={{padding:'5px 12px',borderRadius:6,fontSize:11,fontWeight:700,border:'none',cursor:'pointer',background:'var(--surface-3)',color:'var(--text-2)'}}>
                              ⬇ CSV
                            </button>
                          </div>
                        </div>
                        <p style={{color:'var(--text-4)',fontSize:11,margin:'0 0 8px'}}>
                          These {retSrcYear} {retSrcType==='all'?'participants':retSrcType+' participants'} have no matching registration in {retTgtYear}. Prime outreach targets.
                        </p>
                        {lapsed.participants.slice(0,5).map((p,i)=>(
                          <div key={i} style={{fontSize:11,color:'var(--text-3)',padding:'2px 0'}}>
                            {p.email||p.phone||'(no contact info)'} {p.gradYear?`· ${p.gradYear}`:''}
                          </div>
                        ))}
                        {lapsed.count>5 && <div style={{fontSize:11,color:'var(--text-5)',marginTop:4}}>…and {lapsed.count-5} more (download CSV for full list)</div>}
                      </div>
                    </>
                  );
                })()}
              </Panel>

              {yoyLoading && <div className="no-data">Computing year-over-year…</div>}
              {!yoyLoading && yoyData && (
                <>
                  <Panel id="reports-panel-12" style={{ marginBottom:12, padding:'12px 16px', background:'var(--bg-hover)', border:'1px solid var(--chip-bg)' }}>
                    <p style={{ margin:0, fontSize:13, color:'var(--accent-light)', lineHeight:1.6 }}>
                      <strong>How this works:</strong> Leagues are grouped by base name (year stripped).
                      "Maple Grove 2025" and "Maple Grove 2026" appear as one row.
                      Use this to compare ad performance season-over-season.
                    </p>
                  </Panel>

                  {/* Grouped bar chart */}
                  {yoyData.groups.length > 0 && yoyData.allYears.length > 1 && (
                    <Panel id="reports-panel-13">
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
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--surface-1)" horizontal={false}/>
                          <XAxis type="number" stroke="var(--text-5)" tick={{fill:'var(--text-3)'}}/>
                          <YAxis dataKey="name" type="category" stroke="var(--text-5)" tick={{fill:'var(--text-2)',fontSize:11}} width={190}/>
                          <Tooltip content={<ChartTip/>}/>
                          <Legend wrapperStyle={{color:'var(--text-2)',fontSize:12}}/>
                          {yoyData.allYears.map(y=>(
                            <Bar key={y} dataKey={y} name={y} fill={YEAR_COLORS[y]||COLORS[yoyData.allYears.indexOf(y)%COLORS.length]} radius={[0,3,3,0]}/>
                          ))}
                        </BarChart>
                      </ResponsiveContainer>
                    </Panel>
                  )}

                  {/* Detail table */}
                  <Panel id="reports-panel-14">
                    <h2>Season-over-Season Table</h2>
                    <div style={{overflowX:'auto',maxHeight:500,overflowY:'auto'}}>
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>#</th>
                            <th>League (base name)</th>
                            {yoyData.allYears.map(y=><th key={y} style={{color:YEAR_COLORS[y]||'var(--text-2)'}}>{y}</th>)}
                            <th>Total</th>
                            <th>YoY Δ</th>
                          </tr>
                        </thead>
                        <tbody>
                          {yoyData.groups.map((g,i)=>(
                            <tr key={i}>
                              <td style={{color:'var(--text-4)',fontSize:12}}>{i+1}</td>
                              <td style={{color:'var(--text-1)',fontWeight:500,maxWidth:260}}>{g.baseName}</td>
                              {yoyData.allYears.map(y=>(
                                <td key={y}>
                                  {g.years[y]
                                    ? <span style={{color:YEAR_COLORS[y]||'var(--accent-light)',fontWeight:700}}>{g.years[y].count}</span>
                                    : <span style={{color:'var(--text-5)'}}>—</span>}
                                </td>
                              ))}
                              <td><span className="badge badge-blue">{g.total}</span></td>
                              <td>
                                {g.delta !== null
                                  ? <Delta value={g.delta}/>
                                  : <span style={{color:'var(--text-5)',fontSize:12}}>—</span>}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Panel>
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
            // ── League Email Export helper ──────────────────────────────────────
            const leagueEmailCard = (
              <Panel id="reports-panel-15" style={{marginBottom:16}}>
                <h2 style={{margin:'0 0 4px'}}>All Emails for a League</h2>
                <p style={{color:'var(--text-4)',fontSize:12,margin:'0 0 12px'}}>
                  Pick any league to see every email and phone number across all its registrations — including all players on each team.
                </p>
                <div style={{display:'flex',gap:10,flexWrap:'wrap',alignItems:'flex-end',marginBottom:12}}>
                  <div style={{flex:2,minWidth:220}}>
                    <SearchableSelect value={emailExportId}
                      onChange={v=>{setEmailExportId(v);setEmailExportData(null);setEmailExportShowTable(false);}}
                      options={[{value:'',label:'Select a league…'},...filteredEvents.map(ev=>({value:String(ev.id),label:ev.name}))]}
                      placeholder="Search leagues…"/>
                  </div>
                  <button disabled={!emailExportId||emailExportLoad} onClick={async()=>{
                    setEmailExportLoad(true);
                    try{const r=await api.reportLeagueEmails(emailExportId);setEmailExportData(r.data);}
                    catch(e){toast.error('Failed: '+e.message);}
                    finally{setEmailExportLoad(false);}
                  }} style={{padding:'8px 18px',borderRadius:6,fontSize:12,fontWeight:700,border:'none',
                    cursor:emailExportId&&!emailExportLoad?'pointer':'not-allowed',
                    background:emailExportId?'#2563eb':'var(--surface-1)',color:emailExportId?'#fff':'var(--text-3)',
                    opacity:emailExportLoad?0.6:1}}>
                    {emailExportLoad?'Loading…':'▶ Load'}
                  </button>
                </div>

                {emailExportData && (() => {
                  const {eventName,totalRegistrations,uniqueEmails,uniquePhones,contacts} = emailExportData;
                  const showTable    = emailExportShowTable;
                  const setShowTable = setEmailExportShowTable;

                  function copy(list, type) {
                    if (!list.length) return toast.error('None available');
                    navigator.clipboard.writeText(list.join('\n'));
                    toast.success(`${list.length} ${type}s copied`);
                  }
                  function dlCSV() {
                    const hdr = 'Email,All Phones (registration),Grad Years,Grade,Gender,City,State';
                    const rows = [];
                    for (const c of contacts) {
                      const phonesStr = (c.phones||[]).join('; ');
                      const gradStr   = (c.gradYears||[]).join('; ');
                      const rest      = [gradStr, c.grade||'', c.gender||'', c.city||'', c.state||''];
                      if (c.emails?.length) {
                        for (const email of c.emails) {
                          rows.push([email, phonesStr, ...rest].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(','));
                        }
                      } else {
                        rows.push(['', phonesStr, ...rest].map(v=>`"${String(v).replace(/"/g,'""')}"`).join(','));
                      }
                    }
                    const blob = new Blob([hdr+'\n'+rows.join('\n')],{type:'text/csv'});
                    const url  = URL.createObjectURL(blob);
                    const a    = document.createElement('a');
                    a.href=url; a.download=`${eventName.replace(/\s+/g,'-')}-emails.csv`; a.click();
                    URL.revokeObjectURL(url);
                  }

                  return (
                    <>
                      <div style={{display:'flex',gap:10,flexWrap:'wrap',marginBottom:12}}>
                        {[
                          {label:'Registrations', val:totalRegistrations, color:'var(--text-2)'},
                          {label:'Unique Emails',  val:uniqueEmails.length, color:'var(--accent-light)', sub:'all players on all teams'},
                          {label:'Unique Phones',  val:uniquePhones.length, color:'var(--accent-green)'},
                        ].map(s=>(
                          <div key={s.label} style={{background:'var(--surface-1)',borderRadius:8,padding:'8px 14px',minWidth:100}}>
                            <div style={{fontSize:9,color:'var(--text-4)',textTransform:'uppercase'}}>{s.label}</div>
                            <div style={{fontSize:22,fontWeight:800,color:s.color}}>{s.val}</div>
                            {s.sub&&<div style={{fontSize:9,color:'var(--text-5)'}}>{s.sub}</div>}
                          </div>
                        ))}
                      </div>
                      <div style={{display:'flex',gap:6,flexWrap:'wrap',marginBottom:10}}>
                        <button onClick={()=>copy(uniqueEmails,'email')}
                          style={{padding:'6px 14px',borderRadius:6,fontSize:11,fontWeight:700,border:'none',cursor:'pointer',background:'var(--chip-bg)',color:'var(--accent-light)'}}>
                          Copy {uniqueEmails.length} Emails
                        </button>
                        <button onClick={()=>copy(uniquePhones,'phone')}
                          style={{padding:'6px 14px',borderRadius:6,fontSize:11,fontWeight:700,border:'none',cursor:'pointer',background:'var(--chip-bg)',color:'var(--accent-green)'}}>
                          Copy {uniquePhones.length} Phones
                        </button>
                        <button onClick={dlCSV}
                          style={{padding:'6px 14px',borderRadius:6,fontSize:11,fontWeight:700,border:'none',cursor:'pointer',background:'var(--surface-3)',color:'var(--text-2)'}}>
                          ⬇ CSV (one row per email)
                        </button>
                        <button onClick={()=>setShowTable(s=>!s)}
                          style={{padding:'6px 14px',borderRadius:6,fontSize:11,fontWeight:700,border:'none',cursor:'pointer',background:'var(--surface-1)',color:'var(--text-3)'}}>
                          {showTable?'▲ Hide table':'▼ Show all '+contacts.length+' registrations'}
                        </button>
                      </div>
                      {showTable && (
                        <div style={{overflowX:'auto',maxHeight:320,overflowY:'auto'}}>
                          <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
                            <thead><tr style={{borderBottom:'1px solid var(--surface-1)',position:'sticky',top:0,background:'var(--surface-3)'}}>
                              {['Emails (all players)','Phones','Grad Yrs','Grade','Gender','City'].map(h=>(
                                <th key={h} style={{textAlign:'left',padding:'5px 8px',color:'var(--text-3)',fontSize:9,textTransform:'uppercase',whiteSpace:'nowrap'}}>{h}</th>
                              ))}
                            </tr></thead>
                            <tbody>
                              {contacts.map((c,i)=>(
                                <tr key={i} style={{borderBottom:'1px solid var(--surface-3)',background:i%2===0?'transparent':'var(--surface-3)'}}>
                                  <td style={{padding:'5px 8px',maxWidth:260}}>
                                    {c.emails.map((e,ei)=>(
                                      <div key={ei}><a href={`mailto:${e}`} style={{color:'var(--accent-light)',textDecoration:'none',fontSize:10}}>{e}</a></div>
                                    ))}
                                  </td>
                                  <td style={{padding:'5px 8px'}}>
                                    {c.phones.map((p,pi)=>(
                                      <div key={pi} style={{color:'var(--accent-green)',fontSize:10}}>{p}</div>
                                    ))}
                                  </td>
                                  <td style={{padding:'5px 8px',color:'var(--text-2)'}}>{(c.gradYears||[]).join(', ')||'—'}</td>
                                  <td style={{padding:'5px 8px',color:'var(--text-2)'}}>{c.grade||'—'}</td>
                                  <td style={{padding:'5px 8px',color:'var(--text-2)'}}>{c.gender||'—'}</td>
                                  <td style={{padding:'5px 8px',color:'var(--text-2)'}}>{c.city||'—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </>
                  );
                })()}
              </Panel>
            );
            // ────────────────────────────────────────────────────────────────────
            const nameB = filteredEvents.find(e=>String(e.id)===compareEventB)?.name?.slice(0,32) || 'League B';

            // Custom tooltip showing daily count + cumulative for each league
            const CompareTip = ({ active, payload, label }) => {
              if (!active || !payload?.length) return null;
              const d = payload[0]?.payload || {};
              return (
                <div style={{ background:'var(--surface-3)', border:'1px solid var(--line)', borderRadius:10, padding:'12px 16px', minWidth:220 }}>
                  <p style={{ color:'var(--text-2)', fontSize:12, marginBottom:8, fontWeight:600 }}>{label}</p>
                  {compareEventA && (
                    <div style={{ marginBottom:8 }}>
                      <div style={{ color:'var(--accent-light)', fontSize:12, fontWeight:700, marginBottom:2 }}>{nameA}</div>
                      <div style={{ display:'flex', gap:16, fontSize:12 }}>
                        <span style={{ color:'var(--text-3)' }}>New: <span style={{ color:'var(--accent-light)', fontWeight:700 }}>{d.A||0}</span></span>
                        <span style={{ color:'var(--text-3)' }}>Total so far: <span style={{ color:'var(--info-text)', fontWeight:700 }}>{d.cumA||0}</span></span>
                      </div>
                    </div>
                  )}
                  {compareEventB && (
                    <div>
                      <div style={{ color:'#f97316', fontSize:12, fontWeight:700, marginBottom:2 }}>{nameB}</div>
                      <div style={{ display:'flex', gap:16, fontSize:12 }}>
                        <span style={{ color:'var(--text-3)' }}>New: <span style={{ color:'#f97316', fontWeight:700 }}>{d.B||0}</span></span>
                        <span style={{ color:'var(--text-3)' }}>Total so far: <span style={{ color:'#fdba74', fontWeight:700 }}>{d.cumB||0}</span></span>
                      </div>
                    </div>
                  )}
                  {compareAlign && (
                    <p style={{ color:'var(--text-5)', fontSize:10, marginTop:8, marginBottom:0 }}>
                      Year-aligned: same calendar day across both seasons
                    </p>
                  )}
                </div>
              );
            };

            return (
              <div>
                {leagueEmailCard}
                {/* League selectors + view controls */}
                <Panel id="reports-panel-16" style={{marginBottom:16}}>
                  <div style={{display:'flex',gap:16,flexWrap:'wrap',marginBottom:16}}>
                    <div style={{flex:1}}>
                      <label className="field-label" style={{color:'var(--accent-light)'}}>League A</label>
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
                  <div style={{display:'flex',gap:16,flexWrap:'wrap',alignItems:'center',borderTop:'1px solid var(--surface-1)',paddingTop:12}}>
                    <div>
                      <span style={{fontSize:11,color:'var(--text-3)',fontWeight:600,textTransform:'uppercase',letterSpacing:'0.5px',marginRight:8}}>Date Alignment</span>
                      <div style={{display:'inline-flex',gap:4,marginTop:4}}>
                        {[
                          {id:true,  label:'📅 Year-Aligned', desc:'May 23 ↔ May 23 across years'},
                          {id:false, label:'📆 Absolute Dates', desc:'Real calendar dates'},
                        ].map(({id,label,desc})=>(
                          <button key={String(id)} onClick={()=>setCompareAlign(id)}
                            style={{
                              padding:'5px 12px', borderRadius:6, fontSize:11, fontWeight:700, border:'none', cursor:'pointer',
                              background: compareAlign===id?'var(--chip-bg)':'var(--surface-1)',
                              color:      compareAlign===id?'var(--accent-light)':'var(--text-3)',
                            }} title={desc}>
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div>
                      <span style={{fontSize:11,color:'var(--text-3)',fontWeight:600,textTransform:'uppercase',letterSpacing:'0.5px',marginRight:8}}>Show</span>
                      <div style={{display:'inline-flex',gap:4,marginTop:4}}>
                        {[
                          {id:'both',       label:'Both'},
                          {id:'daily',      label:'Daily New'},
                          {id:'cumulative', label:'Cumulative'},
                        ].map(({id,label})=>(
                          <button key={id} onClick={()=>setCompareMetric(id)}
                            style={{
                              padding:'5px 12px', borderRadius:6, fontSize:11, fontWeight:700, border:'none', cursor:'pointer',
                              background: compareMetric===id?'var(--chip-bg)':'var(--surface-1)',
                              color:      compareMetric===id?'var(--accent-light)':'var(--text-3)',
                            }}>
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    {compareAlign && compareEventA && compareEventB && (
                      <span style={{fontSize:11,color:'var(--text-4)',marginLeft:'auto'}}>
                        Tip: pick the same league from different years (e.g. Maple Grove 2025 vs 2026)
                      </span>
                    )}
                  </div>
                </Panel>

                {/* League summary cards */}
                {(compareEventA||compareEventB) && (
                  <div className="grid-2" style={{marginBottom:16}}>
                    {[compareEventA,compareEventB].map((eid,si)=>{
                      const ev    = filteredEvents.find(e=>String(e.id)===eid);
                      const color = si===0?'var(--accent-light)':'#f97316';
                      const series = si===0 ? seriesA : seriesB;
                      const cumTotal = series.reduce((s,r)=>s+r.total,0);
                      return (
                        <div key={si} className="card" style={{borderTop:`3px solid ${color}`}}>
                          <h3 style={{color,marginBottom:8}}>League {si===0?'A':'B'}</h3>
                          {ev ? (
                            <>
                              <p style={{color:'var(--text-2)',fontSize:12,marginBottom:12}}>{ev.name}</p>
                              <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
                                <div style={{background:'var(--surface-1)',borderRadius:8,padding:'10px 14px',flex:1,minWidth:70}}>
                                  <div style={{color:'var(--text-3)',fontSize:10,textTransform:'uppercase',letterSpacing:'0.5px'}}>Stored</div>
                                  <div style={{color,fontSize:26,fontWeight:800}}>{ev.count}</div>
                                </div>
                                <div style={{background:'var(--surface-1)',borderRadius:8,padding:'10px 14px',flex:1,minWidth:70}}>
                                  <div style={{color:'var(--text-3)',fontSize:10,textTransform:'uppercase',letterSpacing:'0.5px'}}>In Period</div>
                                  <div style={{color,fontSize:26,fontWeight:800}}>{cumTotal}</div>
                                </div>
                                <div style={{background:'var(--surface-1)',borderRadius:8,padding:'10px 14px',flex:1,minWidth:70}}>
                                  <div style={{color:'var(--text-3)',fontSize:10,textTransform:'uppercase',letterSpacing:'0.5px'}}>Top Grad Yr</div>
                                  <div style={{color,fontSize:22,fontWeight:700}}>{ev.gradYears?.[0]?.name||'—'}</div>
                                </div>
                              </div>
                            </>
                          ) : (
                            <div style={{color:'var(--text-4)',fontSize:13}}>Select a league above</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Participant overlap — shown whenever both leagues are selected */}
                {compareEventA && compareEventB && compareEventA !== compareEventB && (
                  <LeagueOverlap
                    eventIdA={compareEventA} eventIdB={compareEventB}
                    nameA={nameA} nameB={nameB}
                  />
                )}

                {/* Main chart */}
                {compareData.length > 0 && (
                  <Panel id="reports-panel-17">
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:12,flexWrap:'wrap',gap:8}}>
                      <h2 style={{margin:0}}>
                        {compareAlign ? 'Year-Aligned' : 'Day-by-Day'} — {nameA} vs {nameB}
                      </h2>
                      {compareAlign && (
                        <span style={{fontSize:11,color:'var(--text-4)'}}>
                          X-axis = calendar month-day (year stripped) · hover for cumulative total
                        </span>
                      )}
                    </div>

                    <ResponsiveContainer width="100%" height={380}>
                      <ComposedChart data={compareData} margin={{top:10,right:20,left:0,bottom:30}}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--surface-1)"/>
                        <XAxis
                          dataKey="label"
                          stroke="var(--text-5)"
                          tick={{fill:'var(--text-3)',fontSize:10}}
                          angle={-35}
                          textAnchor="end"
                          interval={Math.max(0,Math.floor(compareData.length/16))}
                        />
                        {/* Left Y: daily new */}
                        <YAxis yAxisId="daily" stroke="var(--text-5)" tick={{fill:'var(--text-3)',fontSize:11}}
                          label={compareMetric!=='cumulative'?{value:'New',angle:-90,position:'insideLeft',fill:'var(--text-4)',fontSize:10}:undefined}/>
                        {/* Right Y: cumulative */}
                        {compareMetric!=='daily' && (
                          <YAxis yAxisId="cum" orientation="right" stroke="var(--text-5)" tick={{fill:'var(--text-3)',fontSize:11}}
                            label={{value:'Total',angle:90,position:'insideRight',fill:'var(--text-4)',fontSize:10}}/>
                        )}
                        <Tooltip content={<CompareTip/>}/>
                        <Legend wrapperStyle={{color:'var(--text-2)',fontSize:11,paddingTop:8}}/>

                        {/* Daily new bars */}
                        {compareMetric!=='cumulative' && compareEventA && (
                          <Bar yAxisId="daily" dataKey="A" name={`${nameA} (daily new)`} fill="var(--accent-light)" opacity={0.55} radius={[2,2,0,0]}/>
                        )}
                        {compareMetric!=='cumulative' && compareEventB && (
                          <Bar yAxisId="daily" dataKey="B" name={`${nameB} (daily new)`} fill="#f97316" opacity={0.55} radius={[2,2,0,0]}/>
                        )}

                        {/* Cumulative lines */}
                        {compareMetric!=='daily' && compareEventA && (
                          <Line yAxisId="cum" type="monotone" dataKey="cumA"
                            name={`${nameA} (cumulative)`} stroke="var(--accent-light)" strokeWidth={2.5} dot={false}/>
                        )}
                        {compareMetric!=='daily' && compareEventB && (
                          <Line yAxisId="cum" type="monotone" dataKey="cumB"
                            name={`${nameB} (cumulative)`} stroke="#f97316" strokeWidth={2.5} dot={false}/>
                        )}
                      </ComposedChart>
                    </ResponsiveContainer>

                    {/* Cumulative totals summary table */}
                    <div className="grid-2" style={{marginTop:16,gap:12}}>
                      {[
                        { key:'A', name:nameA, color:'var(--accent-light)', cum:compareData[compareData.length-1]?.cumA||0, data:seriesA },
                        { key:'B', name:nameB, color:'#f97316', cum:compareData[compareData.length-1]?.cumB||0, data:seriesB },
                      ].map(s=>(
                        <div key={s.key} style={{background:'var(--surface-3)',border:`1px solid ${s.color}33`,borderRadius:8,padding:'10px 14px'}}>
                          <div style={{fontSize:11,color:'var(--text-3)',marginBottom:4,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{s.name}</div>
                          <div style={{display:'flex',gap:16,flexWrap:'wrap'}}>
                            <div>
                              <div style={{fontSize:9,color:'var(--text-4)',textTransform:'uppercase',letterSpacing:'0.5px'}}>Cumulative in period</div>
                              <div style={{fontSize:22,fontWeight:800,color:s.color}}>{s.cum}</div>
                            </div>
                            <div>
                              <div style={{fontSize:9,color:'var(--text-4)',textTransform:'uppercase',letterSpacing:'0.5px'}}>Peak day</div>
                              <div style={{fontSize:22,fontWeight:800,color:s.color}}>
                                {Math.max(...(s.data.map(r=>r.total)||[0]))}
                              </div>
                            </div>
                            <div>
                              <div style={{fontSize:9,color:'var(--text-4)',textTransform:'uppercase',letterSpacing:'0.5px'}}>Active days</div>
                              <div style={{fontSize:22,fontWeight:800,color:s.color}}>{s.data.filter(r=>r.total>0).length}</div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </Panel>
                )}
                {/* Where Did They Go — scatter analysis */}
                <LeagueScatter events={filteredEvents} />
              </div>
            );
          })()}
        </>
      )}

      {/* ── Advanced / Data Management — collapsed by default ─────────────── */}
      <Collapsible
        title="⚙ Data Aggregation & Purge"
        subtitle="Quick purge-and-refetch, full mode control (year/type/custom selection), and the live console — for maintenance, not day-to-day use."
      >
        {/* ── Quick Purge & Re-fetch ──────────────────────────────────────── */}
        <Panel id="reports-panel-18" style={{ marginBottom:16, borderLeft:'3px solid var(--chip-bg)' }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:12 }}>
            <div>
              <h3 style={{ margin:'0 0 2px', fontSize:14 }}>Quick Purge & Re-fetch</h3>
              <p style={{ color:'var(--text-4)', fontSize:12, margin:0 }}>
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
        </Panel>

        {/* ── Aggregate panel ─────────────────────────────────────────────── */}
        <AggregatePanel
          orgId={orgId}
          recentRegs={recentRegs}
          onComplete={async (d) => {
            if (onAggComplete) onAggComplete(d);
            await loadAll();
            if (tab === 'yoy') { setYoyData(null); loadYoY(); }
          }}
        />
      </Collapsible>
    </div>
  );
}
