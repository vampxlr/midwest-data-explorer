import React, { useState } from 'react';
import { useAuth } from '../AuthContext.jsx';

export default function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error,    setError]    = useState('');
  const [busy,     setBusy]     = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(err.response?.data?.error || 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{
      minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center',
      background:'var(--bg-base)',
    }}>
      <form onSubmit={handleSubmit} className="card" style={{ width:340, padding:28 }}>
        <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:20 }}>
          <span style={{ fontSize:28 }}>🏀</span>
          <div>
            <div style={{ fontSize:16, fontWeight:700, color:'var(--text-1)' }}>Midwest 3on3</div>
            <div style={{ fontSize:12, color:'var(--text-3)' }}>Data Explorer — sign in</div>
          </div>
        </div>

        <label className="field-label" htmlFor="login-username">Username</label>
        <input
          id="login-username"
          className="field-input"
          style={{ width:'100%', marginBottom:14, boxSizing:'border-box' }}
          value={username}
          onChange={e => setUsername(e.target.value)}
          autoComplete="username"
          autoFocus
          required
        />

        <label className="field-label" htmlFor="login-password">Password</label>
        <input
          id="login-password"
          type="password"
          className="field-input"
          style={{ width:'100%', marginBottom:18, boxSizing:'border-box' }}
          value={password}
          onChange={e => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />

        {error && (
          <div style={{
            fontSize:12, color:'#ef4444', background:'rgba(239,68,68,0.1)',
            border:'1px solid rgba(239,68,68,0.3)', borderRadius:'var(--radius-sm)',
            padding:'8px 10px', marginBottom:14,
          }}>
            {error}
          </div>
        )}

        <button type="submit" className="btn-primary" style={{ width:'100%' }} disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
