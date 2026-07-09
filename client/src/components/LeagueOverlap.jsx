/**
 * LeagueOverlap — shows participant overlap between two leagues.
 *
 * Three groups:
 *   New       — in League B only (first-timers this year)
 *   Returning — in both A and B
 *   Lapsed    — in League A only (didn't sign up this year → send reminder)
 *
 * Matching is done server-side by profileId > email > phone.
 */
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api } from '../api.jsx';
import { toast } from 'react-hot-toast';
import Panel from './Panel.jsx';

const TAB_CONFIG = [
  { id: 'lapsed',    label: 'Didn\'t Return', color: '#ef4444', desc: 'Were in League A — not in League B. Send reminders.' },
  { id: 'new',       label: 'New This Year',  color: '#22c55e', desc: 'First time — only in League B.' },
  { id: 'returning', label: 'Returning',      color: 'var(--accent-light)', desc: 'Participated in both leagues.' },
];

function fmt10(phone) {
  if (!phone || phone.length < 10) return phone || '—';
  const d = phone.slice(-10);
  return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
}

// Flatten all emails/phones from rows — uses the full arrays if available
function allEmailsFrom(rows) {
  const seen = new Set();
  for (const row of rows) {
    const isPair = row.past !== undefined;
    for (const side of isPair ? [row.current, row.past] : [row]) {
      for (const e of (side?.emails?.length ? side.emails : side?.email ? [side.email] : [])) {
        if (e) seen.add(e.toLowerCase().trim());
      }
    }
  }
  return [...seen];
}
function allPhonesFrom(rows) {
  const seen = new Set();
  for (const row of rows) {
    const isPair = row.past !== undefined;
    for (const side of isPair ? [row.current, row.past] : [row]) {
      for (const p of (side?.phones?.length ? side.phones : side?.phone ? [side.phone] : [])) {
        const d = String(p).replace(/\D/g,'');
        if (d.length >= 10) seen.add(d.slice(-10));
      }
    }
  }
  return [...seen];
}

function ContactActions({ rows, label }) {
  const emails = allEmailsFrom(rows);
  const phones = allPhonesFrom(rows);

  function copyList(list, type) {
    if (!list.length) return toast.error(`No ${type}s available`);
    navigator.clipboard.writeText(list.join('\n'));
    toast.success(`${list.length} ${type}${list.length !== 1 ? 's' : ''} copied`);
  }

  function downloadCSV(rows, filename) {
    // One row per registration, all emails joined with semicolons
    const header = 'All Emails,All Phones,Grad Year (A),Grad Year (B),Grade,Gender,City,State';
    const lines = rows.map(r => {
      const isPair = r.past !== undefined;
      const cur  = isPair ? r.current : r;
      const past = isPair ? r.past    : null;
      const em = [...new Set([...(cur.emails||[]), ...(past?.emails||[]), cur.email, past?.email].filter(Boolean))];
      const ph = [...new Set([...(cur.phones||[]), ...(past?.phones||[]), cur.phone, past?.phone].filter(Boolean))];
      return [
        em.join('; '),
        ph.join('; '),
        past?.gradYears?.[0] || '',
        cur.gradYears?.[0]   || '',
        cur.grade || past?.grade || '',
        cur.gender || past?.gender || '',
        cur.city   || past?.city   || '',
        cur.state  || past?.state  || '',
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
    });
    const blob = new Blob([header + '\n' + lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
      <button onClick={() => copyList(emails, 'email')}
        style={{ padding: '5px 12px', borderRadius: 6, fontSize: 11, fontWeight: 700, border: 'none', cursor: 'pointer', background: 'var(--chip-bg)', color: 'var(--accent-light)' }}>
        Copy {emails.length} Email{emails.length !== 1 ? 's' : ''} (all players)
      </button>
      <button onClick={() => copyList(phones, 'phone')}
        style={{ padding: '5px 12px', borderRadius: 6, fontSize: 11, fontWeight: 700, border: 'none', cursor: 'pointer', background: 'var(--chip-bg)', color: 'var(--accent-light)' }}>
        Copy {phones.length} Phone{phones.length !== 1 ? 's' : ''}
      </button>
      <button onClick={() => downloadCSV(rows, `${label.replace(/\s+/g, '-').toLowerCase()}.csv`)}
        style={{ padding: '5px 12px', borderRadius: 6, fontSize: 11, fontWeight: 700, border: 'none', cursor: 'pointer', background: 'var(--surface-3)', color: 'var(--text-2)' }}>
        ⬇ CSV (all emails per row)
      </button>
    </div>
  );
}

function ParticipantTable({ rows, mode, nameA, nameB }) {
  const [search, setSearch] = useState('');

  const filtered = search
    ? rows.filter(row => {
        const cur  = mode === 'returning' ? row.current : row;
        const past = mode === 'returning' ? row.past    : null;
        const hay  = [
          ...(cur.emails  || [cur.email  || '']),
          ...(cur.phones  || [cur.phone  || '']),
          ...(past?.emails || [past?.email || '']),
          cur.city, cur.grade, cur.gender,
        ].filter(Boolean).join(' ').toLowerCase();
        return hay.includes(search.toLowerCase());
      })
    : rows;

  if (!rows.length) {
    return <p style={{ color: 'var(--text-5)', fontSize: 13, margin: 0 }}>No records in this group.</p>;
  }

  return (
    <>
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter by email, phone, city…"
        style={{ width: '100%', maxWidth: 320, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--line)',
          background: 'var(--surface-3)', color: 'var(--text-1)', fontSize: 12, marginBottom: 10, boxSizing: 'border-box' }}/>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--surface-1)' }}>
              <th style={th}>Email</th>
              <th style={th}>Phone</th>
              {mode === 'returning' ? (
                <>
                  <th style={th}>Grad Yr ({nameA})</th>
                  <th style={th}>Grad Yr ({nameB})</th>
                  <th style={th}>Grade ({nameA})</th>
                  <th style={th}>Grade ({nameB})</th>
                </>
              ) : (
                <>
                  <th style={th}>Grad Year</th>
                  <th style={th}>Grade</th>
                </>
              )}
              <th style={th}>Gender</th>
              <th style={th}>City</th>
              <th style={th}>State</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row, i) => {
              const cur  = mode === 'returning' ? row.current : row;
              const past = mode === 'returning' ? row.past    : null;
              const allEmails = [...new Set([...(cur.emails||[]), ...(past?.emails||[]), cur.email, past?.email].filter(Boolean))];
              const allPhones = [...new Set([...(cur.phones||[]), ...(past?.phones||[]), cur.phone, past?.phone].filter(Boolean))];
              return (
                <tr key={i} style={{ borderBottom: '1px solid var(--surface-3)', background: i % 2 === 0 ? 'transparent' : 'var(--surface-3)' }}>
                  <td style={{ ...td, maxWidth: 260 }}>
                    {allEmails.length ? allEmails.map((e,ei) => (
                      <div key={ei}><a href={`mailto:${e}`} style={{ color: 'var(--accent-light)', textDecoration: 'none', fontSize: 11 }}>{e}</a></div>
                    )) : <span style={{ color: 'var(--text-5)' }}>—</span>}
                  </td>
                  <td style={td}>
                    {allPhones.length ? allPhones.map((p,pi) => (
                      <div key={pi}><a href={`tel:${p}`} style={{ color: 'var(--accent-green)', textDecoration: 'none' }}>{fmt10(p)}</a></div>
                    )) : <span style={{ color: 'var(--text-5)' }}>—</span>}
                  </td>
                  {mode === 'returning' ? (
                    <>
                      <td style={{ ...td, color: '#f97316' }}>{past?.gradYears?.[0] || '—'}</td>
                      <td style={{ ...td, color: 'var(--accent-light)' }}>{cur.gradYears?.[0]   || '—'}</td>
                      <td style={{ ...td, color: '#f97316' }}>{past?.grade || '—'}</td>
                      <td style={{ ...td, color: 'var(--accent-light)' }}>{cur.grade   || '—'}</td>
                    </>
                  ) : (
                    <>
                      <td style={td}>{cur.gradYears?.[0] || '—'}</td>
                      <td style={td}>{cur.grade || '—'}</td>
                    </>
                  )}
                  <td style={td}>{cur.gender || past?.gender || '—'}</td>
                  <td style={td}>{cur.city   || past?.city   || '—'}</td>
                  <td style={td}>{cur.state  || past?.state  || '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length < rows.length && (
          <p style={{ color: 'var(--text-4)', fontSize: 11, marginTop: 6 }}>{filtered.length} of {rows.length} shown</p>
        )}
      </div>
    </>
  );
}

const th = { textAlign: 'left', padding: '6px 10px', color: 'var(--text-3)', fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.5px', whiteSpace: 'nowrap' };
const td = { padding: '6px 10px', color: '#cbd5e1', whiteSpace: 'nowrap' };

export default function LeagueOverlap({ eventIdA, eventIdB, nameA, nameB }) {
  const [data,      setData]      = useState(null);
  const [loading,   setLoading]   = useState(false);
  const [tab,       setTab]       = useState('lapsed');
  const [bfLog,     setBfLog]     = useState([]);   // backfill progress log
  const [bfRunning, setBfRunning] = useState(false);
  const bfAbort = useRef(false);

  const load = useCallback(async () => {
    if (!eventIdA || !eventIdB || eventIdA === eventIdB) return;
    setLoading(true); setData(null);
    try {
      const res = await api.reportLeagueOverlap(eventIdA, eventIdB);
      setData(res.data);
    } catch (err) {
      toast.error('Overlap load failed: ' + err.message);
    } finally {
      setLoading(false);
    }
  }, [eventIdA, eventIdB]);

  useEffect(() => { load(); }, [load]);

  // Backfill: re-fetch all pages of both leagues with merge mode to fill in
  // missing email/phone/grade on records that were saved before those fields existed.
  async function runBackfill() {
    bfAbort.current = false;
    setBfRunning(true); setBfLog([]);

    const logLine = (msg, level = 'info') =>
      setBfLog(prev => [...prev, { ts: new Date().toLocaleTimeString('en-US', { hour12: false }), msg, level }]);

    const events = [
      { id: eventIdA, name: nameA || 'League A' },
      { id: eventIdB, name: nameB || 'League B' },
    ];

    for (const ev of events) {
      if (bfAbort.current) break;
      logLine(`Backfilling "${ev.name}"…`);

      let nextPage = undefined, pageNum = 0, prevCompact = [];
      try {
        do {
          if (bfAbort.current) break;
          const res = await api.aggregateFetchEvent({
            orgId: '8008',
            eventId: String(ev.id),
            eventName: ev.name,
            resultsCompleted: 0,  // ignored because backfill bypasses skip check
            backfill: true,
            ...(nextPage != null ? { page: nextPage } : {}),
            ...(prevCompact.length > 0 ? { prevCompact } : {}),
          });

          pageNum++;
          if (res.data.hasMore) {
            prevCompact = res.data.compact || [];
            nextPage    = res.data.nextPage;
            logLine(`  ↓ page ${pageNum} (${prevCompact.length} accumulated)…`);
            await new Promise(r => setTimeout(r, 400));
          } else {
            nextPage = null; prevCompact = [];
            logLine(`  ✓ Done — ${res.data.fetched} records processed, ${res.data.added} new`, 'ok');
          }
        } while (nextPage != null);
      } catch (err) {
        logLine(`  ✗ Failed: ${err.response?.data?.error || err.message}`, 'error');
      }

      if (!bfAbort.current && events.indexOf(ev) < events.length - 1) {
        await new Promise(r => setTimeout(r, 800));
      }
    }

    setBfRunning(false);
    if (!bfAbort.current) {
      logLine('Reloading overlap data…', 'info');
      await load();
      logLine('Done.', 'ok');
    }
  }

  if (!eventIdA || !eventIdB) return null;
  if (eventIdA === eventIdB) return (
    <Panel id="leagueoverlap-panel-1" style={{ marginTop: 16 }}>
      <p style={{ color: 'var(--text-4)', fontSize: 13, margin: 0 }}>Select two different leagues to see participant overlap.</p>
    </Panel>
  );

  const activeTab = TAB_CONFIG.find(t => t.id === tab);
  const tabRows = data
    ? (tab === 'new' ? data.newUsers : tab === 'returning' ? data.returning : data.lapsed)
    : [];
  const hasContact = data?.hasContactData;

  return (
    <Panel id="leagueoverlap-panel-2" style={{ marginTop: 16 }}>
      <div style={{ marginBottom: 14 }}>
        <h2 style={{ margin: '0 0 4px' }}>Participant Overlap</h2>
        <p style={{ color: 'var(--text-4)', fontSize: 12, margin: 0 }}>
          Matched by SportsEngine profile ID, email, or phone. Re-fetch both leagues to maximize match rate.
        </p>
      </div>

      {/* Backfill panel — always visible when data is loaded */}
      {data && (
        <div style={{ background: 'var(--surface-3)', border: '1px solid var(--line)', borderRadius: 10, padding: '12px 14px', marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: bfLog.length > 0 ? 10 : 0 }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-2)', marginBottom: 2 }}>
                {!data.hasContactData ? '⚠ No contact data in stored records' : '↻ Update contact data'}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-4)' }}>
                Re-fetches all pages of both leagues and fills in missing email, phone, and grade on existing records. Safe — no data is deleted.
              </div>
            </div>
            {!bfRunning ? (
              <button onClick={runBackfill}
                style={{ padding: '8px 16px', borderRadius: 6, fontSize: 12, fontWeight: 700, border: 'none', cursor: 'pointer',
                  background: data.hasContactData ? 'var(--surface-1)' : '#1e3a1e', color: data.hasContactData ? 'var(--text-2)' : '#4ade80' }}>
                {data.hasContactData ? '↻ Refresh Contacts' : '⬇ Fetch Contact Data'}
              </button>
            ) : (
              <>
                <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Running…</span>
                <button onClick={() => { bfAbort.current = true; }}
                  style={{ padding: '6px 12px', borderRadius: 6, fontSize: 11, border: 'none', cursor: 'pointer', background: 'rgba(239,68,68,0.12)', color: 'var(--danger-text)', fontWeight: 700 }}>
                  ⏹ Stop
                </button>
              </>
            )}
          </div>
          {bfLog.length > 0 && (
            <div style={{ background: 'var(--surface-3)', borderRadius: 6, padding: '8px 10px', maxHeight: 140, overflowY: 'auto', fontFamily: 'monospace', fontSize: 11 }}>
              {bfLog.map((e, i) => (
                <div key={i} style={{ color: e.level === 'error' ? '#ef4444' : e.level === 'ok' ? '#22c55e' : 'var(--text-3)', lineHeight: 1.5 }}>
                  <span style={{ color: 'var(--text-5)', marginRight: 6 }}>{e.ts}</span>{e.msg}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {loading && <p style={{ color: 'var(--text-3)', fontSize: 13 }}>Loading…</p>}

      {!loading && data && (
        <>

          {/* Stats summary */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
            {[
              { label: 'Total in A', val: data.stats.totalA, color: '#f97316' },
              { label: 'Total in B', val: data.stats.totalB, color: 'var(--accent-light)' },
              { label: 'Matchable A', val: data.stats.matchable.A, color: 'var(--text-2)', sub: 'have ID/email/phone' },
              { label: 'Matchable B', val: data.stats.matchable.B, color: 'var(--text-2)', sub: 'have ID/email/phone' },
              { label: 'Didn\'t Return', val: data.stats.lapsed,    color: '#ef4444' },
              { label: 'New This Year', val: data.stats.new,        color: '#22c55e' },
              { label: 'Returning',     val: data.stats.returning,  color: 'var(--accent-light)' },
            ].map(s => (
              <div key={s.label} style={{ background: 'var(--surface-1)', borderRadius: 8, padding: '8px 14px', minWidth: 90 }}>
                <div style={{ fontSize: 9, color: 'var(--text-4)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{s.label}</div>
                <div style={{ fontSize: 22, fontWeight: 800, color: s.color }}>{s.val}</div>
                {s.sub && <div style={{ fontSize: 9, color: 'var(--text-5)' }}>{s.sub}</div>}
              </div>
            ))}
          </div>

          {/* Tab bar */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
            {TAB_CONFIG.map(t => {
              const count = t.id === 'new' ? data.stats.new : t.id === 'returning' ? data.stats.returning : data.stats.lapsed;
              return (
                <button key={t.id} onClick={() => setTab(t.id)}
                  style={{ padding: '7px 16px', borderRadius: 6, fontSize: 12, fontWeight: 700, border: 'none', cursor: 'pointer',
                    background: tab === t.id ? 'var(--surface-1)' : 'var(--surface-2)', color: tab === t.id ? t.color : 'var(--text-4)',
                    borderBottom: tab === t.id ? `2px solid ${t.color}` : '2px solid transparent' }}>
                  {t.label} <span style={{ fontSize: 11, fontWeight: 400 }}>({count})</span>
                </button>
              );
            })}
          </div>

          {/* Tab description */}
          <p style={{ fontSize: 11, color: 'var(--text-4)', margin: '0 0 10px' }}>{activeTab?.desc}</p>

          {/* Contact actions */}
          {tabRows.length > 0 && (
            <ContactActions rows={tabRows} label={`${activeTab?.label}-${nameA}-vs-${nameB}`} />
          )}

          {/* Table */}
          <ParticipantTable rows={tabRows} mode={tab} nameA={nameA?.slice(0, 20) || 'A'} nameB={nameB?.slice(0, 20) || 'B'} />
        </>
      )}
    </Panel>
  );
}
