import React, { useEffect, useState } from 'react';
import { api } from '../api.jsx';
import { toast } from 'react-hot-toast';

/**
 * Super admin panel — /superadmin (role 'superadmin' only).
 *   1. Landing page editor: pricing, banner, tagline, features/benefits
 *   2. Organizations registry: SE credentials per customer org (multi-tenant prep)
 *   3. Billing status (Stripe-ready, dormant until keys are configured)
 */

const inputStyle = { width:'100%', boxSizing:'border-box' };

function Field({ label, children }) {
  return (
    <div style={{ marginBottom:12 }}>
      <label className="field-label">{label}</label>
      {children}
    </div>
  );
}

// ── 1. Landing page / pricing editor ──────────────────────────────────────────
function SiteSettingsEditor() {
  const [s, setS] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { api.getSiteSettings().then(r => setS(r.data)).catch(() => toast.error('Failed to load settings')); }, []);

  function upd(patch) { setS(prev => ({ ...prev, ...patch })); }
  function updFeature(i, patch) {
    setS(prev => ({ ...prev, features: prev.features.map((f, idx) => idx === i ? { ...f, ...patch } : f) }));
  }

  async function save() {
    setSaving(true);
    try {
      await api.setSiteSettings(s);
      toast.success('Landing page updated');
    } catch (err) { toast.error('Save failed: ' + (err.response?.data?.error || err.message)); }
    finally { setSaving(false); }
  }

  if (!s) return <div className="no-data">Loading…</div>;

  return (
    <div className="card">
      <h2>Landing Page & Pricing</h2>
      <div className="grid-2" style={{ gap:14 }}>
        <Field label="App name">
          <input className="field-input" style={inputStyle} value={s.appName || ''} onChange={e => upd({ appName: e.target.value })} />
        </Field>
        <Field label="Beta banner text">
          <input className="field-input" style={inputStyle} value={s.betaBanner || ''} onChange={e => upd({ betaBanner: e.target.value })} />
        </Field>
      </div>
      <Field label="Tagline">
        <textarea className="field-input" style={{ ...inputStyle, minHeight:56, resize:'vertical' }} value={s.tagline || ''} onChange={e => upd({ tagline: e.target.value })} />
      </Field>
      <div className="grid-2" style={{ gap:14 }}>
        <Field label="Regular price ($/month — shown crossed out)">
          <input className="field-input" style={inputStyle} type="number" value={s.priceMonthly ?? ''} onChange={e => upd({ priceMonthly: Number(e.target.value) })} />
        </Field>
        <Field label="Beta price ($/month)">
          <input className="field-input" style={inputStyle} type="number" value={s.betaPriceMonthly ?? ''} onChange={e => upd({ betaPriceMonthly: Number(e.target.value) })} />
        </Field>
      </div>

      <h3 style={{ margin:'16px 0 10px' }}>Features & benefits</h3>
      {(s.features || []).map((f, i) => (
        <div key={i} style={{ display:'flex', gap:8, marginBottom:8, alignItems:'flex-start' }}>
          <input className="field-input" placeholder="Title" value={f.title || ''}
            onChange={e => updFeature(i, { title: e.target.value })} style={{ width:240, flexShrink:0 }} />
          <input className="field-input" placeholder="Description" value={f.desc || ''}
            onChange={e => updFeature(i, { desc: e.target.value })} style={{ flex:1 }} />
          <button onClick={() => setS(prev => ({ ...prev, features: prev.features.filter((_, idx) => idx !== i) }))}
            title="Remove feature"
            style={{ background:'none', border:'none', color:'var(--text-4)', cursor:'pointer', fontSize:16, padding:'6px 4px' }}>×</button>
        </div>
      ))}
      <button className="btn-chart" onClick={() => setS(prev => ({ ...prev, features: [...(prev.features || []), { title:'', desc:'' }] }))}>
        + Add feature
      </button>

      <div style={{ marginTop:18 }}>
        <button className="btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save landing page'}
        </button>
        <a href="/" onClick={e => { e.preventDefault(); window.open('/?landing-preview=1', '_blank'); }}
          style={{ marginLeft:14, fontSize:12, color:'var(--accent-light)' }}>
          Preview landing page ↗
        </a>
      </div>
    </div>
  );
}

// ── 2. Organizations registry ─────────────────────────────────────────────────
const emptyOrg = () => ({
  orgKey: crypto.randomUUID(), name:'', seOrgId:'', seClientId:'', seClientSecret:'',
  status:'beta', subscriptionStatus:'beta', notes:'',
});

function OrgEditor({ org, onSaved, onCancel }) {
  const [o, setO] = useState(org);
  const [saving, setSaving] = useState(false);
  const upd = patch => setO(prev => ({ ...prev, ...patch }));

  async function save() {
    if (!o.name.trim()) { toast.error('Organization name is required'); return; }
    setSaving(true);
    try {
      await api.saveOrg(o.orgKey, o);
      toast.success('Organization saved');
      onSaved();
    } catch (err) { toast.error('Save failed: ' + (err.response?.data?.error || err.message)); }
    finally { setSaving(false); }
  }

  return (
    <div style={{ background:'var(--surface-2)', border:'1px solid var(--line)', borderRadius:12, padding:16, marginBottom:14 }}>
      <div className="grid-2" style={{ gap:12 }}>
        <Field label="Organization name *">
          <input className="field-input" style={inputStyle} value={o.name} onChange={e => upd({ name: e.target.value })} autoFocus />
        </Field>
        <Field label="SportsEngine Org ID">
          <input className="field-input" style={inputStyle} value={o.seOrgId || ''} onChange={e => upd({ seOrgId: e.target.value })} placeholder="e.g. 8008" />
        </Field>
        <Field label="SE Client ID">
          <input className="field-input" style={inputStyle} value={o.seClientId || ''} onChange={e => upd({ seClientId: e.target.value })} />
        </Field>
        <Field label="SE Client Secret">
          <input className="field-input" style={inputStyle} type="password" value={o.seClientSecret || ''}
            onChange={e => upd({ seClientSecret: e.target.value })}
            placeholder="write-only — leave dots to keep current" />
        </Field>
        <Field label="Status">
          <select className="field-input" style={inputStyle} value={o.status} onChange={e => upd({ status: e.target.value })}>
            <option value="beta">beta</option>
            <option value="active">active</option>
            <option value="suspended">suspended</option>
          </select>
        </Field>
        <Field label="Notes">
          <input className="field-input" style={inputStyle} value={o.notes || ''} onChange={e => upd({ notes: e.target.value })} />
        </Field>
      </div>
      <div style={{ display:'flex', gap:8 }}>
        <button className="btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save organization'}</button>
        <button className="btn-chart" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function OrgsPanel() {
  const [orgs, setOrgs] = useState([]);
  const [editing, setEditing] = useState(null); // org object | null
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try { const r = await api.listOrgs(); setOrgs(r.data.orgs || []); }
    catch (err) { toast.error('Failed to load orgs: ' + err.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function remove(o) {
    if (!window.confirm(`Delete organization "${o.name}"? Its stored SE credentials will be removed.`)) return;
    try { await api.deleteOrg(o.orgKey); toast.success('Deleted'); load(); }
    catch (err) { toast.error(err.message); }
  }

  return (
    <div className="card">
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
        <h2 style={{ margin:0 }}>Organizations</h2>
        {!editing && <button className="btn-primary" onClick={() => setEditing(emptyOrg())}>+ Add organization</button>}
      </div>
      <p style={{ fontSize:12, color:'var(--text-3)', margin:'0 0 14px', lineHeight:1.5 }}>
        Each customer organization stores its own SportsEngine credentials here. Credentials are
        write-only (never displayed back). Full multi-tenant fetching lands in a later phase —
        today the app still runs on the default Midwest credentials.
      </p>

      {editing && <OrgEditor org={editing} onSaved={() => { setEditing(null); load(); }} onCancel={() => setEditing(null)} />}

      {loading ? <div className="no-data">Loading…</div> : orgs.length === 0 ? (
        <div className="no-data" style={{ padding:'24px' }}>No organizations yet.</div>
      ) : (
        <div style={{ overflowX:'auto' }}>
          <table className="data-table">
            <thead>
              <tr><th>Name</th><th>SE Org ID</th><th>Credentials</th><th>Status</th><th>Billing</th><th></th></tr>
            </thead>
            <tbody>
              {orgs.map(o => (
                <tr key={o.orgKey}>
                  <td style={{ color:'var(--text-1)', fontWeight:600 }}>{o.name}</td>
                  <td>{o.seOrgId || '—'}</td>
                  <td>{o.seClientId ? <span className="badge badge-green">configured</span> : <span className="badge badge-orange">missing</span>}</td>
                  <td><span className={`badge ${o.status === 'active' ? 'badge-green' : o.status === 'suspended' ? 'badge-orange' : 'badge-blue'}`}>{o.status}</span></td>
                  <td style={{ fontSize:12, color:'var(--text-3)' }}>{o.subscriptionStatus || 'beta'}</td>
                  <td style={{ whiteSpace:'nowrap' }}>
                    <button className="btn-chart" style={{ marginRight:6 }} onClick={() => setEditing(o)}>Edit</button>
                    <button onClick={() => remove(o)}
                      style={{ background:'none', border:'1px solid rgba(239,68,68,0.35)', color:'var(--danger-text)', borderRadius:999, padding:'6px 12px', fontSize:12, fontWeight:600, cursor:'pointer' }}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── 3. Billing (Stripe-ready, dormant) ────────────────────────────────────────
function BillingPanel() {
  return (
    <div className="card">
      <h2>Billing</h2>
      <div style={{
        display:'flex', alignItems:'center', gap:12, padding:'14px 16px', borderRadius:10,
        background:'rgba(249,115,22,0.08)', border:'1px solid rgba(249,115,22,0.3)',
      }}>
        <span style={{ fontSize:22 }}>💳</span>
        <div>
          <div style={{ fontSize:13, fontWeight:700, color:'var(--accent-2)' }}>Stripe not connected — beta mode (free)</div>
          <div style={{ fontSize:12, color:'var(--text-3)', marginTop:2 }}>
            The platform is Stripe-ready: add <code>STRIPE_SECRET_KEY</code>, <code>STRIPE_WEBHOOK_SECRET</code>, and a
            price ID to the environment and billing activates. Webhook endpoint is already live at <code>/api/billing/webhook</code>.
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function SuperAdmin() {
  return (
    <div>
      <div className="page-header">
        <h1>Super Admin</h1>
        <p>Platform controls — landing page content, pricing, customer organizations, billing</p>
      </div>
      <SiteSettingsEditor />
      <OrgsPanel />
      <BillingPanel />
    </div>
  );
}
