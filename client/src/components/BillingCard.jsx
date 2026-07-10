import React, { useEffect, useState } from 'react';
import { toast } from 'react-hot-toast';
import { api } from '../api.jsx';
import { trackEvent } from '../tracking.js';

/**
 * Subscription status + actions for a customer company.
 * Dormant-safe: without Stripe keys the subscribe button explains that
 * billing opens soon; with keys it goes straight to Stripe Checkout.
 */
const STATUS_UI = {
  trialing:  { label: 'Free trial',       color: 'var(--viz-up)',      bg: 'rgba(34,197,94,0.12)' },
  active:    { label: 'Active',           color: 'var(--viz-up)',      bg: 'rgba(34,197,94,0.12)' },
  past_due:  { label: 'Payment issue',    color: '#f59e0b',            bg: 'rgba(245,158,11,0.12)' },
  canceled:  { label: 'Canceled',         color: '#ef4444',            bg: 'rgba(239,68,68,0.12)' },
  expired:   { label: 'Trial ended',      color: '#ef4444',            bg: 'rgba(239,68,68,0.12)' },
  pending:   { label: 'Awaiting activation', color: 'var(--text-3)',   bg: 'var(--bg-hover)' },
  none:      { label: 'Free beta',        color: 'var(--accent-light)', bg: 'rgba(99,102,241,0.12)' },
  internal:  { label: 'Internal',         color: 'var(--text-3)',      bg: 'var(--bg-hover)' },
};

export default function BillingCard() {
  const [b, setB] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.billingMe().then(r => setB(r.data)).catch(() => {});
    if (window.location.search.includes('billing=success')) {
      toast.success('Subscription active — welcome!');
      trackEvent('purchase', {});
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  if (!b || b.status === 'internal') return null;
  const ui = STATUS_UI[b.status] || STATUS_UI.none;
  const needsAction = ['expired', 'canceled', 'past_due', 'pending'].includes(b.status);

  async function checkout() {
    setBusy(true);
    trackEvent('begin_checkout', {});
    try {
      const r = await api.billingCheckout();
      window.location.href = r.data.url;
    } catch (err) {
      toast(err.response?.data?.error || 'Billing is not available yet', { icon: 'ℹ️' });
      setBusy(false);
    }
  }
  async function portal() {
    try { window.location.href = (await api.billingPortal()).data.url; }
    catch (err) { toast.error(err.response?.data?.error || 'Could not open billing portal'); }
  }

  return (
    <div className="card" style={needsAction ? { border: '1px solid rgba(239,68,68,0.4)' } : undefined}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: '0 0 4px' }}>Subscription</h2>
          <span style={{ fontSize: 12, fontWeight: 800, padding: '3px 12px', borderRadius: 999, background: ui.bg, color: ui.color }}>
            {ui.label}
          </span>
          {b.status === 'trialing' && (
            <span style={{ marginLeft: 10, fontSize: 13, color: 'var(--text-3)' }}>
              {b.trialDaysLeft} day{b.trialDaysLeft === 1 ? '' : 's'} left — subscribe anytime to keep access.
            </span>
          )}
          {b.status === 'expired' && <span style={{ marginLeft: 10, fontSize: 13, color: 'var(--text-3)' }}>Your trial has ended — subscribe to keep your data flowing.</span>}
          {b.status === 'past_due' && <span style={{ marginLeft: 10, fontSize: 13, color: 'var(--text-3)' }}>Your last payment failed — update your card to avoid interruption.</span>}
          {b.status === 'pending' && <span style={{ marginLeft: 10, fontSize: 13, color: 'var(--text-3)' }}>Trial slots were full when you signed up — subscribe now or wait for the next opening.</span>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {['trialing', 'expired', 'canceled', 'pending', 'none'].includes(b.status) && (
            <button className="btn-primary" onClick={checkout} disabled={busy}>
              {busy ? 'Opening…' : b.stripeEnabled ? 'Subscribe now →' : 'Subscribe (opens soon)'}
            </button>
          )}
          {['active', 'past_due'].includes(b.status) && (
            <button className="btn-secondary" style={{ width: 'auto', margin: 0 }} onClick={portal}>Manage billing</button>
          )}
        </div>
      </div>
    </div>
  );
}
