import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { Toaster, toast } from 'react-hot-toast';
import Dashboard    from './pages/Dashboard.jsx';
import Analytics    from './pages/Analytics.jsx';
import QueryExplorer from './pages/QueryExplorer.jsx';
import SchemaExplorer from './pages/SchemaExplorer.jsx';
import Registrations from './pages/Registrations.jsx';
import Guide        from './pages/Guide.jsx';
import Reports      from './pages/Reports.jsx';
import Audiences   from './pages/Audiences.jsx';
import BootTerminal    from './components/BootTerminal.jsx';
import DataManagement  from './pages/DataManagement.jsx';
import Login        from './pages/Login.jsx';
import Users        from './pages/Users.jsx';
import Landing      from './pages/Landing.jsx';
import SuperAdmin   from './pages/SuperAdmin.jsx';
import CompanyDashboard from './pages/CompanyDashboard.jsx';
import { api }      from './api.jsx';
import { useAuth }  from './AuthContext.jsx';
import SearchableSelect from './components/SearchableSelect.jsx';
import { isDemoMode, setDemoMode, maskDeep } from './demoMask.js';
import './App.css';

const ORG_ID = '8008';

// Super admin "Enter organization" context — set by the Super Admin panel.
// Until Phase B (per-org data), every org opens the default dataset.
export function getActiveOrg() {
  try { return JSON.parse(sessionStorage.getItem('mw3-active-org') || 'null'); } catch { return null; }
}
export function exitActiveOrg() {
  sessionStorage.removeItem('mw3-active-org');
  window.location.href = '/superadmin';
}

function getInitialTheme() {
  const saved = localStorage.getItem('theme');
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export default function App() {
  const { user, loading: authLoading, logout, isSuperAdmin, isOwner } = useAuth();
  // Logged-out visitors see the marketing landing page first; "Sign in" flips
  // to the login form. OAuth round-trips (?gerror / #gtoken) skip the landing.
  const [showLogin, setShowLogin] = useState(() =>
    window.location.search.includes('gerror=') || window.location.hash.includes('gtoken='));
  const [connected,     setConnected]     = useState(false);
  const [recentRegs,    setRecentRegs]    = useState([]);
  const [selectedReg,   setSelectedReg]   = useState(null);
  const [booting,       setBooting]       = useState(true);
  const [refreshToken,  setRefreshToken]  = useState(0);
  const [moreOpen,      setMoreOpen]      = useState(false);
  const [theme,         setTheme]         = useState(getInitialTheme);
  const [navOpen,       setNavOpen]       = useState(false);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  // Cursor-tracking spotlight glow for ALL panels: one delegated listener
  // writes --mx/--my onto the hovered card so the CSS border ring + interior
  // wash (see .card::before/::after in App.css) follow the mouse. Writing
  // style props directly avoids any React re-renders on mousemove.
  useEffect(() => {
    function onMove(e) {
      const el = e.target?.closest?.('.card, .stat-card, .glow-card');
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${e.clientX - r.left}px`);
      el.style.setProperty('--my', `${e.clientY - r.top}px`);
    }
    document.addEventListener('mousemove', onMove, { passive: true });
    return () => document.removeEventListener('mousemove', onMove);
  }, []);

  function toggleTheme() {
    setTheme(t => t === 'dark' ? 'light' : 'dark');
  }

  function handleBootReady(data) {
    setConnected(true);
    // Boot arrives over SSE (not axios), so demo-mode masking applies here.
    const payload = isDemoMode() ? maskDeep(data) : data;
    const list = payload?.recentEvents || [];
    setRecentRegs(list);
    if (list.length > 0) setSelectedReg(list[0]);
    setBooting(false);
  }

  function toggleDemoMode() {
    setDemoMode(!isDemoMode());
    // Data already on screen was fetched unmasked (or masked) — reload so
    // every request replays through the masking interceptor.
    window.location.reload();
  }

  function handleRegChange(val) {
    const reg = recentRegs.find(r => String(r.id) === String(val));
    if (reg) setSelectedReg(reg);
  }

  async function onAggComplete() {
    try { await api.clearCache(); } catch {}
    setRefreshToken(t => t + 1);
  }

  async function refreshData() {
    try {
      await api.clearCache();
      const res = await api.recentRegistrations(ORG_ID);
      const list = res.data?.registrations || [];
      setRecentRegs(list);
      if (list.length > 0 && !selectedReg) setSelectedReg(list[0]);
      toast.success(`Refreshed — ${list.length} total events`);
    } catch (err) {
      toast.error('Refresh failed: ' + err.message);
    }
  }

  const ctx = { orgId: ORG_ID, recentRegs, selectedReg, setSelectedReg, refreshToken, onAggComplete };

  if (authLoading) {
    return <div style={{ minHeight:'100vh', background:'var(--bg-base)' }} />;
  }
  // Superadmin can preview the public landing page while logged in
  if (window.location.search.includes('landing-preview=1')) {
    return <Landing onSignIn={() => { window.location.href = '/'; }} />;
  }

  if (!user) {
    return showLogin
      ? <Login />
      : <Landing onSignIn={() => setShowLogin(true)} />;
  }

  // ── Company dashboard — customer users linked to a company account ───────
  // (No SportsEngine boot; entering one of their orgs starts it.)
  if (!isSuperAdmin && user.accountKey && !getActiveOrg()) {
    return (
      <>
        <Toaster position="top-right" toastOptions={{
          style: { background:'var(--bg-card)', color:'var(--text-1)', border:'1px solid var(--border)' }
        }} />
        <CompanyDashboard />
      </>
    );
  }

  // ── Super admin standalone dashboard ─────────────────────────────────────
  // A superadmin who hasn't entered an organization gets a completely
  // separate shell: no SportsEngine boot sequence, no org sidebar. The boot
  // log only runs after clicking "Enter Data Explorer →" on an org.
  if (isSuperAdmin && !getActiveOrg()) {
    return (
      <>
        <Toaster position="top-right" toastOptions={{
          style: { background:'var(--bg-card)', color:'var(--text-1)', border:'1px solid var(--border)' }
        }} />
        <div style={{ minHeight:'100vh', background:'var(--bg-base)' }}>
          <header style={{
            display:'flex', alignItems:'center', justifyContent:'space-between', gap:12,
            padding:'14px clamp(16px, 4vw, 40px)', borderBottom:'1px solid var(--border-sub)',
            background:'var(--bg-card)', position:'sticky', top:0, zIndex:100,
          }}>
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              <span style={{ fontSize:22 }}>👑</span>
              <div>
                <div style={{ fontSize:14, fontWeight:800, color: isOwner ? '#f59e0b' : '#a855f7', letterSpacing:'-0.3px' }}>
                  {isOwner ? 'Owner' : 'Super Admin'}
                </div>
                <div style={{ fontSize:10, color:'var(--text-4)', textTransform:'uppercase', letterSpacing:'0.3px' }}>Platform Control</div>
              </div>
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              <button className="theme-toggle" onClick={toggleTheme} title="Switch theme">
                <span>{theme === 'dark' ? '🌙' : '☀️'}</span>
              </button>
              <span style={{ fontSize:12, color:'var(--text-3)' }}>{user.username}</span>
              <button className="btn-secondary" style={{ width:'auto', margin:0, padding:'6px 12px' }} onClick={logout}>
                Sign out
              </button>
            </div>
          </header>
          <main style={{ maxWidth:1100, margin:'0 auto', padding:'28px clamp(14px, 3vw, 32px) 60px' }}>
            <SuperAdmin />
          </main>
        </div>
      </>
    );
  }

  return (
    <BrowserRouter>
      <Toaster position="top-right" toastOptions={{
        style: { background:'var(--bg-card)', color:'var(--text-1)', border:'1px solid var(--border)' }
      }} />

      {/* Full-screen boot terminal — shown until SSE says "ready" */}
      {booting && (
        <BootTerminal orgId={ORG_ID} onReady={handleBootReady} />
      )}

      {!booting && (
        <div className="app">
          <button className="sidebar-toggle" onClick={()=>setNavOpen(o=>!o)} aria-label="Toggle navigation">
            {navOpen ? '✕' : '☰'}
          </button>
          <div className={`sidebar-scrim${navOpen ? ' show' : ''}`} onClick={()=>setNavOpen(false)} />

          <nav className={`sidebar${navOpen ? ' open' : ''}`}>
            <div className="logo">
              <span className="logo-icon">🏀</span>
              <div>
                <div className="logo-title">{isDemoMode() ? 'Demo Org' : 'Midwest 3on3'}</div>
                <div className="logo-sub">Data Explorer</div>
              </div>
              <button className="theme-toggle" onClick={toggleTheme} title="Switch theme">
                <span>{theme === 'dark' ? '🌙' : '☀️'}</span>
                <span>{theme === 'dark' ? 'Dark' : 'Light'}</span>
              </button>
            </div>

            <div className="nav-section">
              <div className="nav-label">Navigation</div>
              {isSuperAdmin && (
                <button onClick={exitActiveOrg} className="nav-item"
                  style={{ color:'#a855f7', width:'100%', background:'none', border:'none', cursor:'pointer', font:'inherit', textAlign:'left' }}>
                  <span>👑</span> {isOwner ? 'Owner Panel' : 'Super Admin Panel'}
                </button>
              )}
              {!isSuperAdmin && user.accountKey && (
                <button onClick={() => { sessionStorage.removeItem('mw3-active-org'); window.location.href = '/'; }} className="nav-item"
                  style={{ color:'var(--accent-light)', width:'100%', background:'none', border:'none', cursor:'pointer', font:'inherit', textAlign:'left' }}>
                  <span>🏢</span> Company Dashboard
                </button>
              )}
              <NavLink to="/"           end onClick={()=>setNavOpen(false)} className={({isActive})=>isActive?'nav-item active':'nav-item'}><span>📊</span> Dashboard</NavLink>
              <NavLink to="/reports"       onClick={()=>setNavOpen(false)} className={({isActive})=>isActive?'nav-item active':'nav-item'}><span>📅</span> Reports</NavLink>
              <NavLink to="/audiences"     onClick={()=>setNavOpen(false)} className={({isActive})=>isActive?'nav-item active':'nav-item'}><span>🎯</span> FB Audiences</NavLink>
            </div>

            <div className="nav-section">
              <button className="nav-label nav-more-toggle" onClick={()=>setMoreOpen(o=>!o)}>
                <span>More</span>
                <span style={{ transform: moreOpen ? 'rotate(90deg)' : 'none', transition:'transform 0.15s', display:'inline-block' }}>›</span>
              </button>
              {moreOpen && (
                <>
                  <NavLink to="/analytics"     onClick={()=>setNavOpen(false)} className={({isActive})=>isActive?'nav-item active':'nav-item'}><span>📈</span> Analytics</NavLink>
                  <NavLink to="/registrations" onClick={()=>setNavOpen(false)} className={({isActive})=>isActive?'nav-item active':'nav-item'}><span>📝</span> All Events</NavLink>
                  <NavLink to="/query"         onClick={()=>setNavOpen(false)} className={({isActive})=>isActive?'nav-item active':'nav-item'}><span>🔍</span> Query Explorer</NavLink>
                  <NavLink to="/schema"        onClick={()=>setNavOpen(false)} className={({isActive})=>isActive?'nav-item active':'nav-item'}><span>📋</span> Schema</NavLink>
                  <NavLink to="/data"          onClick={()=>setNavOpen(false)} className={({isActive})=>isActive?'nav-item active':'nav-item'}><span>🗄️</span> Data Mgmt</NavLink>
                  {(user.role === 'admin' || isSuperAdmin) && (
                    <NavLink to="/users"       onClick={()=>setNavOpen(false)} className={({isActive})=>isActive?'nav-item active':'nav-item'}><span>👤</span> Users</NavLink>
                  )}
                  <NavLink to="/guide"         onClick={()=>setNavOpen(false)} className={({isActive})=>isActive?'nav-item active':'nav-item'}><span>📖</span> Guide</NavLink>
                </>
              )}
            </div>

            <div className="nav-section">
              <div className="nav-label" style={{ display:'flex', justifyContent:'space-between' }}>
                <span>All Events</span>
                <span style={{ color:'var(--accent)', fontSize:10 }}>{recentRegs.length} events</span>
              </div>
              <div className="filter-group">
                <label>Event / Registration</label>
                <SearchableSelect
                  value={selectedReg?.id || ''}
                  onChange={handleRegChange}
                  options={recentRegs.map(r => ({ value: String(r.id), label: r.name }))}
                  placeholder="No events found"
                  disabled={!recentRegs.length}
                />
              </div>
              <button className="btn-secondary" onClick={refreshData}>↺ Refresh All</button>
            </div>

            <div className="sidebar-footer">
              {connected
                ? <div className="status-ok">● Connected · Org {isDemoMode() ? '****' : ORG_ID}</div>
                : <div className="status-err">● Disconnected</div>}
              {(user.role === 'admin' || isSuperAdmin) && (
                <button
                  onClick={toggleDemoMode}
                  title="Demo/stream mode masks org, league, and contact details for screen recording"
                  style={{
                    marginTop:8, width:'100%', padding:'7px 10px', borderRadius:8,
                    fontSize:12, fontWeight:700, cursor:'pointer',
                    border: isDemoMode() ? '1px solid rgba(249,115,22,0.5)' : '1px solid var(--border)',
                    background: isDemoMode() ? 'rgba(249,115,22,0.12)' : 'var(--bg-hover)',
                    color: isDemoMode() ? 'var(--accent-2)' : 'var(--text-3)',
                  }}>
                  {isDemoMode() ? '🎥 Demo Mode ON — click to exit' : '🎥 Demo / Stream Mode'}
                </button>
              )}
              <div style={{ fontSize:11, color:'#334155', marginTop:3 }}>
                All registrations / All time
              </div>
              <div style={{
                marginTop:10, paddingTop:10, borderTop:'1px solid var(--border)',
                display:'flex', alignItems:'center', justifyContent:'space-between', gap:8,
              }}>
                <div style={{ overflow:'hidden' }}>
                  <div style={{ fontSize:12, fontWeight:600, color:'var(--text-1)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
                    {user.username}
                  </div>
                  <div style={{ fontSize:10, color:'var(--text-3)', textTransform:'capitalize' }}>
                    {user.role}
                  </div>
                </div>
                <button
                  className="btn-secondary"
                  style={{ width:'auto', margin:0, padding:'6px 10px', whiteSpace:'nowrap' }}
                  onClick={logout}
                  title="Sign out"
                >
                  Sign out
                </button>
              </div>
            </div>
          </nav>

          <main className="main-content">
            <Routes>
              <Route path="/"              element={<Dashboard     ctx={ctx} />} />
              <Route path="/analytics"     element={<Analytics     ctx={ctx} />} />
              <Route path="/reports"       element={<Reports       ctx={ctx} />} />
              <Route path="/audiences"     element={<Audiences     ctx={ctx} />} />
              <Route path="/registrations" element={<Registrations ctx={ctx} />} />
              <Route path="/query"         element={<QueryExplorer />} />
              <Route path="/schema"        element={<SchemaExplorer />} />
              <Route path="/data"          element={<DataManagement ctx={ctx} />} />
              {(user.role === 'admin' || isSuperAdmin) && <Route path="/users" element={<Users />} />}
              <Route path="/guide"         element={<Guide />} />
            </Routes>
          </main>
        </div>
      )}
    </BrowserRouter>
  );
}
