import React, { useEffect, useState } from 'react';
import { api } from '../api.jsx';
import { useAuth } from '../AuthContext.jsx';
import { toast } from 'react-hot-toast';

// Deletion is disabled platform-wide for safety (PLATFORM_DELETES_ENABLED is
// off server-side too). The full guard flow — typed name + email 2FA — is
// implemented and runs the moment the kill-switch is flipped.
const DELETES_LOCKED = true;

async function guardedDelete({ kind, name, key, apiDelete }) {
  if (DELETES_LOCKED) { toast.error('Deletion is disabled platform-wide for safety'); return false; }
  if (!window.confirm(`Delete ${kind} "${name}"? This cannot be undone.`)) return false;
  if (!window.confirm(`FINAL WARNING — all of "${name}" will be permanently removed. Continue?`)) return false;
  const typed = window.prompt(`Type the exact ${kind} name to confirm:\n\n${name}`);
  if (typed !== name) { toast.error('Name did not match — deletion aborted'); return false; }
  try {
    const rq = await api.requestDelete({ targetType: kind === 'company' ? 'account' : 'org', targetKey: key });
    let code;
    if (rq.data.emailConfigured) {
      code = window.prompt(rq.data.emailSent
        ? 'A 6-digit confirmation code was sent to your email. Enter it:'
        : 'Email delivery failed — check RESEND_API_KEY. Enter the code if you received one:');
      if (!code) return false;
    }
    await apiDelete(key, { confirmName: typed, code });
    toast.success(`${kind} deleted`);
    return true;
  } catch (err) {
    toast.error(err.response?.data?.error || err.message);
    return false;
  }
}

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

// ── 2. Companies → Organizations ──────────────────────────────────────────────
const emptyOrg = (accountKey) => ({
  orgKey: crypto.randomUUID(), accountKey, name:'', seOrgId:'', seClientId:'', seClientSecret:'',
  status:'beta', subscriptionStatus:'beta', notes:'',
});

function CredentialGuide() {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ margin:'4px 0 14px' }}>
      <button onClick={() => setOpen(v => !v)}
        style={{ background:'none', border:'none', cursor:'pointer', fontSize:12, fontWeight:600, color:'var(--accent-light)', padding:0 }}>
        {open ? '▾' : '▸'} How to get SportsEngine credentials
      </button>
      {open && (
        <ol style={{ fontSize:12, color:'var(--text-3)', lineHeight:1.8, margin:'8px 0 0', paddingLeft:20 }}>
          <li>Sign in to <strong>SportsEngine HQ</strong> as the organization owner.</li>
          <li>Contact SportsEngine support (or your account rep) and request <strong>API access / OAuth client credentials</strong> for your organization.</li>
          <li>They will issue a <strong>Client ID</strong> and <strong>Client Secret</strong> tied to your organization ID.</li>
          <li>Paste both below, then click <strong>Verify & Lock</strong> — we test them live against SportsEngine, show you the organization name they belong to, then encrypt and lock them (they can never be viewed again).</li>
          <li>After verification, the initial data import runs — it can take a few minutes for large organizations; you can leave the page and come back.</li>
        </ol>
      )}
    </div>
  );
}

function OrgEditor({ org, onSaved, onCancel }) {
  const [o, setO] = useState(org);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const upd = patch => setO(prev => ({ ...prev, ...patch }));
  const locked = !!o.lockedAt;

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

  async function verify() {
    if (!o.name.trim()) { toast.error('Organization name is required'); return; }
    setVerifying(true);
    try {
      // Persist current fields first so verify sees them
      await api.saveOrg(o.orgKey, o);
      const r = await api.verifyOrg(o.orgKey, { seClientId: o.seClientId, seClientSecret: o.seClientSecret });
      toast.success(`✓ Verified with SportsEngine${r.data.seName ? ` — "${r.data.seName}"` : ''}. Credentials encrypted & locked.`);
      onSaved();
    } catch (err) {
      const d = err.response?.data;
      toast.error(d?.detail ? `${d.error}: ${d.detail}` : (d?.error || err.message));
    } finally { setVerifying(false); }
  }

  return (
    <div style={{ background:'var(--surface-2)', border:'1px solid var(--line)', borderRadius:12, padding:16, marginBottom:14 }}>
      <CredentialGuide />
      {locked && (
        <div style={{ marginBottom:12, padding:'8px 12px', borderRadius:8, fontSize:12, fontWeight:600,
          background:'rgba(34,197,94,0.1)', border:'1px solid rgba(34,197,94,0.3)', color:'var(--viz-up)' }}>
          🔒 Credentials verified{o.verifiedOrgName ? ` for "${o.verifiedOrgName}"` : ''} and locked
          {o.lockedAt ? ` on ${new Date(o.lockedAt).toLocaleDateString()}` : ''} — enter a new secret and re-verify to replace them.
        </div>
      )}
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
      <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
        <button className="btn-primary" onClick={save} disabled={saving || verifying}>{saving ? 'Saving…' : 'Save organization'}</button>
        <button className="btn-action-green" onClick={verify} disabled={saving || verifying}
          title="Tests the credentials live against SportsEngine, then encrypts and locks them">
          {verifying ? 'Verifying with SportsEngine…' : locked ? '🔒 Verify & Replace credentials' : '✓ Verify & Lock credentials'}
        </button>
        <button className="btn-chart" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function CompaniesPanel() {
  const [accounts, setAccounts] = useState([]);
  const [orgs, setOrgs] = useState([]);
  const [selected, setSelected] = useState(null);   // accountKey | null
  const [editing, setEditing] = useState(null);     // org object | null
  const [addingCompany, setAddingCompany] = useState(false);
  const [companyName, setCompanyName] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const [a, o] = await Promise.all([api.listAccounts(), api.listOrgs()]);
      setAccounts(a.data.accounts || []);
      setOrgs(o.data.orgs || []);
    }
    catch (err) { toast.error('Failed to load: ' + err.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function addCompany() {
    if (!companyName.trim()) { toast.error('Company name is required'); return; }
    try {
      await api.saveAccount(crypto.randomUUID(), { name: companyName.trim() });
      setCompanyName(''); setAddingCompany(false);
      toast.success('Company added');
      load();
    } catch (err) { toast.error(err.response?.data?.error || err.message); }
  }

  async function removeCompany(a) {
    const count = orgs.filter(o => o.accountKey === a.accountKey).length;
    if (count > 0) { toast.error('Delete or reassign its organizations first'); return; }
    const ok = await guardedDelete({ kind: 'company', name: a.name, key: a.accountKey, apiDelete: api.deleteAccount });
    if (ok) { setSelected(null); load(); }
  }

  async function remove(o) {
    const ok = await guardedDelete({ kind: 'org', name: o.name, key: o.orgKey, apiDelete: api.deleteOrg });
    if (ok) load();
  }

  const selectedAccount = accounts.find(a => a.accountKey === selected);
  const companyOrgs = selected ? orgs.filter(o => o.accountKey === selected) : [];

  // ── Companies list view ──
  if (!selected) {
    return (
      <div className="card">
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
          <h2 style={{ margin:0 }}>Companies</h2>
          {!addingCompany && <button className="btn-primary" onClick={() => setAddingCompany(true)}>+ Add company</button>}
        </div>
        <p style={{ fontSize:12, color:'var(--text-3)', margin:'0 0 14px', lineHeight:1.5 }}>
          Each customer company owns one or more SportsEngine organizations. Click a company to
          see its organizations and enter their data explorers.
        </p>
        {addingCompany && (
          <div style={{ display:'flex', gap:8, marginBottom:14 }}>
            <input className="field-input" style={{ flex:1 }} placeholder="Company name"
              value={companyName} onChange={e => setCompanyName(e.target.value)} autoFocus
              onKeyDown={e => e.key === 'Enter' && addCompany()} />
            <button className="btn-primary" onClick={addCompany}>Add</button>
            <button className="btn-chart" onClick={() => setAddingCompany(false)}>Cancel</button>
          </div>
        )}
        {loading ? <div className="no-data">Loading…</div> : (
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(260px, 1fr))', gap:12 }}>
            {accounts.map(a => {
              const n = orgs.filter(o => o.accountKey === a.accountKey).length;
              return (
                <div key={a.accountKey} onClick={() => setSelected(a.accountKey)}
                  style={{ background:'var(--surface-2)', border:'1px solid var(--line)', borderRadius:12,
                    padding:'16px 18px', cursor:'pointer' }}>
                  <div style={{ fontSize:15, fontWeight:700, color:'var(--text-1)' }}>🏢 {a.name}</div>
                  <div style={{ fontSize:12, color:'var(--text-3)', marginTop:4 }}>
                    {n} organization{n !== 1 ? 's' : ''} · since {new Date(a.createdAt).toLocaleDateString()}
                  </div>
                  <div style={{ fontSize:12, color:'var(--accent-light)', marginTop:10, fontWeight:600 }}>
                    View organizations →
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // ── Single company view: its organizations ──
  return (
    <div className="card">
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12, flexWrap:'wrap', gap:8 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <button className="btn-chart" onClick={() => { setSelected(null); setEditing(null); }}>← Companies</button>
          <h2 style={{ margin:0 }}>🏢 {selectedAccount?.name}</h2>
        </div>
        <div style={{ display:'flex', gap:8 }}>
          {!editing && <button className="btn-primary" onClick={() => setEditing(emptyOrg(selected))}>+ Add organization</button>}
          <button onClick={() => removeCompany(selectedAccount)} disabled={DELETES_LOCKED}
            title={DELETES_LOCKED ? 'Deletion is disabled platform-wide for safety' : 'Requires typed confirmation + email code'}
            style={{ background:'none', border:'1px solid rgba(239,68,68,0.35)', color:'var(--danger-text)', borderRadius:999, padding:'6px 12px', fontSize:12, fontWeight:600,
              cursor: DELETES_LOCKED ? 'not-allowed' : 'pointer', opacity: DELETES_LOCKED ? 0.4 : 1 }}>
            🔒 Delete company
          </button>
        </div>
      </div>

      {editing && <OrgEditor org={editing} onSaved={() => { setEditing(null); load(); }} onCancel={() => setEditing(null)} />}

      {loading ? <div className="no-data">Loading…</div> : companyOrgs.length === 0 ? (
        <div className="no-data" style={{ padding:'24px' }}>No organizations yet — add one to start the guided SportsEngine setup.</div>
      ) : (
        <div style={{ overflowX:'auto' }}>
          <table className="data-table">
            <thead>
              <tr><th>Name</th><th>SE Org ID</th><th>Credentials</th><th>Status</th><th>Billing</th><th></th></tr>
            </thead>
            <tbody>
              {companyOrgs.map(o => (
                <tr key={o.orgKey}>
                  <td style={{ color:'var(--text-1)', fontWeight:600 }}>
                    {o.name}
                    {o.verifiedOrgName && <div style={{ fontSize:10, color:'var(--text-4)', fontWeight:400 }}>SE: {o.verifiedOrgName}</div>}
                  </td>
                  <td>{o.seOrgId || '—'}</td>
                  <td>
                    {o.verified
                      ? <span className="badge badge-green">🔒 verified</span>
                      : o.hasCredentials
                        ? <span className="badge badge-blue">unverified</span>
                        : <span className="badge badge-orange">missing</span>}
                  </td>
                  <td><span className={`badge ${o.status === 'active' ? 'badge-green' : o.status === 'suspended' ? 'badge-orange' : 'badge-blue'}`}>{o.status}</span></td>
                  <td style={{ fontSize:12, color:'var(--text-3)' }}>{o.subscriptionStatus || 'beta'}</td>
                  <td style={{ whiteSpace:'nowrap' }}>
                    <button className="btn-primary" style={{ marginRight:6, padding:'6px 14px', fontSize:12 }}
                      onClick={() => {
                        sessionStorage.setItem('mw3-active-org', JSON.stringify({ orgKey: o.orgKey, name: o.name }));
                        window.location.href = '/';
                      }}
                      title="Open this organization's data explorer">
                      Enter Data Explorer →
                    </button>
                    <button className="btn-chart" style={{ marginRight:6 }} onClick={() => setEditing(o)}>Edit</button>
                    <button onClick={() => remove(o)} disabled={DELETES_LOCKED}
                      title={DELETES_LOCKED ? 'Deletion is disabled platform-wide for safety' : 'Requires typed confirmation + email code'}
                      style={{ background:'none', border:'1px solid rgba(239,68,68,0.35)', color:'var(--danger-text)', borderRadius:999, padding:'6px 12px', fontSize:12, fontWeight:600,
                        cursor: DELETES_LOCKED ? 'not-allowed' : 'pointer', opacity: DELETES_LOCKED ? 0.4 : 1 }}>
                      🔒 Delete
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

// ── 3. Users & Permissions (platform-wide) ────────────────────────────────────
const PLATFORM_ROLE_INFO = {
  owner:      { label: 'Owner',       color: '#f59e0b', desc: 'Platform owner — everything, including (guarded) deletes' },
  superadmin: { label: 'Super Admin', color: '#a855f7', desc: 'Everything except deleting anything' },
  admin:      { label: 'Admin',       color: '#ef4444', desc: 'Full org access incl. purge and user management' },
  editor:     { label: 'Editor',      color: '#3b82f6', desc: 'Data refresh, aggregation, exports' },
};

function PlatformUsersPanel() {
  const { isOwner, user: me } = useAuth();
  const [users, setUsers] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const [u, a] = await Promise.all([api.listUsers(), api.listAccounts()]);
      setUsers(u.data.users || []);
      setAccounts(a.data.accounts || []);
    } catch (err) { toast.error('Failed to load users: ' + (err.response?.data?.error || err.message)); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function setRole(u, role) {
    try {
      await api.updateUser(u.id, { role });
      toast.success(`"${u.username}" is now ${PLATFORM_ROLE_INFO[role]?.label || role} — applies at their next sign-in`);
      load();
    } catch (err) { toast.error(err.response?.data?.error || err.message); }
  }

  async function setCompany(u, accountKey) {
    try {
      await api.updateUser(u.id, { accountKey });
      toast.success(accountKey ? 'Linked to company' : 'Unlinked from company');
      load();
    } catch (err) { toast.error(err.response?.data?.error || err.message); }
  }

  return (
    <div className="card">
      <h2>Users & Permissions</h2>
      <p style={{ fontSize:12, color:'var(--text-3)', margin:'0 0 6px', lineHeight:1.6 }}>
        <strong style={{ color:PLATFORM_ROLE_INFO.owner.color }}>Owner</strong> — {PLATFORM_ROLE_INFO.owner.desc}. {' '}
        <strong style={{ color:PLATFORM_ROLE_INFO.superadmin.color }}>Super Admin</strong> — {PLATFORM_ROLE_INFO.superadmin.desc}. {' '}
        <strong style={{ color:PLATFORM_ROLE_INFO.admin.color }}>Admin</strong> / <strong style={{ color:PLATFORM_ROLE_INFO.editor.color }}>Editor</strong> — org-level roles.
      </p>
      <p style={{ fontSize:11, color:'var(--text-4)', margin:'0 0 14px' }}>
        {isOwner ? 'Only you (Owner) can grant Owner or Super Admin.' : 'Only the Owner can grant Owner or Super Admin roles.'}
        {' '}Linking a user to a company gives them that company’s dashboard instead of the Midwest explorer.
      </p>
      {loading ? <div className="no-data">Loading…</div> : (
        <div style={{ overflowX:'auto' }}>
          <table className="data-table">
            <thead><tr><th>User</th><th>Email</th><th>Platform role</th><th>Company</th><th>Last login</th></tr></thead>
            <tbody>
              {users.map(u => {
                const info = PLATFORM_ROLE_INFO[u.role] || { label: u.role, color: 'var(--text-3)' };
                const isSelf = u.id === me?.id;
                return (
                  <tr key={u.id}>
                    <td style={{ color:'var(--text-1)', fontWeight:600 }}>
                      {u.username}{isSelf && <span style={{ color:'var(--text-4)', fontWeight:400 }}> (you)</span>}
                      <div><span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:999, background:`${info.color}1a`, color:info.color }}>{info.label}</span></div>
                    </td>
                    <td style={{ fontSize:12, color:'var(--text-3)' }}>{u.email || '—'}</td>
                    <td>
                      <select className="field-input" style={{ width:135 }} value={u.role} disabled={isSelf || (!isOwner && ['owner','superadmin'].includes(u.role))}
                        onChange={e => setRole(u, e.target.value)}>
                        <option value="editor">Editor</option>
                        <option value="admin">Admin</option>
                        <option value="superadmin" disabled={!isOwner}>Super Admin</option>
                        <option value="owner" disabled={!isOwner}>Owner</option>
                      </select>
                    </td>
                    <td>
                      <select className="field-input" style={{ width:160 }} value={u.accountKey || ''} disabled={isSelf}
                        onChange={e => setCompany(u, e.target.value)}>
                        <option value="">— none (Midwest) —</option>
                        {accounts.map(a => <option key={a.accountKey} value={a.accountKey}>{a.name}</option>)}
                      </select>
                    </td>
                    <td style={{ fontSize:12, color:'var(--text-3)' }}>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'Never'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── 4. Billing (Stripe-ready, dormant) ────────────────────────────────────────
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
  const { isOwner } = useAuth();
  return (
    <div>
      <div className="page-header">
        <h1>{isOwner ? 'Owner' : 'Super Admin'} Panel</h1>
        <p>Platform controls — companies, users & permissions, landing page, billing{!isOwner && ' · deletions require the Owner'}</p>
      </div>
      <CompaniesPanel />
      <PlatformUsersPanel />
      <SiteSettingsEditor />
      <BillingPanel />
    </div>
  );
}
