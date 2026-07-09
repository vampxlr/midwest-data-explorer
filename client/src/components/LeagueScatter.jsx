/**
 * LeagueScatter — "Where did they go?"
 *
 * Select a source league (e.g. 2025 Maple Grove) and a target year (e.g. 2026).
 * Shows which 2026 leagues those participants signed up for, and who went nowhere.
 */
import React, { useState, useCallback } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts';
import { api } from '../api.jsx';
import { toast } from 'react-hot-toast';
import SearchableSelect from './SearchableSelect.jsx';

function fmt10(phone) {
  if (!phone) return '—';
  const d = String(phone).replace(/\D/g, '').slice(-10);
  if (d.length < 10) return phone;
  return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
}

function ContactBar({ list, label }) {
  const emails = [...new Set(list.flatMap(p => p.emails?.length ? p.emails : p.email ? [p.email] : []))];
  const phones = [...new Set(list.flatMap(p => p.phones?.length ? p.phones : p.phone ? [p.phone] : []))];

  function copy(arr, type) {
    if (!arr.length) { toast.error(`No ${type}s available`); return; }
    navigator.clipboard.writeText(arr.join('\n'));
    toast.success(`${arr.length} ${type}${arr.length !== 1 ? 's' : ''} copied`);
  }

  function downloadCSV(rows, filename) {
    const hdr = 'Emails,Phones,Grad Year (past),Grad Year (now),Grade,Gender,City,State';
    const body = rows.map(r => {
      const allEmails = r.emails?.length ? r.emails : r.email ? [r.email] : [];
      const allPhones = r.phones?.length ? r.phones : r.phone ? [r.phone] : [];
      return [
        allEmails.join('; '),
        allPhones.join('; '),
        r.gradYearPast || r.gradYear || '',
        r.gradYearNow  || '',
        r.grade  || '',
        r.gender || '',
        r.city   || '',
        r.state  || '',
      ].map(v => `"${String(v).replace(/"/g,'""')}"`).join(',');
    }).join('\n');
    const blob = new Blob([hdr + '\n' + body], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a'); a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:8 }}>
      <button onClick={() => copy(emails,'email')}
        style={{ padding:'4px 10px', borderRadius:6, fontSize:11, fontWeight:700, border:'none', cursor:'pointer', background:'var(--chip-bg)', color:'var(--accent-light)' }}>
        Copy {emails.length} Email{emails.length!==1?'s':''}
      </button>
      <button onClick={() => copy(phones,'phone')}
        style={{ padding:'4px 10px', borderRadius:6, fontSize:11, fontWeight:700, border:'none', cursor:'pointer', background:'var(--chip-bg)', color:'var(--accent-light)' }}>
        Copy {phones.length} Phone{phones.length!==1?'s':''}
      </button>
      <button onClick={() => downloadCSV(list, `${label}.csv`)}
        style={{ padding:'4px 10px', borderRadius:6, fontSize:11, fontWeight:700, border:'none', cursor:'pointer', background:'var(--surface-3)', color:'var(--text-2)' }}>
        ⬇ CSV
      </button>
    </div>
  );
}

function ParticipantMini({ rows, mode = 'dest' }) {
  const [show, setShow] = useState(false);
  if (!rows.length) return <p style={{ color:'var(--text-5)', fontSize:12, margin:0 }}>No records.</p>;
  return (
    <>
      <button onClick={() => setShow(s => !s)}
        style={{ fontSize:11, color:'var(--text-4)', background:'none', border:'none', cursor:'pointer', padding:0, marginBottom:6 }}>
        {show ? '▲ Hide' : `▼ Show ${rows.length} participant${rows.length!==1?'s':''}`}
      </button>
      {show && (
        <div style={{ overflowX:'auto', marginTop:4 }}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
            <thead>
              <tr style={{ borderBottom:'1px solid var(--surface-1)' }}>
                <th style={TH}>Email</th>
                <th style={TH}>Phone</th>
                {mode === 'dest' ? (
                  <><th style={TH}>Grad Yr (past)</th><th style={TH}>Grad Yr (now)</th></>
                ) : (
                  <th style={TH}>Grad Year</th>
                )}
                <th style={TH}>Grade</th>
                <th style={TH}>Gender</th>
                <th style={TH}>City</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} style={{ borderBottom:'1px solid var(--surface-3)', background: i%2===0?'transparent':'var(--surface-3)' }}>
                  <td style={{ ...TD, maxWidth: 220 }}>
                    {(r.emails?.length ? r.emails : r.email ? [r.email] : []).map((e,ei) => (
                      <div key={ei}><a href={`mailto:${e}`} style={{ color:'var(--accent-light)', textDecoration:'none', fontSize:10 }}>{e}</a></div>
                    ))||<span style={{ color:'var(--text-5)' }}>—</span>}
                  </td>
                  <td style={TD}>
                    {(r.phones?.length ? r.phones : r.phone ? [r.phone] : []).map((p,pi) => (
                      <div key={pi}><a href={`tel:${p}`} style={{ color:'var(--accent-green)', textDecoration:'none' }}>{fmt10(p)}</a></div>
                    ))||<span style={{ color:'var(--text-5)' }}>—</span>}
                  </td>
                  {mode === 'dest' ? (
                    <><td style={TD}>{r.gradYearPast||'—'}</td><td style={TD}>{r.gradYearNow||'—'}</td></>
                  ) : (
                    <td style={TD}>{r.gradYear||'—'}</td>
                  )}
                  <td style={TD}>{r.grade||'—'}</td>
                  <td style={TD}>{r.gender||'—'}</td>
                  <td style={TD}>{r.city||'—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

const TH = { textAlign:'left', padding:'5px 8px', color:'var(--text-3)', fontWeight:600, fontSize:10, textTransform:'uppercase', letterSpacing:'0.5px', whiteSpace:'nowrap' };
const TD = { padding:'5px 8px', color:'#cbd5e1', whiteSpace:'nowrap' };

// Action bar + expandable table for the individuals panel
// participants = [{ email, phones: string[] }, ...]
function IndParticipantSection({ participants, label }) {
  const [show, setShow] = useState(false);
  const emails = participants.map(p => p.email).filter(Boolean);
  const phones = [...new Set(participants.flatMap(p => p.phones || []))];

  function copyEmails() {
    if (!emails.length) { toast.error('No emails'); return; }
    navigator.clipboard.writeText(emails.join('\n'));
    toast.success(`${emails.length} email${emails.length!==1?'s':''} copied`);
  }
  function copyPhones() {
    if (!phones.length) { toast.error('No phones'); return; }
    navigator.clipboard.writeText(phones.join('\n'));
    toast.success(`${phones.length} phone${phones.length!==1?'s':''} copied`);
  }
  function csv() {
    const hdr = 'Email,Phones';
    const body = participants.map(p =>
      [`"${p.email||''}"`, `"${(p.phones||[]).join('; ')}"`].join(',')
    ).join('\n');
    const blob = new Blob([hdr + '\n' + body], { type:'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href=url; a.download=`${label}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:8 }}>
        <button onClick={copyEmails}
          style={{ padding:'4px 10px', borderRadius:6, fontSize:11, fontWeight:700, border:'none', cursor:'pointer', background:'var(--chip-bg)', color:'var(--accent-light)' }}>
          Copy {emails.length} Email{emails.length!==1?'s':''}
        </button>
        <button onClick={copyPhones}
          style={{ padding:'4px 10px', borderRadius:6, fontSize:11, fontWeight:700, border:'none', cursor:'pointer', background:'var(--chip-bg)', color:'var(--accent-green)' }}>
          Copy {phones.length} Phone{phones.length!==1?'s':''}
        </button>
        <button onClick={csv}
          style={{ padding:'4px 10px', borderRadius:6, fontSize:11, fontWeight:700, border:'none', cursor:'pointer', background:'var(--surface-3)', color:'var(--text-2)' }}>
          ⬇ CSV
        </button>
        <button onClick={() => setShow(s => !s)}
          style={{ padding:'4px 10px', borderRadius:6, fontSize:11, fontWeight:700, border:'none', cursor:'pointer', background:'var(--surface-1)', color:'var(--text-3)' }}>
          {show ? '▲ Hide' : `▼ Show ${participants.length} participant${participants.length!==1?'s':''}`}
        </button>
      </div>
      {show && (
        <div style={{ overflowX:'auto', maxHeight:320, overflowY:'auto', marginTop:4 }}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:11 }}>
            <thead>
              <tr style={{ borderBottom:'1px solid var(--surface-1)' }}>
                <th style={TH}>Name</th>
                <th style={TH}>Email</th>
                <th style={TH}>Phone</th>
              </tr>
            </thead>
            <tbody>
              {participants.map((p, i) => (
                <tr key={i} style={{ borderBottom:'1px solid var(--surface-3)', background: i%2===0?'transparent':'var(--surface-3)' }}>
                  <td style={{ ...TD, color:'var(--text-1)' }}>{p.name || <span style={{ color:'var(--text-5)' }}>—</span>}</td>
                  <td style={{ ...TD, maxWidth:260 }}>
                    <a href={`mailto:${p.email}`} style={{ color:'var(--accent-light)', textDecoration:'none' }}>{p.email}</a>
                  </td>
                  <td style={TD}>
                    {(p.phones||[]).length > 0
                      ? (p.phones||[]).map((ph,pi) => (
                          <div key={pi}><a href={`tel:${ph}`} style={{ color:'var(--accent-green)', textDecoration:'none' }}>{fmt10(ph)}</a></div>
                        ))
                      : <span style={{ color:'var(--text-5)' }}>—</span>
                    }
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

const BAR_COLORS = ['#3b82f6','#f97316','#22c55e','#a855f7','#ec4899','#14b8a6','#eab308','#06b6d4','#f43f5e','#84cc16'];

const CustomTip = ({ active, payload }) => {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div style={{ background:'var(--surface-3)', border:'1px solid var(--line)', borderRadius:8, padding:'10px 14px' }}>
      <p style={{ color:'var(--text-2)', fontSize:11, marginBottom:4, maxWidth:220 }}>{d.eventName}</p>
      <p style={{ color:'var(--accent-light)', fontSize:16, fontWeight:800, margin:0 }}>{d.count} participant{d.count!==1?'s':''}</p>
    </div>
  );
};

export default function LeagueScatter({ events = [] }) {
  const [sourceId,    setSourceId]   = useState('');
  const [yearFilter,  setYearFilter] = useState(new Date().getFullYear().toString());
  const [data,        setData]       = useState(null);
  const [indData,     setIndData]    = useState(null);
  const [loading,     setLoading]    = useState(false);
  const [expanded,    setExpanded]   = useState(null);
  const [indExpanded, setIndExpanded]= useState(null);

  const years = [...new Set(
    events.map(e => (e.close || e.open || '').slice(0,4)).filter(y => /^20\d{2}$/.test(y))
  )].sort().reverse();

  const run = useCallback(async () => {
    if (!sourceId) { toast.error('Select a source league first'); return; }
    setLoading(true); setData(null); setIndData(null); setExpanded(null); setIndExpanded(null);
    try {
      const [res, indRes] = await Promise.all([
        api.reportLeagueScatter(sourceId, yearFilter || undefined),
        api.reportLeagueScatterIndiv(sourceId, yearFilter || undefined),
      ]);
      setData(res.data);
      setIndData(indRes.data);
      if (!res.data.source.matchable) {
        toast('No matchable participants — run "Fetch Contact Data" on the overlap panel first', { icon: '⚠' });
      }
    } catch (err) {
      toast.error('Failed: ' + err.message);
    } finally {
      setLoading(false);
    }
  }, [sourceId, yearFilter]);

  const chartData = data?.buckets?.slice(0, 20).map(b => ({
    eventName: b.eventName.length > 28 ? b.eventName.slice(0,26)+'…' : b.eventName,
    fullName:  b.eventName,
    count:     b.count,
    eventId:   b.eventId,
    participants: b.participants,
  })) || [];

  // foundUnique = distinct people who signed up in at least one destination league
  // totalCross  = total registrations across destinations (one person in 3 leagues = 3)
  const foundUnique = data?.stats?.foundUnique ?? (data ? data.buckets.reduce((s, b) => s + b.count, 0) : 0);
  const totalCross  = data?.stats?.totalCrossRegistrations ?? foundUnique;
  const foundPct    = data?.source.matchable ? Math.round(foundUnique / data.source.matchable * 100) : 0;
  const nowherePct  = data?.source.matchable ? Math.round((data.stats?.nowhere ?? data.nowhere.count) / data.source.matchable * 100) : 0;

  return (
    <div className="card" style={{ marginTop:16 }}>
      <div style={{ marginBottom:14 }}>
        <h2 style={{ margin:'0 0 4px' }}>Where Did They Go?</h2>
        <p style={{ color:'var(--text-4)', fontSize:12, margin:0 }}>
          Pick a past league and a target year — see which leagues those participants signed up for, and who didn't sign up anywhere.
        </p>
      </div>

      {/* Controls */}
      <div style={{ display:'flex', gap:12, flexWrap:'wrap', alignItems:'flex-end', marginBottom:14 }}>
        <div style={{ flex:2, minWidth:220 }}>
          <label style={{ fontSize:11, color:'var(--text-3)', display:'block', marginBottom:4 }}>Source League (past)</label>
          <SearchableSelect
            value={sourceId} onChange={setSourceId}
            options={[{ value:'', label:'Select source league…' }, ...events.map(e => ({ value:String(e.id), label:e.name }))]}
            placeholder="Search leagues…"
          />
        </div>
        <div>
          <label style={{ fontSize:11, color:'var(--text-3)', display:'block', marginBottom:4 }}>Compare against year</label>
          <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
            {[...years, ''].map(y => (
              <button key={y||'all'} onClick={() => setYearFilter(y)}
                style={{ padding:'6px 12px', borderRadius:20, fontSize:11, fontWeight:700, border:'none', cursor:'pointer',
                  background: yearFilter===y ? '#2563eb':'var(--surface-1)', color: yearFilter===y ? '#fff':'var(--text-3)' }}>
                {y || 'All years'}
              </button>
            ))}
          </div>
        </div>
        <button onClick={run} disabled={!sourceId || loading}
          style={{ padding:'8px 18px', borderRadius:6, fontSize:12, fontWeight:700, border:'none',
            cursor: sourceId && !loading ? 'pointer':'not-allowed',
            background: sourceId ? '#2563eb':'var(--surface-1)', color: sourceId ? '#fff':'var(--text-3)',
            opacity: loading ? 0.6 : 1, whiteSpace:'nowrap' }}>
          {loading ? 'Analyzing…' : '▶ Analyze'}
        </button>
      </div>

      {/* Results */}
      {data && (
        <>
          {/* Summary bar */}
          <div style={{ display:'flex', gap:10, flexWrap:'wrap', marginBottom:16 }}>
            {[
              { label:'Total in source',              val: data.source.total,     color:'var(--text-2)' },
              { label:'Matchable (have ID)',           val: data.source.matchable, color:'var(--text-3)', sub:'email / phone / profile' },
              { label:`Unique people found ${yearFilter||'elsewhere'}`, val: foundUnique, color:'#22c55e', sub: `${foundPct}% of matchable` },
              { label:'Total cross-registrations',    val: totalCross,            color:'var(--accent-light)', sub:'1 person × 3 leagues = 3' },
              { label:'Leagues they joined',          val: data.buckets.length,   color:'#a855f7' },
              { label:`Didn't sign up anywhere`,      val: data.nowhere.count,    color:'#ef4444', sub: `${nowherePct}% of matchable` },
            ].map(s => (
              <div key={s.label} style={{ background:'var(--surface-1)', borderRadius:8, padding:'8px 14px', minWidth:100 }}>
                <div style={{ fontSize:9, color:'var(--text-4)', textTransform:'uppercase', letterSpacing:'0.5px' }}>{s.label}</div>
                <div style={{ fontSize:22, fontWeight:800, color:s.color }}>{s.val}</div>
                {s.sub && <div style={{ fontSize:9, color:'var(--text-5)' }}>{s.sub}</div>}
              </div>
            ))}
          </div>

          {/* Chart */}
          {chartData.length > 0 && (
            <div style={{ marginBottom:20 }}>
              <h3 style={{ color:'var(--text-2)', fontSize:13, margin:'0 0 10px' }}>
                Where they signed up {yearFilter ? `in ${yearFilter}` : ''}
                {data.buckets.length > 20 && <span style={{ color:'var(--text-4)', fontWeight:400 }}> (top 20 of {data.buckets.length})</span>}
              </h3>
              <ResponsiveContainer width="100%" height={Math.max(180, chartData.length * 36)}>
                <BarChart data={chartData} layout="vertical" margin={{ top:0, right:20, left:8, bottom:0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--surface-1)" horizontal={false}/>
                  <XAxis type="number" stroke="var(--text-5)" tick={{ fill:'var(--text-3)', fontSize:11 }}/>
                  <YAxis type="category" dataKey="eventName" width={200}
                    tick={{ fill:'var(--text-2)', fontSize:11 }} stroke="var(--text-5)"/>
                  <Tooltip content={<CustomTip/>}/>
                  <Bar dataKey="count" radius={[0,4,4,0]} onClick={d => setExpanded(ex => ex===d.eventId ? null : d.eventId)}>
                    {chartData.map((_, i) => <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} cursor="pointer"/>)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <p style={{ color:'var(--text-5)', fontSize:11, marginTop:4 }}>Click a bar to expand participant details.</p>
            </div>
          )}

          {/* Bucket detail rows */}
          {data.buckets.length > 0 && (
            <div style={{ marginBottom:20 }}>
              {data.buckets.map((b, i) => (
                <div key={b.eventId} style={{
                  border:'1px solid var(--surface-1)', borderRadius:8, marginBottom:6,
                  borderLeft: `3px solid ${BAR_COLORS[i % BAR_COLORS.length]}`,
                }}>
                  <div
                    onClick={() => setExpanded(ex => ex===b.eventId ? null : b.eventId)}
                    style={{ display:'flex', justifyContent:'space-between', alignItems:'center',
                      padding:'10px 14px', cursor:'pointer', userSelect:'none' }}>
                    <div>
                      <span style={{ color:'var(--text-1)', fontSize:13, fontWeight:600 }}>{b.eventName}</span>
                    </div>
                    <div style={{ display:'flex', gap:12, alignItems:'center' }}>
                      <span style={{ color: BAR_COLORS[i % BAR_COLORS.length], fontSize:20, fontWeight:800 }}>{b.count}</span>
                      <span style={{ color:'var(--text-5)', fontSize:13 }}>{expanded===b.eventId ? '▲':'▼'}</span>
                    </div>
                  </div>
                  {expanded === b.eventId && (
                    <div style={{ padding:'0 14px 12px' }}>
                      <ContactBar list={b.participants} label={`${data.source.name.slice(0,20)}-to-${b.eventName.slice(0,20)}`}/>
                      <ParticipantMini rows={b.participants} mode="dest"/>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Didn't sign up anywhere */}
          <div style={{ border:'1px solid rgba(239,68,68,0.3)', borderRadius:10, background:'rgba(239,68,68,0.1)', padding:'14px 16px' }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10, flexWrap:'wrap', gap:8 }}>
              <div>
                <h3 style={{ color:'#ef4444', margin:'0 0 2px' }}>
                  Didn't Sign Up Anywhere — {data.nowhere.count}
                </h3>
                <p style={{ color:'var(--text-4)', fontSize:11, margin:0 }}>
                  {data.source.name} participants with no matching registration in {yearFilter || 'any other league'}.
                  {' '}These are your best outreach targets.
                </p>
              </div>
            </div>
            {data.nowhere.participants.length > 0 && (
              <>
                <ContactBar list={data.nowhere.participants} label={`lapsed-${data.source.name.slice(0,20)}`}/>
                <ParticipantMini rows={data.nowhere.participants} mode="nowhere"/>
              </>
            )}
            {data.nowhere.count === 0 && (
              <p style={{ color:'#22c55e', fontSize:13, margin:0 }}>Everyone found a league this year!</p>
            )}
          </div>
        </>
      )}

      {/* ── Individual Participants Panel ─────────────────────────────────── */}
      {indData && (
        <div style={{ marginTop:24 }}>
          <div style={{ marginBottom:12 }}>
            <h2 style={{ margin:'0 0 4px', fontSize:18 }}>Individual Participants Tracker</h2>
            <p style={{ color:'var(--text-4)', fontSize:12, margin:0 }}>
              Each unique <strong style={{color:'var(--text-2)'}}>email address</strong> from {indData.source.name} = one individual player.
              Phones are used only for matching, not counted separately. Tracks where each person appeared in {yearFilter || 'any year'} — even as a non-primary team member.
            </p>
          </div>

          {/* Summary */}
          <div style={{ display:'flex', gap:10, flexWrap:'wrap', marginBottom:16 }}>
            {[
              { label:'Total registrations (teams)',    val: indData.source.totalRegistrations, color:'var(--text-2)' },
              { label:'Unique individual emails',       val: indData.source.totalIndividuals,   color:'var(--accent-light)', sub:'one row per email address' },
              { label:`Found in ${yearFilter||'any year'}`, val: indData.stats.found,           color:'#22c55e', sub: `${indData.source.totalIndividuals ? Math.round(indData.stats.found/indData.source.totalIndividuals*100) : 0}% of individuals` },
              { label:'Leagues they joined',            val: indData.buckets.length,            color:'#a855f7' },
              { label:`Didn't sign up anywhere`,        val: indData.stats.nowhere,             color:'#ef4444', sub: `${indData.source.totalIndividuals ? Math.round(indData.stats.nowhere/indData.source.totalIndividuals*100) : 0}% of individuals` },
            ].map(s => (
              <div key={s.label} style={{ background:'var(--surface-1)', borderRadius:8, padding:'8px 14px', minWidth:100 }}>
                <div style={{ fontSize:9, color:'var(--text-4)', textTransform:'uppercase', letterSpacing:'0.5px' }}>{s.label}</div>
                <div style={{ fontSize:22, fontWeight:800, color:s.color }}>{s.val}</div>
                {s.sub && <div style={{ fontSize:9, color:'var(--text-5)' }}>{s.sub}</div>}
              </div>
            ))}
          </div>

          {/* Bar chart */}
          {indData.buckets.length > 0 && (
            <div style={{ marginBottom:16 }}>
              <h3 style={{ color:'var(--text-2)', fontSize:13, margin:'0 0 10px' }}>
                Where individual players went {yearFilter ? `in ${yearFilter}` : ''}
              </h3>
              <ResponsiveContainer width="100%" height={Math.max(160, Math.min(indData.buckets.length, 20) * 36)}>
                <BarChart data={indData.buckets.slice(0,20).map(b => ({ ...b, shortName: b.eventName.length>28 ? b.eventName.slice(0,26)+'…' : b.eventName }))} layout="vertical" margin={{ top:0, right:20, left:8, bottom:0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--surface-1)" horizontal={false}/>
                  <XAxis type="number" stroke="var(--text-5)" tick={{ fill:'var(--text-3)', fontSize:11 }}/>
                  <YAxis type="category" dataKey="shortName" width={200} tick={{ fill:'var(--text-2)', fontSize:11 }} stroke="var(--text-5)"/>
                  <Tooltip content={<CustomTip/>}/>
                  <Bar dataKey="count" radius={[0,4,4,0]} onClick={d => setIndExpanded(ex => ex===d.eventId ? null : d.eventId)}>
                    {indData.buckets.slice(0,20).map((_, i) => <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} cursor="pointer"/>)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <p style={{ color:'var(--text-5)', fontSize:11, marginTop:4 }}>Click a bar to see the email list for that league.</p>
            </div>
          )}

          {/* Bucket detail rows */}
          {indData.buckets.map((b, i) => (
            <div key={b.eventId} style={{
              border:'1px solid var(--surface-1)', borderRadius:8, marginBottom:6,
              borderLeft:`3px solid ${BAR_COLORS[i % BAR_COLORS.length]}`,
            }}>
              <div onClick={() => setIndExpanded(ex => ex===b.eventId ? null : b.eventId)}
                style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'10px 14px', cursor:'pointer', userSelect:'none' }}>
                <span style={{ color:'var(--text-1)', fontSize:13, fontWeight:600 }}>{b.eventName}</span>
                <div style={{ display:'flex', gap:12, alignItems:'center' }}>
                  <span style={{ color:BAR_COLORS[i % BAR_COLORS.length], fontSize:20, fontWeight:800 }}>{b.count}</span>
                  <span style={{ color:'var(--text-5)', fontSize:13 }}>{indExpanded===b.eventId ? '▲':'▼'}</span>
                </div>
              </div>
              {indExpanded === b.eventId && (
                <div style={{ padding:'0 14px 12px' }}>
                  {b.participants?.length > 0
                    ? <IndParticipantSection participants={b.participants} label={`${indData.source.name.slice(0,20)}-indiv-to-${b.eventName.slice(0,20)}`}/>
                    : <p style={{ color:'var(--text-5)', fontSize:11 }}>No contact data — run backfill to populate emails/phones.</p>
                  }
                </div>
              )}
            </div>
          ))}

          {/* Nowhere */}
          <div style={{ border:'1px solid rgba(239,68,68,0.3)', borderRadius:10, background:'rgba(239,68,68,0.1)', padding:'14px 16px', marginTop:8 }}>
            <h3 style={{ color:'#ef4444', margin:'0 0 6px' }}>
              Individuals Who Didn't Sign Up Anywhere — {indData.nowhere.count}
            </h3>
            <p style={{ color:'var(--text-4)', fontSize:11, margin:'0 0 10px' }}>
              Individual players from {indData.source.name} with no email match in {yearFilter || 'any'} leagues.
            </p>
            {indData.nowhere.list.length > 0
              ? <IndParticipantSection participants={indData.nowhere.list} label={`lapsed-individuals-${indData.source.name.slice(0,20)}`}/>
              : indData.nowhere.count === 0 && <p style={{ color:'#22c55e', fontSize:13, margin:0 }}>All individuals found a league!</p>
            }
          </div>
        </div>
      )}
    </div>
  );
}
