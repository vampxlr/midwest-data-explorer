import React, { useEffect, useState } from 'react';
import {
  BarChart, Bar, XAxis, Tooltip, ResponsiveContainer, Cell,
} from 'recharts';
import { api } from '../api.jsx';
import { toast } from 'react-hot-toast';

const COLORS = ['#3b82f6','#f97316','#22c55e','#a855f7','#ec4899','#14b8a6','#eab308','#06b6d4','#f43f5e','#84cc16'];

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
function fmtFull(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric', year:'numeric' });
}

// Identical to Reports' "Daily Activity" tab — which leagues registered
// today/any day — extracted so it can be reused at the top of the Dashboard.
export default function DailyActivityPanel({ recentRegs = [], refreshToken }) {
  const [activityDate, setActivityDate] = useState(todayCDT());
  const [activityData, setActivityData] = useState(null);
  const [activityLoading, setActivityLoading] = useState(false);

  useEffect(() => { loadActivity(activityDate); }, [refreshToken]);

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

  const openIds = new Set(recentRegs.filter(r => r.status === 1).map(r => String(r.id)));

  return (
    <div>
      {/* Date navigator */}
      <div className="card" style={{ marginBottom:16 }}>
        <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
          <button onClick={()=>navDay(-1)} className="btn-secondary" style={{margin:0,padding:'8px 14px',fontSize:18}}>←</button>
          <div style={{ flex:1, textAlign:'center' }}>
            <div style={{ fontSize:18, fontWeight:700, color:'var(--text-1)' }}>
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
              <div className="stat-value" style={{ color:'var(--text-2)' }}>{activityData.prevWeekTotal}</div>
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
                  <XAxis dataKey="label" stroke="var(--text-5)" tick={{fill:'var(--text-3)',fontSize:11}}/>
                  <Tooltip content={<ChartTip/>}/>
                  <Bar dataKey="total" name="Registrations" radius={[4,4,0,0]}>
                    {activityData.weekDays.map((d,i)=>(
                      <Cell key={i} fill={d.date===activityDate?'#3b82f6':'var(--chip-bg)'}/>
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
                        <td style={{color:'var(--text-4)',fontSize:12}}>{i+1}</td>
                        <td style={{color:'var(--text-1)',fontWeight:500}}>
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
                            <div style={{background:'var(--surface-1)',borderRadius:4,height:8,flex:1}}>
                              <div style={{
                                background:COLORS[i%COLORS.length],
                                width:`${activityData.total>0?(l.count/activityData.total*100):0}%`,
                                height:'100%',borderRadius:4,
                              }}/>
                            </div>
                            <span style={{color:'var(--text-4)',fontSize:11,minWidth:28,textAlign:'right'}}>
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
                    <tr style={{borderTop:'2px solid var(--line)'}}>
                      <td colSpan={2} style={{color:'var(--text-2)',fontWeight:700}}>Total</td>
                      <td><span className="badge badge-orange">{activityData.total}</span></td>
                      <td colSpan={2} style={{color:'var(--text-4)',fontSize:12}}>{activityData.leagues.length} leagues</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
