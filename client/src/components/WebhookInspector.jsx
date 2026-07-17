import React, { useEffect, useState } from 'react';
import { api } from '../api.jsx';
import { toast } from 'react-hot-toast';

/**
 * Every request that hit the SportsEngine webhook endpoint — valid key or
 * not — with the raw payload expandable. Platform admins see everything;
 * company admins see their own org's deliveries.
 */
export default function WebhookInspector({ compactTitle }) {
  const [d, setD] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  // Cross-check progress: bar + console report, like the Smart Update panels
  const [audit, setAudit] = useState(null); // {running, done, total, sent, log:[{ts,msg,level}]}
  const [page, setPage] = useState(0);
  const [sentOnly, setSentOnly] = useState(false);
  const [auditDays, setAuditDays] = useState(7);
  const [view, setView] = useState('hooks'); // 'hooks' = webhook deliveries · 'audit' = cross-check findings
  const [rec, setRec] = useState(null);      // Meta-vs-SportsEngine reconciliation
  useEffect(() => { api.getReconcile().then(r => setRec(r.data)).catch(() => {}); }, [audit?.running]);
  const auditLog = (msg, level = 'info') =>
    setAudit(a => ({ ...a, log: [...(a?.log || []), { ts: new Date().toLocaleTimeString('en-US', { hour12: false }), msg, level }].slice(-200) }));

  async function runAudit() {
    setRefreshing(true);
    setAudit({ running: true, done: 0, total: null, sent: 0, log: [] });
    auditLog(`🔍 Cross-check started — scanning the last ${auditDays} days of registrations in the store…`);
    if (auditDays > 7) auditLog('Note: finds older than 7 days are reported only — Meta rejects conversions past its 7-day backfill window', 'skip');
    try {
      let done = 0, sent = 0, guard = 0;
      while (guard++ < 25) {
        const r = (await api.auditWebhooks(auditDays)).data;
        if (done === 0) {
          auditLog(`Found ${r.checked} registrations in the window · ${r.alreadySent} already forwarded · ${r.missing + r.processed - r.processed} to verify`, 'info');
        }
        for (const it of (r.items || [])) {
          auditLog(
            `${it.capiSent ? '✓ SENT' : '↷'} ${it.eventName ? it.eventName.slice(0, 40) : 'result ' + it.id}${it.value ? ' · $' + it.value : ''}${it.contactMasked ? ' · ' + it.contactMasked : ''} — ${it.decision}`,
            it.capiSent ? 'ok' : 'skip'
          );
        }
        done += r.processed; sent += r.sentToMeta;
        setAudit(a => ({ ...a, done, sent, total: done + r.remaining }));
        if (!r.remaining) break;
      }
      auditLog(`════ DONE — ${done} verified · ${sent} sent to Meta ════`, sent ? 'ok' : 'info');
      toast.success(`Cross-check done — ${sent} missed sale${sent === 1 ? '' : 's'} sent to Meta`, { duration: 8000 });
    } catch (e) {
      auditLog(`✗ ${e.response?.data?.error || e.message}`, 'error');
      toast.error(e.response?.data?.error || 'Cross-check failed');
    }
    setAudit(a => ({ ...a, running: false }));
    setPage(0); setView('audit');   // findings live in their own log view
  }

  // ♻ Retry failed — same panel, same console, driven by the retry engine
  async function runRetry() {
    setRefreshing(true);
    setAudit({ running: true, done: 0, total: null, sent: 0, log: [] });
    auditLog('♻ Retrying failed deliveries…');
    try {
      let done = 0, sent = 0, guard = 0;
      while (guard++ < 25) {
        const r = (await api.reprocessWebhooks()).data;
        if (done === 0) auditLog(`${r.totalFailed ?? (r.retried + r.remaining)} failed deliveries queued for retry`, 'info');
        for (const it of (r.items || [])) {
          auditLog(`${it.capiSent ? '✓ SENT' : '↷'} ${it.eventName ? it.eventName.slice(0, 40) : 'result ' + it.id}${it.value ? ' · $' + it.value : ''}${it.contactMasked ? ' · ' + it.contactMasked : ''} — ${it.decision}`,
            it.capiSent ? 'ok' : 'skip');
        }
        done += r.retried; sent += r.sentToMeta;
        setAudit(a => ({ ...a, done, sent, total: done + r.remaining }));
        if (!r.remaining) break;
      }
      auditLog(`════ DONE — ${done} retried · ${sent} sent to Meta ════`, sent ? 'ok' : 'info');
      toast.success(`Retried ${done} — ${sent} sent to Meta`, { duration: 6000 });
    } catch (e) {
      auditLog(`✗ ${e.response?.data?.error || e.message}`, 'error');
      toast.error(e.response?.data?.error || 'Retry failed');
    }
    setAudit(a => ({ ...a, running: false }));
    load();
  }

  async function load(p = page, so = sentOnly, v = view) {
    setRefreshing(true);
    try { setD(v === 'sent' ? (await api.getForwardedPage(p * 50)).data : (await api.getWebhookPage(p * 50, so, v)).data); }
    catch {}
    finally { setRefreshing(false); }
  }
  useEffect(() => { load(); }, [page, sentOnly, view]);

  if (!d) return <div className="no-data" style={{ padding: 14 }}>Loading webhook deliveries…</div>;
  const { stats, deliveries } = d;
  const failedCount = deliveries.filter(r => /enrichment failed|not found in SportsEngine|incomplete registration/.test(r.decision || '')).length;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
          {compactTitle || 'Everything SportsEngine sent to the webhook endpoint — including rejected or key-less requests.'}
        </div>
        <span style={{ display: 'flex', gap: 6 }}>
          {d?.deliveries?.some(r => /enrichment failed|not found in SportsEngine|incomplete registration/.test(r.decision || '')) && (
            <button className="btn-primary" style={{ padding: '4px 12px', fontSize: 12 }} disabled={refreshing}
              title="Re-run enrichment for every failed delivery (freshness judged at original delivery time)"
              onClick={runRetry}>♻ Retry failed{failedCount ? ` (${failedCount})` : ''}</button>
          )}
          <select value={auditDays} onChange={e => setAuditDays(Number(e.target.value))}
            style={{ fontSize: 11, borderRadius: 8, padding: '2px 6px', background: 'var(--bg-hover)', color: 'var(--text-2)', border: '1px solid var(--border)' }}>
            {[7, 14, 30, 60].map(n => <option key={n} value={n}>{n}d</option>)}
          </select>
          <button className="btn-secondary" style={{ width: 'auto', margin: 0, padding: '4px 12px', fontSize: 12 }} disabled={refreshing}
            title="Cross-check registrations in the store against what was forwarded to Meta; sends anything missed (>7d finds are reported only)"
            onClick={runAudit}>{audit?.running ? '⏳ Cross-checking…' : `🔍 Cross-check ${auditDays} days`}</button>
          <button className="btn-secondary" style={{ width: 'auto', margin: 0, padding: '4px 12px', fontSize: 12 }}
            onClick={load} disabled={refreshing}>{refreshing ? '⏳' : '🔄 Refresh'}</button>
        </span>
      </div>
      {/* Cross-check progress bar + console report */}
      {audit && (
        <div style={{ marginBottom: 12 }}>
          <style>{`@keyframes wiSlide { from { background-position: 0 0; } to { background-position: 44px 0; } }`}</style>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <div style={{ flex: 1, background: 'var(--surface-1)', borderRadius: 8, height: 8, overflow: 'hidden' }}>
              {audit.running && !audit.total ? (
                <div style={{ width: '100%', height: '100%', opacity: 0.85,
                  background: 'repeating-linear-gradient(45deg, var(--accent-2) 0 12px, transparent 12px 22px)',
                  backgroundSize: '44px 100%', animation: 'wiSlide 0.9s linear infinite' }} />
              ) : (
                <div style={{ width: `${audit.total ? Math.round((audit.done / audit.total) * 100) : (audit.running ? 0 : 100)}%`,
                  height: '100%', borderRadius: 8, transition: 'width 0.4s ease',
                  background: audit.running ? 'var(--viz-1)' : 'var(--viz-up)' }} />
              )}
            </div>
            <span style={{ fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap',
              color: audit.running ? 'var(--viz-1)' : 'var(--viz-up)' }}>
              {audit.running
                ? (audit.total ? `${audit.done}/${audit.total} verified` : 'Scanning store…')
                : `Done — ${audit.sent} sent to Meta`}
            </span>
          </div>
          <div style={{
            background: '#080a0f', border: '1px solid var(--surface-1)', borderRadius: 8,
            padding: '10px 12px', maxHeight: 220, overflowY: 'auto',
            fontFamily: '"Cascadia Code","Fira Code",Consolas,monospace', fontSize: 11.5, lineHeight: 1.7,
          }}>
            {audit.log.map((l, i) => (
              <div key={i} style={{ display: 'flex', gap: 10 }}>
                <span style={{ color: '#1e3a5f', flexShrink: 0, minWidth: 56 }}>{l.ts}</span>
                <span style={{ color: l.level === 'ok' ? '#22c55e' : l.level === 'error' ? '#ef4444' : l.level === 'skip' ? '#8b93a3' : '#c8ceda', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{l.msg}</span>
              </div>
            ))}
            {audit.running && <div style={{ color: '#60a5fa' }}>▋</div>}
          </div>
        </div>
      )}

      {/* Meta vs SportsEngine reconciliation — equal numbers = healthy */}
      {rec && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, marginBottom: 12 }}>
          {[
            ['Meta sent · total', rec.sent.total, 'var(--accent-light)'],
            ['Meta sent · today', rec.sent.today, 'var(--text-1)'],
            ['Meta sent · 7 days', rec.sent.week, 'var(--text-1)'],
            ['SE regs · today', rec.se.today, 'var(--text-1)'],
            ['SE regs · 7 days', rec.se.week, 'var(--text-1)'],
          ].map(([l, v, c]) => (
            <div key={l} style={{ border: '1px solid var(--border-sub)', borderRadius: 10, padding: '8px 12px', background: 'var(--bg-hover)' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: c, fontVariantNumeric: 'tabular-nums' }}>{v}</div>
              <div style={{ fontSize: 9.5, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-4)' }}>{l}</div>
            </div>
          ))}
          <div style={{
            border: `1px solid ${rec.missing.week > 0 ? 'rgba(239,68,68,0.5)' : 'rgba(34,197,94,0.4)'}`,
            borderRadius: 10, padding: '8px 12px',
            background: rec.missing.week > 0 ? 'rgba(239,68,68,0.07)' : 'rgba(34,197,94,0.07)',
          }}>
            <div style={{ fontSize: 20, fontWeight: 800, fontVariantNumeric: 'tabular-nums',
              color: rec.missing.week > 0 ? '#ef4444' : 'var(--viz-up)' }}>
              {rec.missing.week > 0 ? rec.missing.week : '✓'}
            </div>
            <div style={{ fontSize: 9.5, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-4)' }}>
              {rec.missing.week > 0 ? `missing this week (${rec.missing.today} today) — run cross-check` : 'all registrations sent'}
            </div>
          </div>
        </div>
      )}

      {/* Webhook deliveries vs cross-check findings — separate logs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        {[['hooks', '📨 Webhook deliveries'], ['audit', '🔍 Cross-check findings'], ['sent', '✅ Forwarded to Meta']].map(([v, l]) => (
          <button key={v} onClick={() => { setView(v); setPage(0); }} style={{
            padding: '4px 14px', borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: 'pointer',
            border: view === v ? '1px solid var(--accent-light)' : '1px solid var(--border)',
            background: view === v ? 'rgba(99,102,241,0.14)' : 'var(--bg-hover)',
            color: view === v ? 'var(--accent-light)' : 'var(--text-3)',
          }}>{l}</button>
        ))}
      </div>

      <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 10 }}>
        Received: <b>{stats.total || 0}</b> · forwarded to Meta: <b>{stats.capiSent || 0}</b>
        {stats.rejected > 0 && <> · <span style={{ color: '#f59e0b' }}>bad/missing key: <b>{stats.rejected}</b></span></>}
        {stats.lastAt && <> · last: {stats.lastAt.replace('T', ' ').slice(0, 16)} UTC</>}
      </div>
      {deliveries.length === 0 ? (
        <div className="no-data" style={{ padding: '18px 14px' }}>
          {stats?.total > 0
            ? <>No rows in this view's buffer right now — <b>{stats.total}</b> deliveries have been received all-time
              (older display rows rotate out and audit pollution was cleaned). New deliveries appear here the moment
              they arrive; the ✅ Forwarded tab and the tiles above hold the permanent accounting.</>
            : <>Nothing has reached the endpoint yet. If a registration definitely happened, SportsEngine either
              hasn't got the webhook URL saved, the toggles are off, or it delivers with a delay — this list
              records <b>every</b> request the moment one arrives.</>}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 6, maxHeight: 420, overflowY: 'auto' }}>
          {deliveries.map((r, i) => (
            <details key={i} style={{
              fontSize: 11.5, fontFamily: 'ui-monospace, monospace', borderRadius: 8, padding: '7px 10px',
              border: `1px solid ${r.keyOk === false ? 'rgba(245,158,11,0.45)' : 'var(--border-sub)'}`,
              background: r.keyOk === false ? 'rgba(245,158,11,0.06)' : 'var(--bg-hover)',
            }}>
              <summary style={{ cursor: 'pointer', color: 'var(--text-2)' }}>
                {String(r.at||'').replace('T', ' ').slice(0, 19)} · {r.type}
                {r.keyOk === false && <span style={{ color: '#f59e0b', fontWeight: 700 }}> · ⚠ key rejected</span>}
                {r.eventName && <span style={{ color: 'var(--text-4)' }}> · {String(r.eventName).slice(0, 34)}</span>}
                {r.value ? ` · $${r.value}` : ''}
                {' · '}{r.capiSent
                  ? <span style={{ color: 'var(--viz-up)', fontWeight: 700 }}>→ Meta ✓</span>
                  : <span style={{ color: 'var(--text-4)' }}>{(r.decision || 'not forwarded').slice(0, 46)}</span>}
                <span style={{ color: 'var(--accent-light)' }}> · details ▾</span>
              </summary>
              {/* what this delivery actually was, and what we did with it */}
              <div style={{
                display: 'grid', gridTemplateColumns: 'minmax(110px, max-content) 1fr', gap: '3px 12px',
                margin: '8px 0 6px', padding: '8px 10px', borderRadius: 6, fontFamily: 'inherit',
                background: 'var(--surface-1)', border: '1px solid var(--border-sub)', fontSize: 11,
              }}>
                <span style={{ color: 'var(--text-4)' }}>Verdict</span>
                <span style={{ color: r.capiSent ? 'var(--viz-up)' : 'var(--text-1)', fontWeight: 700 }}>{r.decision || '—'}</span>
                {r.reason && <><span style={{ color: 'var(--text-4)' }}>Why</span><span>{r.reason}</span></>}
                {r.resourceId && <><span style={{ color: 'var(--text-4)' }}>Result ID</span><span>{r.resourceId}</span></>}
                {(r.eventName || r.eventId) && <><span style={{ color: 'var(--text-4)' }}>Event</span><span>{r.eventName || ''}{r.eventId ? ` (${r.eventId})` : ''}</span></>}
                {r.resultCreated && <><span style={{ color: 'var(--text-4)' }}>Registered</span><span>{String(r.resultCreated).replace('T', ' ').slice(0, 16)}</span></>}
                <span style={{ color: 'var(--text-4)' }}>Contact</span>
                <span>{r.contactMasked || (r.hasEmail ? 'email found' : r.hasPhone ? 'phone only' : 'none extracted')}</span>
                {r.value != null && <><span style={{ color: 'var(--text-4)' }}>Value</span><span>${r.value}</span></>}
                <span style={{ color: 'var(--text-4)' }}>Meta CAPI</span>
                <span style={{ color: r.capiSent ? 'var(--viz-up)' : '#f59e0b', fontWeight: 600 }}>
                  {r.capiSent ? 'CompleteRegistration + Purchase sent ✓' : 'not sent'}
                </span>
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--text-4)', margin: '0 0 3px' }}>Raw webhook payload:</div>
              <pre style={{
                margin: '0 0 2px', padding: '8px 10px', borderRadius: 6, background: 'var(--surface-1)',
                border: '1px solid var(--border-sub)', maxHeight: 200, overflow: 'auto',
                whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 10.5, color: 'var(--text-2)',
              }}>{(() => { try { return JSON.stringify(JSON.parse(r.sample), null, 2); } catch { return r.sample || '(empty)'; } })()}</pre>
            </details>
          ))}
        </div>
      )}
      {/* numbered pagination + sent-only filter */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-3)', cursor: 'pointer' }}>
          <input type="checkbox" checked={sentOnly} onChange={e => { setSentOnly(e.target.checked); setPage(0); }} />
          ✓ Sent to Meta only
        </label>
        {d.totalStored > 50 && (
          <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            {Array.from({ length: Math.ceil(d.totalStored / 50) }, (_, i) => (
              <button key={i} onClick={() => setPage(i)} disabled={refreshing} style={{
                minWidth: 28, padding: '3px 8px', borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                border: page === i ? '1px solid var(--accent-light)' : '1px solid var(--border)',
                background: page === i ? 'rgba(99,102,241,0.14)' : 'var(--bg-hover)',
                color: page === i ? 'var(--accent-light)' : 'var(--text-3)',
              }}>{i + 1}</button>
            ))}
            <span style={{ fontSize: 11, color: 'var(--text-4)', marginLeft: 4 }}>{d.totalStored} stored</span>
          </span>
        )}
      </div>
    </div>
  );
}
