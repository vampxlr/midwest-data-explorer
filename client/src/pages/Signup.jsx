import React, { useEffect, useState } from 'react';
import { toast } from 'react-hot-toast';
import { api, setAuthToken } from '../api.jsx';
import PasswordField from '../components/PasswordField.jsx';
import { trackEvent } from '../tracking.js';

/**
 * Public self-serve signup: company + admin account in one step.
 * Trial availability is capped by the owner (active + monthly limits) — when
 * slots run out the trial pitch disappears and signups land as "pending".
 */
const SIZES = [
  { value: 'small',  label: 'Up to ~1,000 registrations / year' },
  { value: 'medium', label: '1,000 – 5,000 registrations / year' },
  { value: 'large',  label: '5,000+ registrations / year' },
];

export default function Signup({ onBack }) {
  const [avail, setAvail] = useState(null);
  const [form, setForm] = useState({ companyName: '', orgSize: 'small', username: '', email: '', password: '' });
  const [busy, setBusy] = useState(false);
  const upd = (patch) => setForm(f => ({ ...f, ...patch }));

  useEffect(() => {
    api.signupAvailability().then(r => setAvail(r.data)).catch(() => setAvail({ trialAvailable: false }));
  }, []);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.signup(form);
      trackEvent(r.data.billing?.status === 'trialing' ? 'begin_trial' : 'sign_up', { method: 'form' });
      setAuthToken(r.data.token);
      toast.success('Welcome aboard!');
      window.location.href = '/';
    } catch (err) {
      toast.error(err.response?.data?.error || 'Signup failed — try again');
      setBusy(false);
    }
  }

  const trial = avail?.trialAvailable;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-base)', color: 'var(--text-1)', display: 'flex', flexDirection: 'column' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px clamp(16px,5vw,64px)', borderBottom: '1px solid var(--border-sub)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontWeight: 800, fontSize: 15 }}>
          <span style={{ fontSize: 24 }}>🏀</span> Data Explorer
        </div>
        <button className="btn-secondary" style={{ width: 'auto', margin: 0 }} onClick={onBack}>← Back</button>
      </header>

      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 16px' }}>
        <form onSubmit={submit} className="card" style={{ width: '100%', maxWidth: 440, padding: '32px 30px', margin: 0 }}>
          <h1 style={{ margin: '0 0 6px', fontSize: 24, letterSpacing: '-0.5px' }}>Create your account</h1>
          {avail === null ? (
            <p style={{ fontSize: 13, color: 'var(--text-4)' }}>Checking trial availability…</p>
          ) : trial ? (
            <p style={{ fontSize: 13.5, color: 'var(--text-3)', margin: '0 0 20px' }}>
              <span style={{ display: 'inline-block', padding: '3px 12px', borderRadius: 999, background: 'rgba(34,197,94,0.12)', color: 'var(--viz-up)', fontWeight: 700, fontSize: 12, marginRight: 6 }}>
                {avail.trialDays}-day free trial
              </span>
              No card required to start.
            </p>
          ) : (
            <p style={{ fontSize: 13.5, color: 'var(--text-3)', margin: '0 0 20px' }}>
              Free trial slots are full this month — create your account now and we'll activate you as soon as a slot opens (or subscribe right away).
            </p>
          )}

          <label className="field-label">Organization / company name *</label>
          <input className="field-input" style={{ width: '100%', marginBottom: 14 }} required
            placeholder="e.g. Northside Hoops" value={form.companyName} onChange={e => upd({ companyName: e.target.value })} />

          <label className="field-label">Organization size</label>
          <select className="field-input" style={{ width: '100%', marginBottom: 14 }}
            value={form.orgSize} onChange={e => upd({ orgSize: e.target.value })}>
            {SIZES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>

          <label className="field-label">Username *</label>
          <input className="field-input" style={{ width: '100%', marginBottom: 14 }} required
            autoComplete="username" value={form.username} onChange={e => upd({ username: e.target.value })} />

          <label className="field-label">Email (enables Sign in with Google)</label>
          <input className="field-input" type="email" style={{ width: '100%', marginBottom: 14 }}
            value={form.email} onChange={e => upd({ email: e.target.value })} />

          <label className="field-label">Password * (8+ characters)</label>
          <div style={{ marginBottom: 20 }}>
            <PasswordField value={form.password} onChange={v => upd({ password: v })} required
              inputStyle={{ width: '100%' }} style={{ width: '100%' }} />
          </div>

          <button type="submit" className="btn-primary" style={{ width: '100%', padding: 12, fontSize: 15 }} disabled={busy}>
            {busy ? 'Creating…' : trial ? `Start my ${avail.trialDays}-day free trial →` : 'Create account →'}
          </button>
          <p style={{ fontSize: 11.5, color: 'var(--text-4)', textAlign: 'center', margin: '14px 0 0' }}>
            By signing up you agree to fair use of the platform. You can cancel anytime.
          </p>
        </form>
      </div>
    </div>
  );
}
