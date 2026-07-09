import React, { createContext, useContext, useEffect, useState } from 'react';
import { api, getAuthToken, setAuthToken } from './api.jsx';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Google OAuth callback lands on /login#gtoken=<jwt> — adopt it as the
    // session token (hash fragment never reaches server logs).
    const m = window.location.hash.match(/gtoken=([^&]+)/);
    if (m) {
      setAuthToken(decodeURIComponent(m[1]));
      history.replaceState(null, '', window.location.pathname);
    }
    if (!getAuthToken()) { setLoading(false); return; }
    api.me()
      .then(res => setUser(res.data?.user || null))
      .catch(() => { setAuthToken(null); setUser(null); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const onExpired = () => setUser(null);
    window.addEventListener('mw3-auth-expired', onExpired);
    return () => window.removeEventListener('mw3-auth-expired', onExpired);
  }, []);

  async function login(username, password) {
    const res = await api.login(username, password);
    setAuthToken(res.data.token);
    setUser(res.data.user);
  }

  function logout() {
    setAuthToken(null);
    setUser(null);
  }

  const value = {
    user,
    loading,
    isAdmin: ['admin', 'superadmin', 'owner'].includes(user?.role),
    isSuperAdmin: ['superadmin', 'owner'].includes(user?.role), // platform-level access
    isOwner: user?.role === 'owner',
    login,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  return useContext(AuthContext);
}
