import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { toast } from 'react-hot-toast';

export default function Dashboard({ ctx }) {
  const { health, orgs, selectedOrg, registrations, selectedReg } = ctx;
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (selectedReg?.id && selectedOrg?.id) fetchAnalytics(selectedReg.id, selectedOrg.id);
  }, [selectedReg, selectedOrg]);

  async function fetchAnalytics(regId, orgId) {
    setLoading(true);
    try {
      const res = await api.analyticsGradYear(regId, orgId);
      setAnalytics(res.data);
    } catch (err) {
      toast.error('Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }

  const topGradYear = analytics?.graduationYear?.[0];
  const topState = analytics?.state?.[0];
  const topCity = analytics?.city?.[0];

  return (
    <div>
      <div className="page-header">
        <h1>Dashboard</h1>
        <p>Overview of {selectedReg?.name || 'all registrations'}</p>
      </div>

      {/* Stat cards */}
      <div className="grid-4" style={{ marginBottom: 20 }}>
        <div className="stat-card">
          <div className="stat-label">Total Registrants</div>
          <div className="stat-value" style={{ color: '#60a5fa' }}>
            {loading ? '...' : (analytics?.total ?? '—')}
          </div>
          <div className="stat-sub">{selectedReg?.name || '—'}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Top Grad Year</div>
          <div className="stat-value" style={{ color: '#f97316' }}>
            {loading ? '...' : (topGradYear?.name ?? '—')}
          </div>
          <div className="stat-sub">{topGradYear ? `${topGradYear.count} registrants` : ''}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Top State</div>
          <div className="stat-value" style={{ color: '#22c55e', fontSize: 28 }}>
            {loading ? '...' : (topState?.name ?? '—')}
          </div>
          <div className="stat-sub">{topState ? `${topState.count} registrants` : ''}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Top City</div>
          <div className="stat-value" style={{ color: '#a855f7', fontSize: 22 }}>
            {loading ? '...' : (topCity?.name ?? '—')}
          </div>
          <div className="stat-sub">{topCity ? `${topCity.count} registrants` : ''}</div>
        </div>
      </div>

      <div className="grid-2">
        {/* Registrations list */}
        <div className="card">
          <h2>Events / Registrations</h2>
          {registrations.length === 0 ? (
            <div className="no-data">No registrations found for this organization.</div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>ID</th>
                  <th>Start</th>
                </tr>
              </thead>
              <tbody>
                {registrations.map(r => (
                  <tr key={r.id}>
                    <td style={{ color: '#e2e8f0' }}>{r.name}</td>
                    <td><span className="badge badge-blue">{r.id}</span></td>
                    <td>{r.startDate ? new Date(r.startDate).toLocaleDateString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Grad year quick table */}
        <div className="card">
          <h2>Graduation Year Breakdown</h2>
          {loading && <div className="no-data">Loading...</div>}
          {!loading && !analytics && <div className="no-data">Select a registration to load data.</div>}
          {analytics?.graduationYear?.length > 0 && (
            <table className="data-table">
              <thead>
                <tr><th>Grad Year</th><th>Count</th><th>%</th></tr>
              </thead>
              <tbody>
                {analytics.graduationYear.map(row => (
                  <tr key={row.name}>
                    <td style={{ color: '#e2e8f0', fontWeight: 600 }}>{row.name}</td>
                    <td><span className="badge badge-orange">{row.count}</span></td>
                    <td style={{ color: '#64748b' }}>
                      {analytics.total > 0 ? ((row.count / analytics.total) * 100).toFixed(1) : 0}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="grid-2">
        {/* Gender breakdown */}
        <div className="card">
          <h2>Gender Breakdown</h2>
          {analytics?.gender?.length > 0 ? (
            <table className="data-table">
              <thead><tr><th>Gender</th><th>Count</th><th>%</th></tr></thead>
              <tbody>
                {analytics.gender.map(row => (
                  <tr key={row.name}>
                    <td style={{ color: '#e2e8f0' }}>{row.name}</td>
                    <td><span className="badge badge-purple">{row.count}</span></td>
                    <td style={{ color: '#64748b' }}>
                      {analytics.total > 0 ? ((row.count / analytics.total) * 100).toFixed(1) : 0}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div className="no-data">{loading ? 'Loading...' : 'No data'}</div>}
        </div>

        {/* State breakdown */}
        <div className="card">
          <h2>Top States</h2>
          {analytics?.state?.length > 0 ? (
            <table className="data-table">
              <thead><tr><th>State</th><th>Count</th><th>%</th></tr></thead>
              <tbody>
                {analytics.state.slice(0, 15).map(row => (
                  <tr key={row.name}>
                    <td style={{ color: '#e2e8f0' }}>{row.name}</td>
                    <td><span className="badge badge-green">{row.count}</span></td>
                    <td style={{ color: '#64748b' }}>
                      {analytics.total > 0 ? ((row.count / analytics.total) * 100).toFixed(1) : 0}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div className="no-data">{loading ? 'Loading...' : 'No data'}</div>}
        </div>
      </div>

      {/* API info */}
      <div className="card">
        <h2>API Connection Info</h2>
        <table className="data-table">
          <tbody>
            <tr>
              <td style={{color:'#64748b'}}>Status</td>
              <td><span className="badge badge-green">Connected</span></td>
            </tr>
            <tr>
              <td style={{color:'#64748b'}}>Organizations</td>
              <td style={{color:'#e2e8f0'}}>{orgs.length}</td>
            </tr>
            <tr>
              <td style={{color:'#64748b'}}>Selected Org</td>
              <td style={{color:'#e2e8f0'}}>{selectedOrg?.name} (ID: {selectedOrg?.id})</td>
            </tr>
            <tr>
              <td style={{color:'#64748b'}}>Selected Registration</td>
              <td style={{color:'#e2e8f0'}}>{selectedReg?.name} (ID: {selectedReg?.id})</td>
            </tr>
            {health?.identity && (
              <tr>
                <td style={{color:'#64748b'}}>Identity</td>
                <td style={{color:'#e2e8f0'}}>{JSON.stringify(health.identity).slice(0, 80)}...</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
