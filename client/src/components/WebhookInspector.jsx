import React, { useEffect, useState } from 'react';
import { api } from '../api.jsx';

/**
 * Every request that hit the SportsEngine webhook endpoint — valid key or
 * not — with the raw payload expandable. Platform admins see everything;
 * company admins see their own org's deliveries.
 */
export default function WebhookInspector({ compactTitle }) {
  const [d, setD] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    setRefreshing(true);
    try { setD((await api.getWebhookDeliveries()).data); }
    catch {}
    finally { setRefreshing(false); }
  }
  useEffect(() => { load(); }, []);

  if (!d) return <div className="no-data" style={{ padding: 14 }}>Loading webhook deliveries…</div>;
  const { stats, deliveries } = d;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
          {compactTitle || 'Everything SportsEngine sent to the webhook endpoint — including rejected or key-less requests.'}
        </div>
        <button className="btn-secondary" style={{ width: 'auto', margin: 0, padding: '4px 12px', fontSize: 12 }}
          onClick={load} disabled={refreshing}>{refreshing ? '⏳' : '🔄 Refresh'}</button>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 10 }}>
        Received: <b>{stats.total || 0}</b> · forwarded to Meta: <b>{stats.capiSent || 0}</b>
        {stats.rejected > 0 && <> · <span style={{ color: '#f59e0b' }}>bad/missing key: <b>{stats.rejected}</b></span></>}
        {stats.lastAt && <> · last: {stats.lastAt.replace('T', ' ').slice(0, 16)} UTC</>}
      </div>
      {deliveries.length === 0 ? (
        <div className="no-data" style={{ padding: '18px 14px' }}>
          Nothing has reached the endpoint yet. If a registration definitely happened, SportsEngine either
          hasn't got the webhook URL saved, the toggles are off, or it delivers with a delay — this list
          records <b>every</b> request the moment one arrives.
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
                {r.at.replace('T', ' ').slice(0, 19)} · {r.type}
                {r.keyOk === false && <span style={{ color: '#f59e0b', fontWeight: 700 }}> · ⚠ key rejected</span>}
                {r.eventName && <span style={{ color: 'var(--text-4)' }}> · {String(r.eventName).slice(0, 34)}</span>}
                {r.value ? ` · $${r.value}` : ''}
                {' · '}{r.capiSent
                  ? <span style={{ color: 'var(--viz-up)', fontWeight: 700 }}>→ Meta ✓</span>
                  : <span style={{ color: 'var(--text-4)' }}>{r.decision || (r.hasEmail ? 'not forwarded' : 'no contact')}</span>}
                <span style={{ color: 'var(--accent-light)' }}> · raw ▾</span>
              </summary>
              {r.decision && <div style={{ margin: '4px 0 0', fontSize: 11, color: r.capiSent ? 'var(--viz-up)' : 'var(--text-3)' }}>{r.decision}</div>}
              <pre style={{
                margin: '6px 0 2px', padding: '8px 10px', borderRadius: 6, background: 'var(--surface-1)',
                border: '1px solid var(--border-sub)', maxHeight: 240, overflow: 'auto',
                whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 10.5, color: 'var(--text-2)',
              }}>{(() => { try { return JSON.stringify(JSON.parse(r.sample), null, 2); } catch { return r.sample || '(empty)'; } })()}</pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
