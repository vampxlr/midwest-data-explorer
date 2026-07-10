import React, { useEffect, useState } from 'react';
import { api } from '../api.jsx';
import { trackEvent } from '../tracking.js';

/**
 * auto1labs service offers (media buying, GTM/CAPI tracking setup), matched
 * server-side to the organization's size and curated from the owner dashboard.
 * Dismissal is per-offer and per-browser.
 */
export default function PromoPanel({ compact }) {
  const [offers, setOffers] = useState([]);
  const [dismissed, setDismissed] = useState(() => {
    try { return JSON.parse(localStorage.getItem('mw3-promo-dismissed') || '[]'); } catch { return []; }
  });

  useEffect(() => {
    api.getOffers().then(r => setOffers(r.data.offers || [])).catch(() => {});
  }, []);

  const visible = offers.filter(o => !dismissed.includes(o.id));
  if (!visible.length) return null;

  function dismiss(id) {
    const next = [...dismissed, id];
    setDismissed(next);
    try { localStorage.setItem('mw3-promo-dismissed', JSON.stringify(next)); } catch {}
  }

  return (
    <div style={{ display: 'grid', gap: 10, gridTemplateColumns: compact ? '1fr' : 'repeat(auto-fit, minmax(280px, 1fr))', margin: '16px 0' }}>
      {visible.map(o => (
        <div key={o.id} style={{
          position: 'relative', border: '1px solid rgba(249,115,22,0.35)', borderRadius: 12,
          padding: '14px 16px', background: 'linear-gradient(135deg, rgba(249,115,22,0.07), rgba(99,102,241,0.05))',
        }}>
          <button onClick={() => dismiss(o.id)} title="Dismiss" style={{
            position: 'absolute', top: 8, right: 10, border: 'none', background: 'none',
            color: 'var(--text-4)', cursor: 'pointer', fontSize: 13,
          }}>✕</button>
          <div style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--accent-2)', marginBottom: 4 }}>
            {o.service === 'media' ? '📣 Media buying' : '🛠 Tracking setup'} · auto1labs
          </div>
          <div style={{ fontSize: 14.5, fontWeight: 700 }}>{o.title}
            {o.priceLabel && <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 700, color: 'var(--viz-up)' }}>{o.priceLabel}</span>}
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.55, margin: '5px 0 10px' }}>{o.desc}</p>
          <a href={o.url} target="_blank" rel="noreferrer" className="btn-primary"
            style={{ display: 'inline-block', textDecoration: 'none', padding: '7px 18px', fontSize: 13 }}
            onClick={() => trackEvent('offer_click', { offer_id: o.id, service: o.service })}>
            Learn more →
          </a>
        </div>
      ))}
    </div>
  );
}
