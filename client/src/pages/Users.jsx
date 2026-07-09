import React, { useEffect, useState } from 'react';
import { toast } from 'react-hot-toast';
import { api } from '../api.jsx';
import { useAuth } from '../AuthContext.jsx';
import Panel from '../components/Panel.jsx';

const ROLE_INFO = {
  superadmin: { label: 'Super Admin', desc: 'Platform owner — everything Admin can do, plus the Super Admin panel (landing page, pricing, organizations, billing)', color: '#a855f7' },
  admin:  { label: 'Admin',  desc: 'Full access — including purge/delete and user management', color: '#ef4444' },
  editor: { label: 'Editor', desc: 'Can run data refresh/aggregation/exports — cannot purge or manage users', color: '#3b82f6' },
};

function RoleBadge({ role }) {
  const info = ROLE_INFO[role] || { label: role, color: 'var(--text-3)' };
  return (
    <span style={{
      fontSize:11, fontWeight:700, padding:'3px 9px', borderRadius:999,
      background:`${info.color}1a`, color:info.color, textTransform:'capitalize',
    }}>
      {info.label}
    </span>
  );
}

function CreateUserForm({ onCreated }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email,    setEmail]    = useState('');
  const [role,     setRole]     = useState('editor');
  const [busy,     setBusy]     = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.createUser({ username: username.trim(), password, role, email: email.trim() || undefined });
      toast.success(`Created account "${username.trim()}"`);
      setUsername(''); setPassword(''); setEmail(''); setRole('editor');
      onCreated();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to create account');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card" style={{ marginBottom:20 }}>
      <h3>Add account</h3>
      <div style={{ display:'flex', gap:14, flexWrap:'wrap', alignItems:'flex-end' }}>
        <div>
          <label className="field-label" htmlFor="new-username">Username</label>
          <input id="new-username" className="field-input" style={{ width:180 }}
                 value={username} onChange={e=>setUsername(e.target.value)} required />
        </div>
        <div>
          <label className="field-label" htmlFor="new-password">Password</label>
          <input id="new-password" type="password" className="field-input" style={{ width:180 }}
                 value={password} onChange={e=>setPassword(e.target.value)}
                 minLength={8} required />
        </div>
        <div>
          <label className="field-label" htmlFor="new-email">Google email (optional)</label>
          <input id="new-email" type="email" className="field-input" style={{ width:210 }}
                 placeholder="enables Google sign-in"
                 value={email} onChange={e=>setEmail(e.target.value)} />
        </div>
        <div>
          <label className="field-label" htmlFor="new-role">Role</label>
          <select id="new-role" className="field-input" style={{ width:150 }}
                  value={role} onChange={e=>setRole(e.target.value)}>
            <option value="editor">Editor</option>
            <option value="admin">Admin</option>
            <option value="superadmin">Super Admin</option>
          </select>
        </div>
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Creating…' : '+ Create account'}
        </button>
      </div>
      <div style={{ marginTop:10, fontSize:11, color:'var(--text-3)' }}>
        Password must be at least 8 characters. {ROLE_INFO[role].desc}
      </div>
    </form>
  );
}

function UserRow({ u, isSelf, onChanged }) {
  const [editingPw, setEditingPw] = useState(false);
  const [password,  setPassword]  = useState('');
  const [email,     setEmail]     = useState(u.email || '');
  const [editingEmail, setEditingEmail] = useState(false);
  const [busy,      setBusy]      = useState(false);

  async function saveEmail(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.updateUser(u.id, { email: email.trim() });
      toast.success(`Email ${email.trim() ? 'set' : 'cleared'} for "${u.username}"`);
      setEditingEmail(false);
      onChanged();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update email');
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(role) {
    if (role === u.role) return;
    setBusy(true);
    try {
      await api.updateUser(u.id, { role });
      toast.success(`Updated role for "${u.username}" — they must sign out and back in for it to apply`);
      onChanged();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update role');
    } finally {
      setBusy(false);
    }
  }

  async function savePassword(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.updateUser(u.id, { password });
      toast.success(`Password updated for "${u.username}"`);
      setPassword('');
      setEditingPw(false);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update password');
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete account "${u.username}"? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await api.deleteUser(u.id);
      toast.success(`Deleted account "${u.username}"`);
      onChanged();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to delete account');
      setBusy(false);
    }
  }

  return (
    <tr>
      <td style={{ fontWeight:600 }}>{u.username}{isSelf && <span style={{ color:'var(--text-3)', fontWeight:400 }}> (you)</span>}</td>
      <td>
        <select className="field-input" style={{ width:135 }} value={u.role} disabled={busy || isSelf}
                onChange={e => changeRole(e.target.value)}>
          <option value="editor">Editor</option>
          <option value="admin">Admin</option>
          <option value="superadmin">Super Admin</option>
        </select>
      </td>
      <td><RoleBadge role={u.role} /></td>
      <td>
        {editingEmail ? (
          <form onSubmit={saveEmail} style={{ display:'flex', gap:6 }}>
            <input type="email" className="field-input" style={{ width:190 }}
                   placeholder="google email" value={email}
                   onChange={e=>setEmail(e.target.value)} autoFocus />
            <button type="submit" className="btn-action-green" disabled={busy}>Save</button>
            <button type="button" className="btn-secondary" style={{ width:'auto', margin:0 }}
                    onClick={()=>{ setEditingEmail(false); setEmail(u.email || ''); }}>✕</button>
          </form>
        ) : (
          <button onClick={()=>setEditingEmail(true)} disabled={busy}
            title="Google email — enables Sign in with Google for this account"
            style={{ background:'none', border:'none', cursor:'pointer', fontSize:12, padding:0,
              color: u.email ? 'var(--text-2)' : 'var(--text-4)', textDecoration:'underline dotted' }}>
            {u.email || '+ add email'}
          </button>
        )}
      </td>
      <td style={{ fontSize:12, color:'var(--text-3)' }}>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'Never'}</td>
      <td style={{ fontSize:12, color:'var(--text-3)' }}>{new Date(u.createdAt).toLocaleDateString()}</td>
      <td>
        {editingPw ? (
          <form onSubmit={savePassword} style={{ display:'flex', gap:6 }}>
            <input type="password" className="field-input" style={{ width:140 }}
                   placeholder="New password" value={password}
                   onChange={e=>setPassword(e.target.value)} minLength={8} required autoFocus />
            <button type="submit" className="btn-action-green" disabled={busy}>Save</button>
            <button type="button" className="btn-secondary" style={{ width:'auto', margin:0 }}
                    onClick={()=>{ setEditingPw(false); setPassword(''); }}>Cancel</button>
          </form>
        ) : (
          <button className="btn-secondary" style={{ width:'auto', margin:0 }} disabled={busy}
                  onClick={()=>setEditingPw(true)}>
            Reset password
          </button>
        )}
      </td>
      <td>
        <button className="btn-action-orange" disabled={busy || isSelf} onClick={handleDelete}
                title={isSelf ? 'You cannot delete your own account' : 'Delete account'}>
          Delete
        </button>
      </td>
    </tr>
  );
}

export default function Users() {
  const { user: currentUser } = useAuth();
  const [users,   setUsers]   = useState([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const res = await api.listUsers();
      setUsers(res.data?.users || []);
    } catch (err) {
      toast.error('Failed to load users: ' + (err.response?.data?.error || err.message));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  return (
    <div>
      <h2 style={{ marginBottom:4 }}>User Management</h2>
      <p style={{ color:'var(--text-3)', fontSize:13, marginTop:0, marginBottom:20 }}>
        Manage who can sign in and what they're allowed to do.
        <strong> Admins</strong> have full access including purge/delete and user management.
        <strong> Editors</strong> can run data refresh, aggregation, and exports, but cannot purge data or manage users.
      </p>

      <CreateUserForm onCreated={load} />

      <Panel id="users-panel-1">
        <h3>Accounts ({users.length})</h3>
        {loading ? (
          <div style={{ color:'var(--text-3)', fontSize:13 }}>Loading…</div>
        ) : (
          <div style={{ overflowX:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
              <thead>
                <tr style={{ textAlign:'left', color:'var(--text-3)', fontSize:11, textTransform:'uppercase', letterSpacing:'0.5px' }}>
                  <th style={{ padding:'8px 10px' }}>Username</th>
                  <th style={{ padding:'8px 10px' }}>Change role</th>
                  <th style={{ padding:'8px 10px' }}>Role</th>
                  <th style={{ padding:'8px 10px' }}>Google email</th>
                  <th style={{ padding:'8px 10px' }}>Last login</th>
                  <th style={{ padding:'8px 10px' }}>Created</th>
                  <th style={{ padding:'8px 10px' }}>Password</th>
                  <th style={{ padding:'8px 10px' }}></th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <UserRow key={u.id} u={u} isSelf={u.id === currentUser?.id} onChanged={load} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
