import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { Toaster, toast } from 'react-hot-toast';
import Dashboard    from './pages/Dashboard.jsx';
import Analytics    from './pages/Analytics.jsx';
import Heatmap      from './pages/Heatmap.jsx';
import QueryExplorer from './pages/QueryExplorer.jsx';
import SchemaExplorer from './pages/SchemaExplorer.jsx';
import Registrations from './pages/Registrations.jsx';
import Guide        from './pages/Guide.jsx';
import Reports      from './pages/Reports.jsx';
import Audiences   from './pages/Audiences.jsx';
import BootTerminal    from './components/BootTerminal.jsx';
import DataManagement  from './pages/DataManagement.jsx';
import { api }      from './api.jsx';
import SearchableSelect from './components/SearchableSelect.jsx';
import './App.css';

const ORG_ID = '8008';

export default function App() {
  const [connected,     setConnected]     = useState(false);
  const [recentRegs,    setRecentRegs]    = useState([]);
  const [selectedReg,   setSelectedReg]   = useState(null);
  const [booting,       setBooting]       = useState(true);
  const [refreshToken,  setRefreshToken]  = useState(0);

  function handleBootReady(data) {
    setConnected(true);
    const list = data?.recentEvents || [];
    setRecentRegs(list);
    if (list.length > 0) setSelectedReg(list[0]);
    setBooting(false);
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

  return (
    <BrowserRouter>
      <Toaster position="top-right" toastOptions={{
        style: { background:'#1e2235', color:'#e2e8f0', border:'1px solid #3d4660' }
      }} />

      {/* Full-screen boot terminal — shown until SSE says "ready" */}
      {booting && (
        <BootTerminal orgId={ORG_ID} onReady={handleBootReady} />
      )}

      {!booting && (
        <div className="app">
          <nav className="sidebar">
            <div className="logo">
              <span className="logo-icon">🏀</span>
              <div>
                <div className="logo-title">Midwest 3on3</div>
                <div className="logo-sub">Data Explorer</div>
              </div>
            </div>

            <div className="nav-section">
              <div className="nav-label">Navigation</div>
              <NavLink to="/"           end className={({isActive})=>isActive?'nav-item active':'nav-item'}><span>📊</span> Dashboard</NavLink>
              <NavLink to="/analytics"     className={({isActive})=>isActive?'nav-item active':'nav-item'}><span>📈</span> Analytics</NavLink>
              <NavLink to="/heatmap"       className={({isActive})=>isActive?'nav-item active':'nav-item'}><span>🗺️</span> Heatmap</NavLink>
              <NavLink to="/reports"       className={({isActive})=>isActive?'nav-item active':'nav-item'}><span>📅</span> Reports</NavLink>
              <NavLink to="/audiences"     className={({isActive})=>isActive?'nav-item active':'nav-item'}><span>🎯</span> FB Audiences</NavLink>
              <NavLink to="/registrations" className={({isActive})=>isActive?'nav-item active':'nav-item'}><span>📝</span> All Events</NavLink>
              <NavLink to="/query"         className={({isActive})=>isActive?'nav-item active':'nav-item'}><span>🔍</span> Query Explorer</NavLink>
              <NavLink to="/schema"        className={({isActive})=>isActive?'nav-item active':'nav-item'}><span>📋</span> Schema</NavLink>
              <NavLink to="/data"          className={({isActive})=>isActive?'nav-item active':'nav-item'}><span>🗄️</span> Data Mgmt</NavLink>
              <NavLink to="/guide"         className={({isActive})=>isActive?'nav-item active':'nav-item'}><span>📖</span> Guide</NavLink>
            </div>

            <div className="nav-section">
              <div className="nav-label" style={{ display:'flex', justifyContent:'space-between' }}>
                <span>All Events</span>
                <span style={{ color:'#3b82f6', fontSize:10 }}>{recentRegs.length} events</span>
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
              <button className="btn-secondary" onClick={refreshData}>↺ ↺ Refresh All</button>
            </div>

            <div className="sidebar-footer">
              {connected
                ? <div className="status-ok">● Connected · Org {ORG_ID}</div>
                : <div className="status-err">● Disconnected</div>}
              <div style={{ fontSize:11, color:'#334155', marginTop:3 }}>
                All registrations / All time
              </div>
            </div>
          </nav>

          <main className="main-content">
            <Routes>
              <Route path="/"              element={<Dashboard     ctx={ctx} />} />
              <Route path="/analytics"     element={<Analytics     ctx={ctx} />} />
              <Route path="/heatmap"       element={<Heatmap       ctx={ctx} />} />
              <Route path="/reports"       element={<Reports       ctx={ctx} />} />
              <Route path="/audiences"     element={<Audiences     ctx={ctx} />} />
              <Route path="/registrations" element={<Registrations ctx={ctx} />} />
              <Route path="/query"         element={<QueryExplorer />} />
              <Route path="/schema"        element={<SchemaExplorer />} />
              <Route path="/data"          element={<DataManagement ctx={ctx} />} />
              <Route path="/guide"         element={<Guide />} />
            </Routes>
          </main>
        </div>
      )}
    </BrowserRouter>
  );
}
