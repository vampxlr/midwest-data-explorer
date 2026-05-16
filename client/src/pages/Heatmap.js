import React, { useEffect, useState, useRef } from 'react';
import { MapContainer, TileLayer, CircleMarker, Tooltip, useMap } from 'react-leaflet';
import { api } from '../api';
import { toast } from 'react-hot-toast';

// US state centers for plotting
const STATE_COORDS = {
  AL:[32.8,-86.8],AK:[64.2,-153.4],AZ:[34.2,-111.1],AR:[34.8,-92.2],CA:[36.8,-119.4],
  CO:[39.0,-105.5],CT:[41.6,-72.7],DE:[39.0,-75.5],FL:[27.8,-81.6],GA:[32.9,-83.4],
  HI:[20.8,-157.0],ID:[44.2,-114.5],IL:[40.0,-89.2],IN:[40.3,-86.1],IA:[42.0,-93.2],
  KS:[38.5,-98.4],KY:[37.5,-85.3],LA:[31.2,-91.8],ME:[44.7,-69.4],MD:[39.0,-76.8],
  MA:[42.2,-71.5],MI:[44.3,-85.4],MN:[46.4,-93.1],MS:[32.7,-89.7],MO:[38.5,-92.3],
  MT:[47.0,-110.0],NE:[41.5,-99.9],NV:[38.5,-117.1],NH:[43.7,-71.6],NJ:[40.1,-74.6],
  NM:[34.3,-106.0],NY:[42.2,-75.0],NC:[35.5,-79.4],ND:[47.5,-100.5],OH:[40.4,-82.8],
  OK:[35.6,-96.9],OR:[44.0,-120.6],PA:[40.6,-77.2],RI:[41.7,-71.5],SC:[33.9,-80.9],
  SD:[44.4,-100.2],TN:[35.9,-86.7],TX:[31.1,-97.6],UT:[39.3,-111.1],VT:[44.0,-72.7],
  VA:[37.5,-78.5],WA:[47.4,-121.5],WV:[38.6,-80.6],WI:[44.3,-90.1],WY:[43.0,-107.6],
  DC:[38.9,-77.0],
  // Canadian provinces
  AB:[53.9,-116.6],BC:[53.7,-127.6],MB:[53.8,-98.8],NB:[46.5,-66.5],
  NL:[53.1,-57.7],NS:[45.0,-63.0],ON:[50.0,-85.3],PE:[46.4,-63.1],
  QC:[52.9,-73.5],SK:[52.9,-106.5],
};

function HeatLayer({ stateData }) {
  const map = useMap();
  const maxCount = Math.max(...stateData.map(d => d.count), 1);
  return (
    <>
      {stateData.map(({ name, count }) => {
        const coords = STATE_COORDS[name?.toUpperCase()];
        if (!coords) return null;
        const intensity = count / maxCount;
        const radius = 10 + intensity * 50;
        const red = Math.round(255 * intensity);
        const blue = Math.round(255 * (1 - intensity));
        const color = `rgb(${red},${Math.round(100 * (1 - intensity))},${blue})`;
        return (
          <CircleMarker
            key={name}
            center={coords}
            radius={radius}
            pathOptions={{ color, fillColor: color, fillOpacity: 0.55, weight: 1 }}
          >
            <Tooltip permanent={false}>
              <strong>{name}</strong>: {count} registrants
            </Tooltip>
          </CircleMarker>
        );
      })}
    </>
  );
}

export default function Heatmap({ ctx }) {
  const { selectedReg } = ctx;
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState('state');

  useEffect(() => {
    if (selectedReg?.id && ctx.selectedOrg?.id) fetchData(selectedReg.id, ctx.selectedOrg.id);
  }, [selectedReg, ctx.selectedOrg]);

  async function fetchData(regId, orgId) {
    setLoading(true);
    try {
      const res = await api.analyticsGradYear(regId, orgId);
      setAnalytics(res.data);
    } catch (err) {
      toast.error('Failed to load heatmap data');
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div className="loading-screen"><div className="spinner" /><p>Loading heatmap...</p></div>;
  if (!selectedReg) return <div className="no-data" style={{ marginTop: 60 }}>Select a registration from the sidebar.</div>;

  const stateData = analytics?.state || [];
  const cityData = analytics?.city || [];
  const maxCount = Math.max(...stateData.map(d => d.count), 1);

  return (
    <div>
      <div className="page-header">
        <h1>Geographic Heatmap</h1>
        <p>{selectedReg.name} — where registrants are from</p>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className={`tab ${viewMode === 'state' ? 'active' : ''}`} onClick={() => setViewMode('state')} style={{ padding: '8px 16px' }}>By State</button>
        <button className={`tab ${viewMode === 'table' ? 'active' : ''}`} onClick={() => setViewMode('table')} style={{ padding: '8px 16px' }}>State Table</button>
        <button className={`tab ${viewMode === 'zip' ? 'active' : ''}`} onClick={() => setViewMode('zip')} style={{ padding: '8px 16px' }}>ZIP Breakdown</button>
      </div>

      {viewMode === 'state' && (
        <>
          <div className="card" style={{ padding: 0, overflow: 'hidden', height: 520 }}>
            <MapContainer
              center={[39.5, -98.4]}
              zoom={4}
              style={{ width: '100%', height: '100%' }}
              scrollWheelZoom
            >
              <TileLayer
                url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                attribution='&copy; <a href="https://carto.com/">CARTO</a>'
              />
              <HeatLayer stateData={stateData} />
            </MapContainer>
          </div>
          {/* Legend */}
          <div className="card" style={{ marginTop: 16 }}>
            <h2>Map Legend</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
              <div style={{ display: 'flex', height: 16, width: 200, borderRadius: 8, overflow: 'hidden' }}>
                {Array.from({ length: 20 }, (_, i) => {
                  const t = i / 19;
                  return <div key={i} style={{ flex: 1, background: `rgb(${Math.round(255*t)},${Math.round(100*(1-t))},${Math.round(255*(1-t))})` }} />;
                })}
              </div>
              <span style={{ color: '#64748b', fontSize: 12 }}>Low → High registrant count</span>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {stateData.slice(0, 10).map(({ name, count }) => (
                <span key={name} style={{
                  background: '#1e2235', borderRadius: 6, padding: '4px 10px',
                  fontSize: 12, color: '#94a3b8'
                }}>
                  {name}: <strong style={{ color: '#e2e8f0' }}>{count}</strong>
                </span>
              ))}
            </div>
          </div>
        </>
      )}

      {viewMode === 'table' && (
        <div className="card">
          <h2>Registrants by State</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
            {stateData.map(({ name, count }) => {
              const pct = ((count / maxCount) * 100);
              return (
                <div key={name} style={{ background: '#1e2235', borderRadius: 8, padding: '12px 14px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ color: '#e2e8f0', fontWeight: 700 }}>{name}</span>
                    <span style={{ color: '#f97316', fontWeight: 700 }}>{count}</span>
                  </div>
                  <div style={{ background: '#2a2d3e', borderRadius: 4, height: 6 }}>
                    <div style={{
                      width: `${pct}%`, height: '100%', borderRadius: 4,
                      background: 'linear-gradient(90deg, #3b82f6, #f97316)'
                    }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {viewMode === 'zip' && (
        <div className="card">
          <h2>Top ZIP Codes</h2>
          {(analytics?.zip || []).length === 0 ? (
            <div className="no-data">No ZIP code data available.</div>
          ) : (
            <table className="data-table">
              <thead><tr><th>ZIP Code</th><th>Count</th><th>Share</th></tr></thead>
              <tbody>
                {(analytics?.zip || []).map((row, i) => (
                  <tr key={row.name}>
                    <td style={{ color: '#e2e8f0', fontFamily: 'monospace' }}>{row.name}</td>
                    <td><span className="badge badge-orange">{row.count}</span></td>
                    <td style={{ width: 200 }}>
                      <div style={{ background: '#1e2235', borderRadius: 4, height: 8 }}>
                        <div style={{
                          background: '#f97316',
                          width: `${(row.count / (analytics.zip[0]?.count || 1)) * 100}%`,
                          height: '100%', borderRadius: 4
                        }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
