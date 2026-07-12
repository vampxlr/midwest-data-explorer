import React, { useEffect, useState } from 'react';
import { toast } from 'react-hot-toast';
import { api } from '../api.jsx';
import WebhookInspector from './WebhookInspector.jsx';

/**
 * ORGANIZATION-level marketing signal: this org's GA4 / Meta pixel / CAPI
 * token (encrypted, write-only) + its personal SE webhook URL + delivery
 * inspector. Rendered for company admins in their dashboard and for the
 * built-in company's admins inside Data Management — never platform-global.
 */
export default function TrackingCard() {
  const [cfg, setCfg] = useState(null);
  const [capiToken, setCapiToken] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.getCompanyTracking().then(r => setCfg(r.data)).catch(() => {}); }, []);
  if (!cfg) return null;
  const upd = (patch) => setCfg(c => ({ ...c, ...patch }));

  async function save() {
    setBusy(true);
    try {
      await api.saveCompanyTracking({ ga4Id: cfg.ga4Id, metaPixelId: cfg.metaPixelId, ...(capiToken.trim() ? { capiToken: capiToken.trim() } : {}) });
      setCapiToken('');
      toast.success('Tracking settings saved');
    } catch (err) { toast.error(err.response?.data?.error || 'Save failed'); }
    finally { setBusy(false); }
  }

  return (
    <div className="card" style={{ marginTop: 20 }}>
      <h2>Tracking & Meta signal</h2>
      <p style={{ fontSize: 12.5, color: 'var(--text-3)', margin: '2px 0 14px', maxWidth: 720, lineHeight: 1.55 }}>
        SportsEngine checkout can't run a pixel — instead, point SportsEngine's webhooks at the URL below and
        every new registration is verified and forwarded to <b>this organization's</b> Meta pixel via the
        Conversions API (primary contact only, hashed). In SE HQ → your API application → Settings: paste the
        URL under <b>Webhooks URL</b> and enable the <b>Registration</b> + <b>Registration Result</b> toggles.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
        <code style={{ fontSize: 11, background: 'var(--bg-hover)', padding: '6px 10px', borderRadius: 8, wordBreak: 'break-all', flex: 1, minWidth: 260 }}>{cfg.webhookUrl}</code>
        <button className="btn-secondary" style={{ width: 'auto', margin: 0 }}
          onClick={() => navigator.clipboard.writeText(cfg.webhookUrl).then(() => toast.success('Webhook URL copied'))}>📋 Copy</button>
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 14 }}>
        <div>
          <label className="field-label">Meta Pixel ID</label>
          <input className="field-input" style={{ width: 160 }} placeholder="1234567890"
            value={cfg.metaPixelId} onChange={e => upd({ metaPixelId: e.target.value })} />
        </div>
        <div>
          <label className="field-label">Meta CAPI token {cfg.hasCapiToken && '(saved)'}</label>
          <input className="field-input" type="password" style={{ width: 230 }}
            placeholder={cfg.hasCapiToken ? '••••••••  (unchanged)' : 'Events Manager → Conversions API'}
            value={capiToken} onChange={e => setCapiToken(e.target.value)} />
        </div>
        <div>
          <label className="field-label">GA4 Measurement ID</label>
          <input className="field-input" style={{ width: 150 }} placeholder="G-XXXXXXXXXX"
            value={cfg.ga4Id} onChange={e => upd({ ga4Id: e.target.value })} />
        </div>
        <button className="btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save tracking'}</button>
      </div>
      <WebhookInspector compactTitle="Registrations SportsEngine has sent to this organization's webhook — expand a row for the raw payload." />
    </div>
  );
}
