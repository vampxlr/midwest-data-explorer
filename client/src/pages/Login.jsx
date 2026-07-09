import React, { useState } from 'react';
import { useAuth } from '../AuthContext.jsx';

export default function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error,    setError]    = useState(() => {
    // Google callback reports failures via ?gerror=
    const m = new URLSearchParams(window.location.search).get('gerror');
    if (m) history.replaceState(null, '', window.location.pathname);
    return m || '';
  });
  const [busy,     setBusy]     = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(username.trim(), password);
    } catch (err) {
      const d = err.response?.data;
      const msg = typeof d?.error === 'string' ? d.error
                : typeof d?.message === 'string' ? d.message
                : 'Login failed';
      setError(msg);
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

        <div style={{ display:'flex', alignItems:'center', gap:10, margin:'16px 0 12px' }}>
          <div style={{ flex:1, height:1, background:'var(--border)' }} />
          <span style={{ fontSize:11, color:'var(--text-4)' }}>or</span>
          <div style={{ flex:1, height:1, background:'var(--border)' }} />
        </div>

        <button
          type="button"
          onClick={() => { window.location.href = '/api/auth/google'; }}
          style={{
            width:'100%', display:'flex', alignItems:'center', justifyContent:'center', gap:10,
            padding:'9px 16px', borderRadius:'var(--radius-sm)', cursor:'pointer',
            background:'var(--bg-input)', border:'1px solid var(--border)',
            color:'var(--text-1)', fontSize:13, fontWeight:600,
          }}>
          <svg width="17" height="17" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
            <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
            <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
            <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
          </svg>
          Continue with Google
        </button>
      </form>
    </div>
  );
}
