import React, { useEffect, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  Cell, ResponsiveContainer,
} from 'recharts';
import { api } from '../api.jsx';
import { toast } from 'react-hot-toast';
import { useNavigate } from 'react-router-dom';

const COLORS = ['#3b82f6','#f97316','#22c55e','#a855f7','#ec4899','#14b8a6','#eab308','#06b6d4','#f43f5e','#84cc16'];

const ChartTip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background:'#1e2235', border:'1px solid #2a2d3e', borderRadius:8, padding:'8px 12px' }}>
      <p style={{ color:'#94a3b8', fontSize:12, marginBottom:2 }}>{label}</p>
      {payload.map((p,i)=>(
        <p key={i} style={{ color:p.color||'#60a5fa', fontSize:14, fontWeight:600 }}>{p.name}: {p.value}</p>
      ))}
    </div>
  );
};

const SCENARIOS = [
  { id:'grad2025',  label:'Grad Year 2025',  gradFilter:'2025',      nav:false },
  { id:'grad2026',  label:'Grad Year 2026',  gradFilter:'2026',      nav:false },
  { id:'grad25_26', label:'2025 + 2026',     gradFilter:'2025,2026', nav:false },
  { id:'all',       label:'All Grad Years',  gradFilter:'',          nav:false },
  { id:'gender',    label:'Gender Split',    gradFilter:'',          nav:true  },
  { id:'geo',       label:'Geography',       gradFilter:'',          nav:true  },
];

export default function Dashboard({ ctx }) {
  const { orgId, selectedReg, recentRegs, setSelectedReg, refreshToken } = ctx;
  const navigate = useNavigate();
  const [singleData, setSingleData] = useState(null);
  const [aggData, setAggData]       = useState(null);
  const [loading, setLoading]       = useState(false);
  const [aggLoading, setAggLoading] = useState(false);
  const [activeScenario, setActiveScenario] = useState('all');
  const [gradFilter, setGradFilter] = useState('');

  useEffect(() => {
    if (selectedReg?.id && orgId) fetchSingle(selectedReg.id, orgId);
  }, [selectedReg, orgId]);

  useEffect(() => {
    if (orgId) fetchAggregate(orgId, '');
  }, [orgId, refreshToken]);

  async function fetchSingle(regId, oid) {
    setLoading(true);
    try {
      const res = await api.analyticsRegistration(regId, oid);
      setSingleData(res.data);
    } catch { toast.error('Failed to load event analytics'); }
    finally { setLoading(false); }
  }

  async function fetchAggregate(oid, gf = '') {
    setAggLoading(true);
    try {
      const res = await api.analyticsAggregate(oid, gf);
      setAggData(res.data);
    } catch { toast.error('Failed to load aggregate data'); }
    finally { setAggLoading(false); }
  }

  function runScenario(s) {
    setActiveScenario(s.id);
    setGradFilter(s.gradFilter);
    fetchAggregate(orgId, s.gradFilter);
    if (s.nav) navigate('/analytics');
  }

  const displayGradYears = aggData
    ? (gradFilter
        ? aggData.graduationYear.filter(d => gradFilter.split(',').includes(d.name))
        : aggData.graduationYear)
    : [];

  const top25 = aggData?.graduationYear?.find(d => d.name === '2025');
  const top26 = aggData?.graduationYear?.find(d => d.name === '2026');

  return (
    <div>
      <div className="page-header">
        <h1>Dashboard — Last 90 Days</h1>
        <p>Midwest 3 on 3 · {recentRegs.length} events loaded · read-only view</p>
      </div>

      <div className="card" style={{ marginBottom:20 }}>
        <h2 style={{marginBottom:4}}>Quick Scenarios</h2>
        <p style={{color:'#475569',fontSize:13,marginBottom:14}}>
          Click to instantly analyze graduation year data across all events.
          Results are cached after first load.
        </p>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
          {SCENARIOS.map(s => (
            <button key={s.id} onClick={() => runScenario(s)}
              style={{
                padding:'9px 18px', borderRadius:8, fontSize:13, fontWeight:700,
                border:'none', cursor:'pointer', transition:'all 0.15s',
                background: activeScenario===s.id ? '#2563eb' : '#1e2235',
                color: activeScenario===s.id ? '#fff' : '#94a3b8',
                outline: activeScenario===s.id ? '2px solid #3b82f6' : 'none',
              }}>
              {s.label}
            </button>
          ))}
        </div>
        {aggLoading && (
          <p style={{color:'#64748b',fontSize:12,marginTop:10}}>
            Aggregating across {recentRegs.length} events — first load takes ~30-60s, then cached for 10min
          </p>
        )}
      </div>

      <div className="grid-4" style={{ marginBottom:20 }}>
        <div className="stat-card">
          <div className="stat-label">Total Teams (all events)</div>
          <div className="stat-value" style={{color:'#60a5fa'}}>{aggLoading?'…':aggData?.total??'—'}</div>
          <div className="stat-sub">{aggData?.registrationsAnalyzed||'—'} events</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">2025 Grad Players</div>
          <div className="stat-value" style={{color:'#f97316'}}>{aggLoading?'…':top25?.count??'—'}</div>
          <div className="stat-sub">{aggData&&top25?((top25.count/aggData.total*100).toFixed(1))+'%':''}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">2026 Grad Players</div>
          <div className="stat-value" style={{color:'#22c55e'}}>{aggLoading?'…':top26?.count??'—'}</div>
          <div className="stat-sub">{aggData&&top26?((top26.count/aggData.total*100).toFixed(1))+'%':''}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Top State</div>
          <div className="stat-value" style={{color:'#a855f7',fontSize:28}}>{aggLoading?'…':aggData?.state?.[0]?.name??'—'}</div>
          <div className="stat-sub">{aggData?.state?.[0]?.count??''} teams</div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h2>Grad Year — Last 90 Days{gradFilter ? ` (${gradFilter})` : ''}</h2>
          {aggLoading && <div className="no-data">Aggregating all events…</div>}
          {!aggLoading && displayGradYears.length > 0 && (
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={[...displayGradYears].sort((a,b)=>a.name.localeCompare(b.name))} margin={{top:8,right:12,left:0,bottom:24}}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3e" />
                <XAxis dataKey="name" stroke="#475569" tick={{fill:'#64748b',fontSize:12}} angle={-30} textAnchor="end" interval={0} />
                <YAxis stroke="#475569" tick={{fill:'#64748b',fontSize:12}} />
                <Tooltip content={<ChartTip />} />
                <Bar dataKey="count" name="Players" radius={[4,4,0,0]}>
                  {displayGradYears.map((_,i) => <Cell key={i} fill={COLORS[i%COLORS.length]} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
          {!aggLoading && displayGradYears.length===0 && <div className="no-data">Select a scenario above</div>}
        </div>

        <div className="card">
          <h2>Selected Event</h2>
          <p style={{color:'#475569',fontSize:12,marginBottom:12}}>{selectedReg?.name||'—'}</p>
          {loading && <div className="no-data">Loading…</div>}
          {!loading && singleData && (
            <>
              <div style={{display:'flex',gap:10,marginBottom:14,flexWrap:'wrap'}}>
                {[
                  {label:'Teams',   val:singleData.total,                          color:'#60a5fa'},
                  {label:'Top Year',val:singleData.graduationYear?.[0]?.name||'—', color:'#f97316'},
                  {label:'State',   val:singleData.state?.[0]?.name||'—',          color:'#22c55e'},
                ].map(s => (
                  <div key={s.label} style={{background:'#1e2235',borderRadius:8,padding:'10px 14px',flex:1,minWidth:70}}>
                    <div style={{color:'#64748b',fontSize:10,textTransform:'uppercase'}}>{s.label}</div>
                    <div style={{color:s.color,fontSize:22,fontWeight:700}}>{s.val}</div>
                  </div>
                ))}
              </div>
              <table className="data-table">
                <thead><tr><th>Grad Year</th><th>Players</th><th>%</th></tr></thead>
                <tbody>
                  {(singleData.graduationYear||[]).map((row,i) => (
                    <tr key={row.name}>
                      <td style={{color:COLORS[i%COLORS.length],fontWeight:700}}>{row.name}</td>
                      <td><span className="badge badge-blue">{row.count}</span></td>
                      <td style={{color:'#64748b'}}>{singleData.total>0?((row.count/singleData.total)*100).toFixed(1):0}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {!loading && !singleData && <div className="no-data">Select an event in the sidebar</div>}
        </div>
      </div>

      {!aggLoading && aggData?.registrationSummary?.length > 0 && (
        <div className="card">
          <h2>Events by Registrations (all events) — click to deep-dive</h2>
          <table className="data-table">
            <thead><tr><th>#</th><th>Event</th><th>Teams</th><th>Share</th></tr></thead>
            <tbody>
              {aggData.registrationSummary.slice(0,25).map((r,i) => (
                <tr key={r.id} style={{cursor:'pointer'}} onClick={() => {
                  const reg = recentRegs.find(x => String(x.id)===String(r.id));
                  if (reg) { setSelectedReg(reg); navigate('/analytics'); }
                }}>
                  <td style={{color:'#475569',fontSize:12}}>{i+1}</td>
                  <td style={{color:'#e2e8f0'}}>{r.name}</td>
                  <td><span className="badge badge-orange">{r.teams}</span></td>
                  <td style={{width:180}}>
                    <div style={{display:'flex',alignItems:'center',gap:8}}>
                      <div style={{background:'#1e2235',borderRadius:4,height:7,flex:1}}>
                        <div style={{background:COLORS[i%COLORS.length],width:`${(r.teams/(aggData.registrationSummary[0]?.teams||1))*100}%`,height:'100%',borderRadius:4}} />
                      </div>
                      <span style={{color:'#475569',fontSize:11}}>{aggData.total>0?(r.teams/aggData.total*100).toFixed(1):0}%</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
