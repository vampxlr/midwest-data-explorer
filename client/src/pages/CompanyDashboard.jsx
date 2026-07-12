import React, { useEffect, useState } from 'react';
import { api } from '../api.jsx';
import { useAuth } from '../AuthContext.jsx';
import { toast } from 'react-hot-toast';
import PasswordField from '../components/PasswordField.jsx';
import BillingCard from '../components/BillingCard.jsx';
import PromoPanel from '../components/PromoPanel.jsx';
import OnboardingFlow from '../components/OnboardingFlow.jsx';
import TrackingCard from '../components/TrackingCard.jsx';

export default function CompanyDashboard() {
  const { user, logout, isAdmin } = useAuth();
  const [data, setData] = useState(null);       // { account, orgs }
  const [users, setUsers] = useState([]);
  const [adding, setAdding] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [form, setForm] = useState({ username:'', password:'', email:'', role:'editor' });

  async function load() {
    try {
      const [me, us] = await Promise.all([api.companyMe(), api.companyUsers()]);
      setData(me.data);
      setUsers(us.data.users || []);
    } catch (err) { toast.error(err.response?.data?.error || err.message); }
  }
  useEffect(() => { load(); }, []);

  async function addUser(e) {
    e.preventDefault();
    try {
      await api.companyCreateUser({ ...form, email: form.email || undefined });
      toast.success(`Created "${form.username}"`);
      setForm({ username:'', password:'', email:'', role:'editor' });
      setAdding(false);
      load();
    } catch (err) { toast.error(err.response?.data?.error || err.message); }
  }

  return (
    <div style={{ minHeight:'100vh', background:'var(--bg-base)' }}>
      <header style={{
        display:'flex', alignItems:'center', justifyContent:'space-between', gap:12,
        padding:'14px clamp(16px, 4vw, 40px)', borderBottom:'1px solid var(--border-sub)',
        background:'var(--bg-card)', position:'sticky', top:0, zIndex:100,
      }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <span style={{ fontSize:22 }}>🏢</span>
          <div>
            <div style={{ fontSize:14, fontWeight:800, color:'var(--accent-light)', letterSpacing:'-0.3px' }}>
              {data?.account?.name || 'Company'}
            </div>
            <div style={{ fontSize:10, color:'var(--text-4)', textTransform:'uppercase', letterSpacing:'0.3px' }}>Company Dashboard</div>
          </div>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <span style={{ fontSize:12, color:'var(--text-3)' }}>{user?.username}</span>
          <button className="btn-secondary" style={{ width:'auto', margin:0, padding:'6px 12px' }} onClick={logout}>Sign out</button>
        </div>
      </header>

      <main style={{ maxWidth:1000, margin:'0 auto', padding:'28px clamp(14px, 3vw, 32px) 60px' }}>
        <BillingCard />
        {/* Organizations */}
        <div className="card">
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:8 }}>
            <h2 style={{ margin:0 }}>Your Organizations</h2>
            {isAdmin && data?.orgs?.length > 0 && !connecting && (
              <button className="btn-secondary" style={{ width:'auto', margin:0 }} onClick={() => setConnecting(true)}>
                + Connect another organization
              </button>
            )}
          </div>
          {!data ? <div className="no-data">Loading…</div> : (data.orgs.length === 0 || connecting) ? (
            <div style={{ marginTop:14 }}>
              <OnboardingFlow
                videoUrl={data.onboardingVideoUrl}
                firstOrg={data.orgs.length === 0}
                onConnected={() => { setConnecting(false); load(); }}
                onCancel={data.orgs.length > 0 ? () => setConnecting(false) : null}
              />
            </div>
          ) : (
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(280px, 1fr))', gap:12 }}>
              {data.orgs.map(o => (
                <div key={o.orgKey} style={{ background:'var(--surface-2)', border:'1px solid var(--line)', borderRadius:12, padding:'16px 18px' }}>
                  <div style={{ fontSize:15, fontWeight:700, color:'var(--text-1)' }}>🏀 {o.name}</div>
                  <div style={{ fontSize:12, color:'var(--text-3)', margin:'4px 0 12px' }}>
                    {o.verified ? '🔒 SportsEngine connected' : 'Awaiting SportsEngine setup'}
                  </div>
                  <button className="btn-primary" style={{ width:'100%' }}
                    onClick={() => {
                      sessionStorage.setItem('mw3-active-org', JSON.stringify({ orgKey: o.orgKey, name: o.name }));
                      window.location.href = '/';
                    }}>
                    Enter Data Explorer →
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Company users */}
        <div className="card">
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
            <h2 style={{ margin:0 }}>Team Members</h2>
            {isAdmin && !adding && <button className="btn-primary" onClick={() => setAdding(true)}>+ Add member</button>}
          </div>
          {adding && (
            <form onSubmit={addUser} style={{ display:'flex', gap:8, flexWrap:'wrap', alignItems:'flex-end', marginBottom:14 }}>
              <input className="field-input" placeholder="Username" required value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} />
              <PasswordField placeholder="Password (8+ chars)" required value={form.password} onChange={v => setForm(f => ({ ...f, password: v }))} />
              <input className="field-input" type="email" placeholder="Google email (optional)" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
              <select className="field-input" value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
                <option value="editor">Editor</option>
                <option value="admin">Admin</option>
              </select>
              <button type="submit" className="btn-primary">Create</button>
              <button type="button" className="btn-chart" onClick={() => setAdding(false)}>Cancel</button>
            </form>
          )}
          {users.length === 0 ? <div className="no-data">No team members yet.</div> : (
            <table className="data-table">
              <thead><tr><th>User</th><th>Role</th><th>Email</th><th>Last login</th></tr></thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id}>
                    <td style={{ color:'var(--text-1)', fontWeight:600 }}>{u.username}{u.id === user?.id && <span style={{ color:'var(--text-4)', fontWeight:400 }}> (you)</span>}</td>
                    <td style={{ textTransform:'capitalize' }}>{u.role}</td>
                    <td style={{ fontSize:12, color:'var(--text-3)' }}>{u.email || '—'}</td>
                    <td style={{ fontSize:12, color:'var(--text-3)' }}>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'Never'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Org-specific tracking: their pixel, their CAPI token, their webhook */}
        {isAdmin && <TrackingCard />}

        {/* auto1labs service offers, matched to org size */}
        <PromoPanel />
      </main>
    </div>
  );
}
