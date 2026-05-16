import React, { useEffect, useState } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  PieChart, Pie, Cell, ResponsiveContainer, LineChart, Line,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  AreaChart, Area,
} from 'recharts';
import { api } from '../api';
import { toast } from 'react-hot-toast';

const COLORS = ['#3b82f6','#f97316','#22c55e','#a855f7','#ec4899','#14b8a6','#eab308','#06b6d4','#f43f5e','#84cc16'];

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: '#1e2235', border: '1px solid #2a2d3e', borderRadius: 8, padding: '10px 14px' }}>
      <p style={{ color: '#94a3b8', fontSize: 12, marginBottom: 4 }}>{label}</p>
      {payload.map((p, i) => (
        <p key={i} style={{ color: p.color || '#60a5fa', fontSize: 14, fontWeight: 600 }}>
          {p.name}: {p.value}
        </p>
      ))}
    </div>
  );
};

export default function Analytics({ ctx }) {
  const { selectedReg } = ctx;
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('gradYear');

  useEffect(() => {
    if (selectedReg?.id && ctx.selectedOrg?.id) fetchData(selectedReg.id, ctx.selectedOrg.id);
  }, [selectedReg, ctx.selectedOrg]);

  async function fetchData(regId, orgId) {
    setLoading(true);
    try {
      const res = await api.analyticsGradYear(regId, orgId);
      setAnalytics(res.data);
    } catch (err) {
      toast.error('Failed to load analytics: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div className="loading-screen"><div className="spinner" /><p>Loading analytics...</p></div>;
  if (!selectedReg) return <div className="no-data" style={{ marginTop: 60 }}>Select a registration from the sidebar to load analytics.</div>;
  if (!analytics) return <div className="no-data" style={{ marginTop: 60 }}>No data available.</div>;

  const tabs = [
    { id: 'gradYear', label: '🎓 Graduation Year' },
    { id: 'division', label: '🏆 Division' },
    { id: 'gender', label: '👥 Gender' },
    { id: 'geography', label: '📍 Geography' },
  ];

  return (
    <div>
      <div className="page-header">
        <h1>Analytics</h1>
        <p>{selectedReg.name} — {analytics.total} total registrants</p>
      </div>

      <div className="tabs">
        {tabs.map(t => (
          <button key={t.id} className={`tab ${activeTab === t.id ? 'active' : ''}`} onClick={() => setActiveTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'gradYear' && <GradYearTab data={analytics} />}
      {activeTab === 'division' && <DivisionTab data={analytics} />}
      {activeTab === 'gender' && <GenderTab data={analytics} />}
      {activeTab === 'geography' && <GeographyTab data={analytics} />}
    </div>
  );
}

function GradYearTab({ data }) {
  const sorted = [...(data.graduationYear || [])].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div>
      {/* Bar chart */}
      <div className="card">
        <h2>Registrants by Graduation Year (Bar Chart)</h2>
        <ResponsiveContainer width="100%" height={360}>
          <BarChart data={sorted} margin={{ top: 10, right: 20, left: 0, bottom: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3e" />
            <XAxis dataKey="name" stroke="#475569" tick={{ fill: '#64748b', fontSize: 12 }} angle={-30} textAnchor="end" interval={0} />
            <YAxis stroke="#475569" tick={{ fill: '#64748b', fontSize: 12 }} />
            <Tooltip content={<CustomTooltip />} />
            <Bar dataKey="count" name="Registrants" radius={[4,4,0,0]}>
              {sorted.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="grid-2">
        {/* Pie chart */}
        <div className="card">
          <h2>Graduation Year Distribution (Pie)</h2>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie data={data.graduationYear} dataKey="count" nameKey="name" cx="50%" cy="50%" outerRadius={110} label={({ name, percent }) => `${name} ${(percent*100).toFixed(0)}%`} labelLine>
                {data.graduationYear.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip content={<CustomTooltip />} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        {/* Area chart timeline */}
        <div className="card">
          <h2>Grad Year Trend (Area)</h2>
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={sorted} margin={{ top: 10, right: 20, left: 0, bottom: 20 }}>
              <defs>
                <linearGradient id="gradBlue" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3e" />
              <XAxis dataKey="name" stroke="#475569" tick={{ fill: '#64748b', fontSize: 11 }} angle={-30} textAnchor="end" />
              <YAxis stroke="#475569" tick={{ fill: '#64748b', fontSize: 12 }} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="count" name="Registrants" stroke="#3b82f6" fill="url(#gradBlue)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Table */}
      <div className="card">
        <h2>Detailed Table</h2>
        <table className="data-table">
          <thead>
            <tr><th>Graduation Year</th><th>Count</th><th>Percentage</th><th>Share</th></tr>
          </thead>
          <tbody>
            {data.graduationYear.map((row, i) => (
              <tr key={row.name}>
                <td style={{ color: '#e2e8f0', fontWeight: 600 }}>{row.name}</td>
                <td><span className="badge badge-blue">{row.count}</span></td>
                <td style={{ color: '#64748b' }}>{((row.count / data.total) * 100).toFixed(2)}%</td>
                <td style={{ width: 200 }}>
                  <div style={{ background: '#1e2235', borderRadius: 4, height: 8, overflow: 'hidden' }}>
                    <div style={{
                      background: COLORS[i % COLORS.length],
                      width: `${(row.count / data.graduationYear[0].count) * 100}%`,
                      height: '100%', borderRadius: 4
                    }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DivisionTab({ data }) {
  const sorted = [...(data.division || [])].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div>
      <div className="card">
        <h2>Teams by Division (Grad Year)</h2>
        <ResponsiveContainer width="100%" height={360}>
          <BarChart data={sorted} margin={{ top: 10, right: 20, left: 0, bottom: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3e" />
            <XAxis dataKey="name" stroke="#475569" tick={{ fill: '#64748b', fontSize: 12 }} angle={-30} textAnchor="end" interval={0} />
            <YAxis stroke="#475569" tick={{ fill: '#64748b', fontSize: 12 }} />
            <Tooltip content={<CustomTooltip />} />
            <Bar dataKey="count" name="Teams" radius={[4,4,0,0]}>
              {sorted.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="grid-2">
        <div className="card">
          <h2>Division Distribution (Pie)</h2>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie data={data.division} dataKey="count" nameKey="name" cx="50%" cy="50%"
                outerRadius={110} label={({ name, percent }) => `${name}: ${(percent*100).toFixed(0)}%`}>
                {(data.division || []).map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip content={<CustomTooltip />} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="card">
          <h2>Division Table</h2>
          <table className="data-table">
            <thead><tr><th>Division</th><th>Teams</th><th>%</th></tr></thead>
            <tbody>
              {(data.division || []).map((row, i) => (
                <tr key={row.name}>
                  <td style={{ color: COLORS[i % COLORS.length], fontWeight: 700 }}>{row.name}</td>
                  <td><span className="badge badge-blue">{row.count}</span></td>
                  <td style={{ color: '#64748b' }}>{data.total > 0 ? ((row.count / data.total) * 100).toFixed(1) : 0}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function GenderTab({ data }) {
  return (
    <div className="grid-2">
      <div className="card">
        <h2>Gender Distribution (Pie)</h2>
        <ResponsiveContainer width="100%" height={320}>
          <PieChart>
            <Pie data={data.gender} dataKey="count" nameKey="name" cx="50%" cy="50%"
              outerRadius={120} label={({ name, percent }) => `${name} ${(percent*100).toFixed(1)}%`}>
              {data.gender.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Pie>
            <Tooltip content={<CustomTooltip />} />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="card">
        <h2>Gender Breakdown (Bar)</h2>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={data.gender} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3e" />
            <XAxis dataKey="name" stroke="#475569" tick={{ fill: '#64748b' }} />
            <YAxis stroke="#475569" tick={{ fill: '#64748b' }} />
            <Tooltip content={<CustomTooltip />} />
            <Bar dataKey="count" name="Registrants" radius={[4,4,0,0]}>
              {data.gender.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <table className="data-table" style={{ marginTop: 16 }}>
          <thead><tr><th>Gender</th><th>Count</th><th>%</th></tr></thead>
          <tbody>
            {data.gender.map((row, i) => (
              <tr key={row.name}>
                <td style={{ color: COLORS[i % COLORS.length] }}>{row.name}</td>
                <td style={{ color: '#e2e8f0' }}>{row.count}</td>
                <td style={{ color: '#64748b' }}>{((row.count / data.total) * 100).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AgeTab({ data }) {
  const sorted = [...(data.age || [])].sort((a, b) => {
    const na = parseInt(a.name); const nb = parseInt(b.name);
    return na - nb;
  });
  return (
    <div>
      <div className="card">
        <h2>Age Distribution (Bar)</h2>
        <ResponsiveContainer width="100%" height={340}>
          <BarChart data={sorted} margin={{ top: 10, right: 20, left: 0, bottom: 20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3e" />
            <XAxis dataKey="name" stroke="#475569" tick={{ fill: '#64748b', fontSize: 11 }} />
            <YAxis stroke="#475569" tick={{ fill: '#64748b', fontSize: 12 }} />
            <Tooltip content={<CustomTooltip />} />
            <Bar dataKey="count" name="Registrants" fill="#a855f7" radius={[4,4,0,0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="card">
        <h2>Age Distribution (Area)</h2>
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={sorted} margin={{ top: 10, right: 20, left: 0, bottom: 20 }}>
            <defs>
              <linearGradient id="gradPurple" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#a855f7" stopOpacity={0.4} />
                <stop offset="95%" stopColor="#a855f7" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3e" />
            <XAxis dataKey="name" stroke="#475569" tick={{ fill: '#64748b', fontSize: 11 }} />
            <YAxis stroke="#475569" tick={{ fill: '#64748b', fontSize: 12 }} />
            <Tooltip content={<CustomTooltip />} />
            <Area type="monotone" dataKey="count" name="Registrants" stroke="#a855f7" fill="url(#gradPurple)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function GeographyTab({ data }) {
  const top10States = (data.state || []).slice(0, 10);
  const top15Cities = (data.city || []).slice(0, 15);

  return (
    <div>
      <div className="card">
        <h2>Top 10 States by Registrants</h2>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={top10States} layout="vertical" margin={{ top: 10, right: 30, left: 30, bottom: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3e" horizontal={false} />
            <XAxis type="number" stroke="#475569" tick={{ fill: '#64748b' }} />
            <YAxis dataKey="name" type="category" stroke="#475569" tick={{ fill: '#94a3b8', fontSize: 13 }} width={40} />
            <Tooltip content={<CustomTooltip />} />
            <Bar dataKey="count" name="Registrants" radius={[0,4,4,0]}>
              {top10States.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="grid-2">
        <div className="card">
          <h2>State Distribution (Pie)</h2>
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie data={top10States} dataKey="count" nameKey="name" cx="50%" cy="50%"
                outerRadius={110} label={({ name, percent }) => `${name} ${(percent*100).toFixed(0)}%`}>
                {top10States.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip content={<CustomTooltip />} />
            </PieChart>
          </ResponsiveContainer>
        </div>

        <div className="card">
          <h2>Top Cities</h2>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={top15Cities} layout="vertical" margin={{ top: 0, right: 20, left: 60, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2d3e" horizontal={false} />
              <XAxis type="number" stroke="#475569" tick={{ fill: '#64748b', fontSize: 11 }} />
              <YAxis dataKey="name" type="category" stroke="#475569" tick={{ fill: '#94a3b8', fontSize: 11 }} width={55} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="count" name="Registrants" fill="#22c55e" radius={[0,4,4,0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Full state table */}
      <div className="card">
        <h2>All States</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          {(data.state || []).map((row, i) => (
            <div key={row.name} style={{
              background: '#1e2235', borderRadius: 8, padding: '10px 14px',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center'
            }}>
              <span style={{ color: '#94a3b8', fontSize: 14 }}>{row.name}</span>
              <span style={{ color: COLORS[i % COLORS.length], fontWeight: 700 }}>{row.count}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
