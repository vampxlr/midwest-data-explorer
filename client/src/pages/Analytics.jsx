import React, { useEffect, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  PieChart, Pie, Cell, ResponsiveContainer, AreaChart, Area,
} from 'recharts';
import { api } from '../api.jsx';
import { toast } from 'react-hot-toast';
import AggregatePanel from '../components/AggregatePanel.jsx';
import Panel from '../components/Panel.jsx';

const COLORS = ['#3b82f6','#f97316','#22c55e','#a855f7','#ec4899','#14b8a6','#eab308','#06b6d4','#f43f5e','#84cc16'];

const ChartTip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background:'var(--surface-1)', border:'1px solid var(--line)', borderRadius:8, padding:'8px 12px' }}>
      <p style={{ color:'var(--text-2)', fontSize:12, marginBottom:2 }}>{label}</p>
      {payload.map((p,i) => (
        <p key={i} style={{ color:p.color||'var(--accent-light)', fontSize:14, fontWeight:600 }}>{p.name}: {p.value}</p>
      ))}
    </div>
  );
};

// Scenario preset buttons
const SCENARIOS = [
  { id:'gy_all',    label:'All Grad Years',  tab:'gradYear', filter:'',          desc:'Full breakdown of all graduation years' },
  { id:'gy_2025',   label:'2025 Only',       tab:'gradYear', filter:'2025',      desc:'Only 2025 graduating players' },
  { id:'gy_2026',   label:'2026 Only',       tab:'gradYear', filter:'2026',      desc:'Only 2026 graduating players' },
  { id:'gy_25_26',  label:'2025 + 2026',     tab:'gradYear', filter:'2025,2026', desc:'Combined 2025 and 2026' },
  { id:'gy_recent', label:'2025-2030',       tab:'gradYear', filter:'2025,2026,2027,2028,2029,2030', desc:'All near-future grad years' },
  { id:'div',       label:'By Division',     tab:'division', filter:'',          desc:'Which division/age group has most teams' },
  { id:'gender',    label:'Gender',          tab:'gender',   filter:'',          desc:'Boys vs Girls split' },
  { id:'geo',       label:'Geography',       tab:'geography',filter:'',          desc:'State and city distribution' },
];

export default function Analytics({ ctx }) {
  const { orgId, selectedReg, recentRegs = [], onAggComplete, refreshToken } = ctx;
  const [data, setData]           = useState(null);
  const [aggData, setAggData]     = useState(null);
  const [loading, setLoading]     = useState(false);
  const [aggLoading, setAggLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('gradYear');
  const [activeScenario, setActiveScenario] = useState('gy_all');
  const [gradFilter, setGradFilter] = useState('');
  const [mode, setMode]           = useState('single'); // 'single' | 'aggregate'
  const [showPanel, setShowPanel] = useState(false);
  const [quickLoading, setQuickLoading] = useState('');

  useEffect(() => {
    if (selectedReg?.id && orgId) fetchSingle(selectedReg.id, orgId);
  }, [selectedReg, orgId, refreshToken]);

  useEffect(() => {
    if (orgId && mode === 'aggregate') fetchAgg(orgId, gradFilter);
  }, [mode, orgId, refreshToken]);

  async function fetchSingle(regId, oid) {
    setLoading(true);
    try {
      const res = await api.analyticsRegistration(regId, oid);
      setData(res.data);
    } catch { toast.error('Failed to load analytics'); }
    finally { setLoading(false); }
  }

  async function fetchAgg(oid, gf = '') {
    setAggLoading(true);
    try {
      const res = await api.analyticsAggregate(oid, gf);
      setAggData(res.data);
    } catch { toast.error('Failed to load aggregate data'); }
    finally { setAggLoading(false); }
  }

  async function startQuickAgg(which) {
    const eventsToFetch = recentRegs.filter(r => which==='open' ? r.status===1 : r.status!==1);
    if (!eventsToFetch.length) { toast('No matching events found'); return; }
    setQuickLoading(which);
    try {
      const res = await api.startAggregate(orgId, 1200, eventsToFetch, true);
      if (res.data.started) toast.success(`Started — ${eventsToFetch.length} ${which} events`);
      else toast.error(res.data.message);
    } catch (err) { toast.error('Failed: ' + err.message); }
    finally { setQuickLoading(''); }
  }

  function runScenario(s) {
    setActiveScenario(s.id);
    setActiveTab(s.tab);
    setGradFilter(s.filter);
    if (mode === 'aggregate' || s.id.startsWith('gy_')) {
      setMode('aggregate');
      fetchAgg(orgId, s.filter);
    }
  }

  const displayData = mode === 'aggregate' ? aggData : data;
  const isLoading   = mode === 'aggregate' ? aggLoading : loading;

  const displayGradYears = displayData
    ? (gradFilter && mode === 'aggregate'
        ? (displayData.graduationYear||[]).filter(d => gradFilter.split(',').includes(d.name))
        : displayData.graduationYear||[])
    : [];

  if (isLoading) return <div className="loading-screen"><div className="spinner" /><p>Loading analytics…</p></div>;
  if (!selectedReg && mode==='single') return <div className="no-data" style={{marginTop:60}}>Select an event from the sidebar.</div>;

  return (
    <div>
      <div className="page-header">
        <h1>Analytics</h1>
        <p>
          {mode==='aggregate'
            ? `All events · ${aggData?.registrationsAnalyzed||'—'} events · ${aggData?.total||'—'} teams`
            : `${selectedReg?.name||'—'} · ${data?.total||'—'} teams`}
        </p>
      </div>

      {/* ── Data panel (collapsible) ────────────────────────────────────── */}
      <Panel id="analytics-panel-1" style={{ marginBottom:16, borderLeft:'3px solid var(--chip-bg)' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:12 }}>
          <div>
            <h3 style={{ margin:'0 0 2px', fontSize:14 }}>Data Fetching</h3>
            <p style={{ color:'var(--text-4)', fontSize:12, margin:0 }}>
              Fetch or refresh data from SportsEngine to update analytics.
            </p>
          </div>
          <div style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'center' }}>
            <button className="btn-action-green" onClick={() => startQuickAgg('open')} disabled={!!quickLoading}
              style={{ opacity:quickLoading&&quickLoading!=='open'?0.4:1 }}>
              {quickLoading==='open' ? '⏳…' : `↺ Re-fetch Open (${recentRegs.filter(r=>r.status===1).length})`}
            </button>
            <button className="btn-action-orange" onClick={() => startQuickAgg('closed')} disabled={!!quickLoading}
              style={{ opacity:quickLoading&&quickLoading!=='closed'?0.4:1 }}>
              {quickLoading==='closed' ? '⏳…' : `↺ Re-fetch Closed (${recentRegs.filter(r=>r.status!==1).length})`}
            </button>
            <button onClick={() => setShowPanel(p=>!p)}
              style={{ padding:'7px 14px', borderRadius:8, fontSize:12, fontWeight:600, border:'1px solid var(--line)',
                cursor:'pointer', background:'var(--surface-1)', color:'var(--text-3)' }}>
              {showPanel ? '▲ Hide Panel' : '▼ Full Panel'}
            </button>
          </div>
        </div>
        {showPanel && (
          <div style={{ marginTop:12, borderTop:'1px solid var(--surface-1)', paddingTop:12 }}>
            <AggregatePanel
              orgId={orgId}
              recentRegs={recentRegs}
              onComplete={async (d) => {
                if (onAggComplete) onAggComplete(d);
                if (selectedReg?.id && mode==='single') fetchSingle(selectedReg.id, orgId);
                if (mode==='aggregate') fetchAgg(orgId, gradFilter);
              }}
            />
          </div>
        )}
      </Panel>

      {/* Mode toggle */}
      <div style={{display:'flex',gap:8,marginBottom:16}}>
        <button onClick={()=>{setMode('single');if(selectedReg?.id&&orgId)fetchSingle(selectedReg.id,orgId);}}
          style={{padding:'8px 18px',borderRadius:8,fontSize:13,fontWeight:700,border:'none',cursor:'pointer',
            background:mode==='single'?'#2563eb':'var(--surface-1)',color:mode==='single'?'#fff':'var(--text-3)'}}>
          Single Event
        </button>
        <button onClick={()=>{setMode('aggregate');fetchAgg(orgId,gradFilter);}}
          style={{padding:'8px 18px',borderRadius:8,fontSize:13,fontWeight:700,border:'none',cursor:'pointer',
            background:mode==='aggregate'?'#2563eb':'var(--surface-1)',color:mode==='aggregate'?'#fff':'var(--text-3)'}}>
          All Events (Aggregate)
        </button>
      </div>

      {/* Scenario buttons */}
      <Panel id="analytics-panel-2" style={{marginBottom:16}}>
        <h3 style={{marginBottom:10,color:'var(--text-2)'}}>Pre-built Scenarios</h3>
        <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
          {SCENARIOS.map(s => (
            <button key={s.id} onClick={()=>runScenario(s)} title={s.desc}
              style={{
                padding:'7px 14px',borderRadius:6,fontSize:12,fontWeight:600,
                border:'none',cursor:'pointer',transition:'all 0.15s',
                background:activeScenario===s.id?'#1d4ed8':'var(--surface-1)',
                color:activeScenario===s.id?'#fff':'var(--text-2)',
                outline:activeScenario===s.id?'1.5px solid #3b82f6':'none',
              }}>
              {s.label}
            </button>
          ))}
        </div>
        {aggLoading && <p style={{color:'var(--text-4)',fontSize:12,marginTop:8}}>Aggregating {recentRegs.length} events…</p>}
      </Panel>

      {/* Tabs */}
      <div className="tabs">
        {['gradYear','division','gender','geography'].map(t => (
          <button key={t} className={`tab ${activeTab===t?'active':''}`} onClick={()=>setActiveTab(t)}>
            {t==='gradYear'?'Graduation Year':t==='division'?'Division':t==='gender'?'Gender':'Geography'}
          </button>
        ))}
      </div>

      {activeTab==='gradYear' && <GradYearTab rows={displayGradYears} total={displayData?.total||0} label={gradFilter||'all years'} />}
      {activeTab==='division' && <DivisionTab data={displayData} />}
      {activeTab==='gender'   && <GenderTab   data={displayData} />}
      {activeTab==='geography'&& <GeoTab      data={displayData} />}
    </div>
  );
}

function GradYearTab({ rows, total, label }) {
  const sorted = [...rows].sort((a,b) => a.name.localeCompare(b.name));
  if (!rows.length) return <div className="no-data">No data. Run a scenario or switch to Aggregate mode.</div>;
  return (
    <div>
      <Panel id="analytics-panel-3">
        <h2>Registrants by Graduation Year — {label}</h2>
        <ResponsiveContainer width="100%" height={360}>
          <BarChart data={sorted} margin={{top:10,right:20,left:0,bottom:24}}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
            <XAxis dataKey="name" stroke="var(--text-4)" tick={{fill:'var(--text-3)',fontSize:12}} angle={-30} textAnchor="end" interval={0} />
            <YAxis stroke="var(--text-4)" tick={{fill:'var(--text-3)',fontSize:12}} />
            <Tooltip content={<ChartTip />} />
            <Bar dataKey="count" name="Players" radius={[4,4,0,0]}>
              {sorted.map((_,i) => <Cell key={i} fill={COLORS[i%COLORS.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Panel>
      <div className="grid-2">
        <Panel id="analytics-panel-4">
          <h2>Pie Distribution</h2>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie data={rows} dataKey="count" nameKey="name" cx="50%" cy="50%" outerRadius={110}
                label={({name,percent})=>`${name}: ${(percent*100).toFixed(0)}%`}>
                {rows.map((_,i) => <Cell key={i} fill={COLORS[i%COLORS.length]} />)}
              </Pie>
              <Tooltip content={<ChartTip />} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </Panel>
        <Panel id="analytics-panel-5">
          <h2>Trend (Area)</h2>
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={sorted} margin={{top:10,right:20,left:0,bottom:24}}>
              <defs>
                <linearGradient id="gBlue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
              <XAxis dataKey="name" stroke="var(--text-4)" tick={{fill:'var(--text-3)',fontSize:11}} angle={-30} textAnchor="end" />
              <YAxis stroke="var(--text-4)" tick={{fill:'var(--text-3)',fontSize:12}} />
              <Tooltip content={<ChartTip />} />
              <Area type="monotone" dataKey="count" name="Players" stroke="#3b82f6" fill="url(#gBlue)" />
            </AreaChart>
          </ResponsiveContainer>
        </Panel>
      </div>
      <Panel id="analytics-panel-6">
        <h2>Detail Table</h2>
        <table className="data-table">
          <thead><tr><th>Grad Year</th><th>Players</th><th>%</th><th>Bar</th></tr></thead>
          <tbody>
            {rows.map((row,i) => (
              <tr key={row.name}>
                <td style={{color:COLORS[i%COLORS.length],fontWeight:700}}>{row.name}</td>
                <td><span className="badge badge-blue">{row.count}</span></td>
                <td style={{color:'var(--text-3)'}}>{total>0?((row.count/total)*100).toFixed(2):0}%</td>
                <td style={{width:200}}>
                  <div style={{background:'var(--surface-1)',borderRadius:4,height:8}}>
                    <div style={{background:COLORS[i%COLORS.length],width:`${(row.count/(rows[0]?.count||1))*100}%`,height:'100%',borderRadius:4}} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

function DivisionTab({ data }) {
  const rows = data?.division || [];
  const sorted = [...rows].sort((a,b)=>a.name.localeCompare(b.name));
  return (
    <div>
      <Panel id="analytics-panel-7">
        <h2>Teams by Division</h2>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={sorted} margin={{top:10,right:20,left:0,bottom:24}}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
            <XAxis dataKey="name" stroke="var(--text-4)" tick={{fill:'var(--text-3)',fontSize:12}} angle={-30} textAnchor="end" interval={0} />
            <YAxis stroke="var(--text-4)" tick={{fill:'var(--text-3)',fontSize:12}} />
            <Tooltip content={<ChartTip />} />
            <Bar dataKey="count" name="Teams" radius={[4,4,0,0]}>
              {sorted.map((_,i) => <Cell key={i} fill={COLORS[i%COLORS.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Panel>
      <div className="grid-2">
        <Panel id="analytics-panel-8">
          <h2>Division Pie</h2>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie data={rows} dataKey="count" nameKey="name" cx="50%" cy="50%" outerRadius={110}
                label={({name,percent})=>`${name}: ${(percent*100).toFixed(0)}%`}>
                {rows.map((_,i) => <Cell key={i} fill={COLORS[i%COLORS.length]} />)}
              </Pie>
              <Tooltip content={<ChartTip />} />
            </PieChart>
          </ResponsiveContainer>
        </Panel>
        <Panel id="analytics-panel-9">
          <h2>Division Table</h2>
          <table className="data-table">
            <thead><tr><th>Division</th><th>Teams</th><th>%</th></tr></thead>
            <tbody>
              {rows.map((row,i) => (
                <tr key={row.name}>
                  <td style={{color:COLORS[i%COLORS.length],fontWeight:700}}>{row.name}</td>
                  <td><span className="badge badge-blue">{row.count}</span></td>
                  <td style={{color:'var(--text-3)'}}>{data?.total>0?((row.count/data.total)*100).toFixed(1):0}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </div>
  );
}

function GenderTab({ data }) {
  const rows = data?.gender || [];
  return (
    <div className="grid-2">
      <Panel id="analytics-panel-10">
        <h2>Gender — Pie</h2>
        <ResponsiveContainer width="100%" height={320}>
          <PieChart>
            <Pie data={rows} dataKey="count" nameKey="name" cx="50%" cy="50%" outerRadius={120}
              label={({name,percent})=>`${name} ${(percent*100).toFixed(1)}%`}>
              {rows.map((_,i) => <Cell key={i} fill={COLORS[i%COLORS.length]} />)}
            </Pie>
            <Tooltip content={<ChartTip />} />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      </Panel>
      <Panel id="analytics-panel-11">
        <h2>Gender — Bar</h2>
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={rows} margin={{top:10,right:20,left:0,bottom:10}}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" />
            <XAxis dataKey="name" stroke="var(--text-4)" tick={{fill:'var(--text-3)'}} />
            <YAxis stroke="var(--text-4)" tick={{fill:'var(--text-3)'}} />
            <Tooltip content={<ChartTip />} />
            <Bar dataKey="count" name="Teams" radius={[4,4,0,0]}>
              {rows.map((_,i) => <Cell key={i} fill={COLORS[i%COLORS.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <table className="data-table" style={{marginTop:12}}>
          <thead><tr><th>Gender</th><th>Count</th><th>%</th></tr></thead>
          <tbody>
            {rows.map((row,i) => (
              <tr key={row.name}>
                <td style={{color:COLORS[i%COLORS.length]}}>{row.name}</td>
                <td style={{color:'var(--text-1)'}}>{row.count}</td>
                <td style={{color:'var(--text-3)'}}>{data?.total>0?((row.count/data.total)*100).toFixed(1):0}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}

function GeoTab({ data }) {
  const top10States = (data?.state||[]).slice(0,10);
  const top15Cities = (data?.city||[]).slice(0,15);
  return (
    <div>
      <Panel id="analytics-panel-12">
        <h2>Top 10 States</h2>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={top10States} layout="vertical" margin={{top:10,right:30,left:30,bottom:10}}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" horizontal={false} />
            <XAxis type="number" stroke="var(--text-4)" tick={{fill:'var(--text-3)'}} />
            <YAxis dataKey="name" type="category" stroke="var(--text-4)" tick={{fill:'var(--text-2)',fontSize:13}} width={40} />
            <Tooltip content={<ChartTip />} />
            <Bar dataKey="count" name="Teams" radius={[0,4,4,0]}>
              {top10States.map((_,i) => <Cell key={i} fill={COLORS[i%COLORS.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Panel>
      <div className="grid-2">
        <Panel id="analytics-panel-13">
          <h2>State Pie</h2>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie data={top10States} dataKey="count" nameKey="name" cx="50%" cy="50%" outerRadius={110}
                label={({name,percent})=>`${name} ${(percent*100).toFixed(0)}%`}>
                {top10States.map((_,i) => <Cell key={i} fill={COLORS[i%COLORS.length]} />)}
              </Pie>
              <Tooltip content={<ChartTip />} />
            </PieChart>
          </ResponsiveContainer>
        </Panel>
        <Panel id="analytics-panel-14">
          <h2>Top Cities</h2>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={top15Cities} layout="vertical" margin={{top:0,right:20,left:60,bottom:0}}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--line)" horizontal={false} />
              <XAxis type="number" stroke="var(--text-4)" tick={{fill:'var(--text-3)',fontSize:11}} />
              <YAxis dataKey="name" type="category" stroke="var(--text-4)" tick={{fill:'var(--text-2)',fontSize:11}} width={55} />
              <Tooltip content={<ChartTip />} />
              <Bar dataKey="count" name="Teams" fill="#22c55e" radius={[0,4,4,0]} />
            </BarChart>
          </ResponsiveContainer>
        </Panel>
      </div>
      <Panel id="analytics-panel-15">
        <h2>All States</h2>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(140px,1fr))',gap:8}}>
          {(data?.state||[]).map((row,i) => (
            <div key={row.name} style={{background:'var(--surface-1)',borderRadius:8,padding:'10px 14px',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <span style={{color:'var(--text-2)',fontSize:14}}>{row.name}</span>
              <span style={{color:COLORS[i%COLORS.length],fontWeight:700}}>{row.count}</span>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
