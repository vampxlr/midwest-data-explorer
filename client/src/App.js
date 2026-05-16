import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { Toaster, toast } from 'react-hot-toast';
import Dashboard from './pages/Dashboard';
import Analytics from './pages/Analytics';
import Heatmap from './pages/Heatmap';
import QueryExplorer from './pages/QueryExplorer';
import SchemaExplorer from './pages/SchemaExplorer';
import Registrations from './pages/Registrations';
import { api } from './api';
import './App.css';

export default function App() {
  const [health, setHealth] = useState(null);
  const [orgs, setOrgs] = useState([]);
  const [selectedOrg, setSelectedOrg] = useState(null);
  const [registrations, setRegistrations] = useState([]);
  const [selectedReg, setSelectedReg] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    init();
  }, []);

  async function init() {
    setLoading(true);
    try {
      const h = await api.health();
      setHealth(h.data);

      const o = await api.organizations();
      const orgList = o.data?.data?.organizations?.results || [];
      setOrgs(orgList);
      if (orgList.length > 0) {
        setSelectedOrg(orgList[0]);
        loadRegistrations(orgList[0].id);
      }
      toast.success('Connected to SportsEngine API');
    } catch (err) {
      toast.error('API connection failed: ' + (err.response?.data?.message || err.message));
    } finally {
      setLoading(false);
    }
  }

  async function loadRegistrations(orgId) {
    try {
      const r = await api.registrations(orgId);
      const regList = r.data?.data?.registrations?.results || [];
      setRegistrations(regList);
      if (regList.length > 0) setSelectedReg(regList[0]);
    } catch (err) {
      toast.error('Failed to load registrations');
    }
  }

  function handleOrgChange(e) {
    const org = orgs.find(o => String(o.id) === e.target.value);
    setSelectedOrg(org);
    setSelectedReg(null);
    loadRegistrations(org.id);
  }

  function handleRegChange(e) {
    const reg = registrations.find(r => String(r.id) === e.target.value);
    setSelectedReg(reg);
  }

  async function clearCache() {
    await api.clearCache();
    toast.success('Cache cleared — data will refresh');
    init();
  }

  const ctx = { health, orgs, selectedOrg, registrations, selectedReg };

  return (
    <BrowserRouter>
      <Toaster position="top-right" toastOptions={{ style: { background: '#1e2235', color: '#e2e8f0', border: '1px solid #3d4660' } }} />
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
            <NavLink to="/" end className={({isActive}) => isActive ? 'nav-item active' : 'nav-item'}>
              <span>📊</span> Dashboard
            </NavLink>
            <NavLink to="/analytics" className={({isActive}) => isActive ? 'nav-item active' : 'nav-item'}>
              <span>📈</span> Analytics
            </NavLink>
            <NavLink to="/heatmap" className={({isActive}) => isActive ? 'nav-item active' : 'nav-item'}>
              <span>🗺️</span> Heatmap
            </NavLink>
            <NavLink to="/query" className={({isActive}) => isActive ? 'nav-item active' : 'nav-item'}>
              <span>🔍</span> Query Explorer
            </NavLink>
            <NavLink to="/registrations" className={({isActive}) => isActive ? 'nav-item active' : 'nav-item'}>
              <span>📝</span> Registrations
            </NavLink>
            <NavLink to="/schema" className={({isActive}) => isActive ? 'nav-item active' : 'nav-item'}>
              <span>📋</span> Schema
            </NavLink>
          </div>

          <div className="nav-section">
            <div className="nav-label">Filters</div>
            <div className="filter-group">
              <label>Organization</label>
              <select onChange={handleOrgChange} value={selectedOrg?.id || ''} disabled={loading}>
                {orgs.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </div>
            <div className="filter-group">
              <label>Registration / Event</label>
              <select onChange={handleRegChange} value={selectedReg?.id || ''} disabled={!registrations.length}>
                {registrations.length === 0 && <option>No registrations</option>}
                {registrations.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
            <button className="btn-secondary" onClick={clearCache}>↺ Refresh Cache</button>
          </div>

          <div className="sidebar-footer">
            {health ? (
              <div className="status-ok">● API Connected</div>
            ) : (
              <div className="status-err">● Disconnected</div>
            )}
          </div>
        </nav>

        <main className="main-content">
          {loading ? (
            <div className="loading-screen">
              <div className="spinner" />
              <p>Connecting to SportsEngine API...</p>
            </div>
          ) : (
            <Routes>
              <Route path="/" element={<Dashboard ctx={ctx} />} />
              <Route path="/analytics" element={<Analytics ctx={ctx} />} />
              <Route path="/heatmap" element={<Heatmap ctx={ctx} />} />
              <Route path="/registrations" element={<Registrations ctx={ctx} />} />
              <Route path="/query" element={<QueryExplorer />} />
              <Route path="/schema" element={<SchemaExplorer />} />
            </Routes>
          )}
        </main>
      </div>
    </BrowserRouter>
  );
}
