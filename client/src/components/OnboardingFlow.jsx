import React, { useState } from 'react';
import { toast } from 'react-hot-toast';
import { api } from '../api.jsx';
import { trackEvent } from '../tracking.js';

/**
 * Self-serve SportsEngine onboarding: guide video + step-by-step + the
 * credential form. On success the org is verified, locked and ready —
 * "Enter Data Explorer" appears immediately.
 */
function embedUrl(url) {
  if (!url) return null;
  const yt = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{6,})/);
  if (yt) return `https://www.youtube.com/embed/${yt[1]}`;
  const loom = url.match(/loom\.com\/share\/([\w]+)/);
  if (loom) return `https://www.loom.com/embed/${loom[1]}`;
  return url; // already an embed link
}

const STEPS = [
  ['Sign in to SportsEngine HQ', 'Open your organization\'s SportsEngine HQ as an administrator.'],
  ['Open API credentials', 'Settings → Developer / API — request or view your API credentials (Client Credentials).'],
  ['Copy Client ID & Secret', 'Copy both values. The secret is shown once — keep the tab open until you\'ve pasted it below.'],
  ['Connect', 'Paste them here. We verify with SportsEngine instantly, detect your organization automatically, and encrypt the secret.'],
];

export default function OnboardingFlow({ videoUrl, onConnected, onCancel, firstOrg }) {
  const [form, setForm] = useState({ seClientId: '', seClientSecret: '' });
  const [busy, setBusy] = useState(false);
  const video = embedUrl(videoUrl);

  async function connect(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.companyCreateOrg(form);
      trackEvent('org_connected', {});
      toast.success(`Connected: ${r.data.seName || r.data.org.name} ✓`);
      onConnected();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Connection failed');
      setBusy(false);
    }
  }

  return (
    <div style={{ border: '1px solid var(--chip-border)', borderRadius: 14, padding: 'clamp(16px, 3vw, 28px)', background: 'var(--surface-2)' }}>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: 1.4, textTransform: 'uppercase', color: 'var(--accent-light)', marginBottom: 6 }}>
        {firstOrg ? 'Get set up in ~5 minutes' : 'Connect another organization'}
      </div>
      <h2 style={{ margin: '0 0 6px' }}>Connect your SportsEngine organization</h2>
      <p style={{ fontSize: 13.5, color: 'var(--text-3)', margin: '0 0 18px', maxWidth: 640 }}>
        Your registration data stays in your SportsEngine account — we connect with read-only API
        credentials that you create and can revoke anytime.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 22 }}>
        {/* Guide video + steps */}
        <div>
          {video ? (
            <div style={{ position: 'relative', paddingTop: '56.25%', borderRadius: 12, overflow: 'hidden', border: '1px solid var(--border)', marginBottom: 14 }}>
              <iframe src={video} title="Setup walkthrough"
                style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none' }}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture" allowFullScreen />
            </div>
          ) : (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8,
              borderRadius: 12, border: '1px dashed var(--border)', background: 'var(--bg-hover)',
              minHeight: 170, marginBottom: 14, color: 'var(--text-4)', fontSize: 13,
            }}>
              <span style={{ fontSize: 34 }}>🎬</span>
              Setup walkthrough video coming soon
            </div>
          )}
          <ol style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'grid', gap: 10 }}>
            {STEPS.map(([title, desc], i) => (
              <li key={i} style={{ display: 'flex', gap: 10 }}>
                <span style={{
                  flexShrink: 0, width: 22, height: 22, borderRadius: '50%', fontSize: 11, fontWeight: 800,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: 'rgba(99,102,241,0.14)', color: 'var(--accent-light)',
                }}>{i + 1}</span>
                <span style={{ fontSize: 13 }}>
                  <b>{title}</b>
                  <span style={{ display: 'block', color: 'var(--text-4)', fontSize: 12, lineHeight: 1.5 }}>{desc}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>

        {/* Credential form */}
        <form onSubmit={connect} style={{ alignSelf: 'start', background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 12, padding: '20px 22px' }}>
          <label className="field-label">SportsEngine Client ID *</label>
          <input className="field-input" style={{ width: '100%', marginBottom: 14 }} required
            autoComplete="off" spellCheck={false} placeholder="e.g. 4f8a1c…"
            value={form.seClientId} onChange={e => setForm(f => ({ ...f, seClientId: e.target.value }))} />

          <label className="field-label">SportsEngine Client Secret *</label>
          <input className="field-input" type="password" style={{ width: '100%', marginBottom: 6 }} required
            autoComplete="off" placeholder="paste the secret"
            value={form.seClientSecret} onChange={e => setForm(f => ({ ...f, seClientSecret: e.target.value }))} />
          <p style={{ fontSize: 11.5, color: 'var(--text-4)', margin: '0 0 16px' }}>
            🔒 Verified live with SportsEngine, then encrypted (AES-256) — never shown again, not even to us.
          </p>

          <button type="submit" className="btn-primary" style={{ width: '100%', padding: 11 }} disabled={busy}>
            {busy ? 'Verifying with SportsEngine…' : 'Connect & verify →'}
          </button>
          {onCancel && (
            <button type="button" className="btn-secondary" style={{ width: '100%', marginTop: 8 }} onClick={onCancel}>Cancel</button>
          )}
        </form>
      </div>
    </div>
  );
}
