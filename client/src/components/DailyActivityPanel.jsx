import React, { useEffect, useState } from 'react';
import {
  BarChart, Bar, XAxis, Tooltip, ResponsiveContainer, Cell, ReferenceLine,
} from 'recharts';
import { api } from '../api.jsx';
import { toast } from 'react-hot-toast';
import { DeadlineToggle, useDeadlinesOn, useDeadlineMap } from '../deadlines.jsx';
import Panel from './Panel.jsx';

const ChartTip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background:'var(--bg-card)', border:'1px solid var(--line)', borderRadius:10, padding:'10px 14px', boxShadow:'var(--shadow-md)' }}>
      <p style={{ color:'var(--text-2)', fontSize:12, margin:'0 0 4px' }}>{label}</p>
      {payload.map((p,i) => (
        <p key={i} style={{ color:'var(--text-1)', fontSize:13, fontWeight:700, margin:'2px 0', fontVariantNumeric:'tabular-nums' }}>
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
      color: up ? 'var(--viz-up)' : 'var(--viz-down)',
      borderRadius:20, padding:'2px 8px', fontSize:11, fontWeight:700,
      fontVariantNumeric:'tabular-nums',
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
  const [hoverBar, setHoverBar] = useState(-1);
  const showDeadlines = useDeadlinesOn();
  const deadlineMap = useDeadlineMap();

  // Deadlines that land inside the displayed week → { 'YYYY-MM-DD': 'EB'|'Final' }
  function weekDeadlines(weekDays) {
    const days = new Set((weekDays || []).map(d => d.date));
    const out = {};
    for (const d of Object.values(deadlineMap)) {
      if (d.earlyBird && days.has(d.earlyBird))         out[d.earlyBird] = 'EB';
      if (d.finalDeadline && days.has(d.finalDeadline)) out[d.finalDeadline] = 'Final';
    }
    return out;
  }

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
          <button onClick={()=>navDay(-1)} className="btn-secondary" style={{margin:0,padding:'8px 14px',fontSize:18,width:'auto',flexShrink:0}}>←</button>
          <div style={{ flex:1, textAlign:'center' }}>
            <div style={{ fontSize:18, fontWeight:700, color:'var(--text-1)' }}>
              {fmtFull(activityDate)}
            </div>
            {activityDate===todayCDT() && <span className="badge badge-green" style={{fontSize:11}}>Today</span>}
          </div>
          <button onClick={()=>navDay(1)} disabled={activityDate>=todayCDT()} className="btn-secondary"
            style={{margin:0,padding:'8px 14px',fontSize:18,width:'auto',flexShrink:0,opacity:activityDate>=todayCDT()?0.3:1}}>→</button>
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
              <div className="stat-value" style={{ color:'var(--viz-1)' }}>{activityData.total}</div>
              <div className="stat-sub">{activityData.leagues.length} leagues active</div>
            </div>
            <div className="stat-card">
              <div className="stat-label">Week Total (Mon–Sun)</div>
              <div className="stat-value" style={{ color:'var(--viz-up)' }}>{activityData.weekTotal}</div>
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
              <div className="stat-value" style={{ fontSize:28, color: activityData.weekTotal>=activityData.prevWeekTotal?'var(--viz-up)':'var(--viz-down)' }}>
                {activityData.prevWeekTotal > 0
                  ? `${activityData.weekTotal>=activityData.prevWeekTotal?'+':''}${Math.round((activityData.weekTotal-activityData.prevWeekTotal)/activityData.prevWeekTotal*100)}%`
                  : '—'}
              </div>
              <div className="stat-sub">vs prior week</div>
            </div>
          </div>

          {/* Week sparkline — glow border follows the cursor; bars glow on hover
              and clicking a bar jumps to that day */}
          {activityData.weekDays?.length > 0 && (
            <Panel id="dashboard-week-sparkline" style={{ marginBottom:16 }} onMouseLeave={()=>setHoverBar(-1)}
              title="This Week — Day by Day" subtitle="Click a bar to jump to that day" right={<DeadlineToggle />}>
              <ResponsiveContainer width="100%" height={130}>
                <BarChart data={activityData.weekDays.map(d=>({...d,label:fmt(d.date)}))} margin={{top:8,right:8,left:0,bottom:4}} barCategoryGap="18%">
                  <XAxis dataKey="label" stroke="var(--viz-grid)" tickLine={false} tick={{fill:'var(--viz-axis)',fontSize:11}}/>
                  <Tooltip content={<ChartTip/>} cursor={{ fill:'var(--bg-hover)' }}/>
                  {showDeadlines && Object.entries(weekDeadlines(activityData.weekDays)).map(([date, kind]) => (
                    <ReferenceLine key={date} x={fmt(date)}
                      stroke={kind === 'EB' ? 'var(--viz-2)' : 'var(--viz-6)'} strokeDasharray="4 3"
                      label={{ value:'⏰ '+kind, position:'insideTop', fill: kind === 'EB' ? 'var(--viz-2)' : 'var(--viz-6)', fontSize:9 }} />
                  ))}
                  <Bar dataKey="total" name="Registrations" radius={[4,4,0,0]}
                    onMouseEnter={(_, i)=>setHoverBar(i)}
                    onMouseLeave={()=>setHoverBar(-1)}
                    onClick={(d)=>{ const date = d?.payload?.date; if (date && date <= todayCDT()) { setActivityDate(date); loadActivity(date); } }}>
                    {activityData.weekDays.map((d,i)=>{
                      const isSelected = d.date===activityDate;
                      const isHovered  = i===hoverBar;
                      return (
                        <Cell key={i}
                          fill={isSelected ? 'var(--viz-1)' : isHovered ? 'var(--viz-1)' : 'var(--viz-dim)'}
                          fillOpacity={isSelected ? 1 : isHovered ? 0.75 : 1}
                          style={{
                            cursor: d.date <= todayCDT() ? 'pointer' : 'default',
                            filter: (isSelected || isHovered)
                              ? 'drop-shadow(0 0 7px rgba(59,130,246,0.75)) drop-shadow(0 0 18px rgba(59,130,246,0.3))'
                              : 'none',
                            transition: 'filter 0.2s ease, fill-opacity 0.2s ease',
                          }}
                        />
                      );
                    })}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </Panel>
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
            <Panel id="dashboard-league-breakdown" title={`League Breakdown — ${fmt(activityDate)}`}>
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
                            background:'var(--chip-bg-soft)',
                            color:'var(--viz-1)',
                            borderRadius:20, padding:'3px 12px',
                            fontSize:14, fontWeight:700, fontVariantNumeric:'tabular-nums',
                          }}>{l.count}</span>
                        </td>
                        <td style={{width:160}}>
                          <div style={{display:'flex',alignItems:'center',gap:8}}>
                            <div style={{background:'var(--surface-1)',borderRadius:4,height:8,flex:1}}>
                              <div style={{
                                background:'var(--viz-1)',
                                width:`${activityData.total>0?(l.count/activityData.total*100):0}%`,
                                height:'100%',borderRadius:4,
                              }}/>
                            </div>
                            <span style={{color:'var(--text-4)',fontSize:11,minWidth:28,textAlign:'right',fontVariantNumeric:'tabular-nums'}}>
                              {activityData.total>0?Math.round(l.count/activityData.total*100):0}%
                            </span>
                          </div>
                        </td>
                        <td style={{color:'var(--accent-2)',fontWeight:700}}>
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
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
