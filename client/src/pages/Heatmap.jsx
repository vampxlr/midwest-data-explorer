import React, { useEffect, useState } from 'react';
import { MapContainer, TileLayer, CircleMarker, Tooltip } from 'react-leaflet';
import { api } from '../api.jsx';
import { toast } from 'react-hot-toast';

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
};

export default function Heatmap({ ctx }) {
  const { orgId, selectedReg, recentRegs } = ctx;
  const [data, setData]     = useState(null);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState('map');
  const [scope, setScope]   = useState('single'); // 'single' | 'aggregate'

  useEffect(() => {
    if (selectedReg?.id && orgId && scope==='single') fetchSingle(selectedReg.id, orgId);
  }, [selectedReg, orgId]);

  async function fetchSingle(regId, oid) {
    setLoading(true);
    try {
      const res = await api.analyticsRegistration(regId, oid);
      setData(res.data);
    } catch { toast.error('Failed to load heatmap data'); }
    finally { setLoading(false); }
  }

  async function fetchAgg() {
    setLoading(true);
    try {
      const res = await api.analyticsAggregate(orgId, '');
      setData(res.data);
    } catch { toast.error('Failed to load aggregate heatmap'); }
    finally { setLoading(false); }
  }

  function switchScope(s) {
    setScope(s);
    setData(null);
    if (s==='aggregate') fetchAgg();
    else if (selectedReg?.id) fetchSingle(selectedReg.id, orgId);
  }

  if (loading) return <div className="loading-screen"><div className="spinner" /><p>Loading heatmap…</p></div>;

  const stateData = data?.state || [];
  const maxCount  = Math.max(...stateData.map(d=>d.count),1);

  return (
    <div>
      <div className="page-header">
        <h1>Geographic Heatmap</h1>
        <p>Where registrants are from — {scope==='aggregate'?`all events`:(selectedReg?.name||'—')}</p>
      </div>

      <div style={{display:'flex',gap:8,marginBottom:16}}>
        <button onClick={()=>switchScope('single')}
          style={{padding:'8px 18px',borderRadius:8,fontSize:13,fontWeight:700,border:'none',cursor:'pointer',
            background:scope==='single'?'#2563eb':'#1e2235',color:scope==='single'?'#fff':'#64748b'}}>
          Single Event
        </button>
        <button onClick={()=>switchScope('aggregate')}
          style={{padding:'8px 18px',borderRadius:8,fontSize:13,fontWeight:700,border:'none',cursor:'pointer',
            background:scope==='aggregate'?'#2563eb':'#1e2235',color:scope==='aggregate'?'#fff':'#64748b'}}>
          Last 90 Days
        </button>
        <span style={{flex:1}} />
        {['map','table','zip'].map(m=>(
          <button key={m} onClick={()=>setViewMode(m)}
            style={{padding:'7px 14px',borderRadius:6,fontSize:12,fontWeight:600,border:'none',cursor:'pointer',
              background:viewMode===m?'#1e3a5f':'#1e2235',color:viewMode===m?'#60a5fa':'#64748b'}}>
            {m==='map'?'Map':m==='table'?'State Table':'ZIP Codes'}
          </button>
        ))}
      </div>

      {!data && <div className="no-data" style={{marginTop:40}}>Select scope above to load map data.</div>}

      {data && viewMode==='map' && (
        <>
          <div className="card" style={{padding:0,overflow:'hidden',height:520}}>
            <MapContainer center={[44.5,-93.5]} zoom={6} style={{width:'100%',height:'100%'}} scrollWheelZoom>
              <TileLayer
                url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                attribution='&copy; CARTO' />
              {stateData.map(({name,count})=>{
                const coords=STATE_COORDS[name?.toUpperCase()];
                if(!coords) return null;
                const pct=count/maxCount;
                const radius=8+pct*55;
                const r=Math.round(255*pct), b=Math.round(255*(1-pct));
                const color=`rgb(${r},${Math.round(80*(1-pct))},${b})`;
                return (
                  <CircleMarker key={name} center={coords} radius={radius}
                    pathOptions={{color,fillColor:color,fillOpacity:0.6,weight:1}}>
                    <Tooltip permanent={false}><strong>{name}</strong>: {count} teams</Tooltip>
                  </CircleMarker>
                );
              })}
            </MapContainer>
          </div>
          <div className="card" style={{marginTop:16}}>
            <h2>Top States</h2>
            <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
              {stateData.slice(0,15).map(({name,count},i)=>(
                <div key={name} style={{background:'#1e2235',borderRadius:6,padding:'6px 12px',fontSize:13}}>
                  <span style={{color:'#94a3b8'}}>{name}: </span>
                  <span style={{color:'#f97316',fontWeight:700}}>{count}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {data && viewMode==='table' && (
        <div className="card">
          <h2>Registrants by State</h2>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(160px,1fr))',gap:10}}>
            {stateData.map(({name,count})=>(
              <div key={name} style={{background:'#1e2235',borderRadius:8,padding:'12px 14px'}}>
                <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
                  <span style={{color:'#e2e8f0',fontWeight:700}}>{name}</span>
                  <span style={{color:'#f97316',fontWeight:700}}>{count}</span>
                </div>
                <div style={{background:'#2a2d3e',borderRadius:4,height:6}}>
                  <div style={{width:`${(count/maxCount)*100}%`,height:'100%',borderRadius:4,
                    background:'linear-gradient(90deg,#3b82f6,#f97316)'}} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {data && viewMode==='zip' && (
        <div className="card">
          <h2>Top ZIP Codes</h2>
          {!data.zip?.length
            ? <div className="no-data">No ZIP data for this selection.</div>
            : (
              <table className="data-table">
                <thead><tr><th>ZIP</th><th>Count</th><th>Bar</th></tr></thead>
                <tbody>
                  {data.zip.map((row,i)=>(
                    <tr key={row.name}>
                      <td style={{color:'#e2e8f0',fontFamily:'monospace'}}>{row.name}</td>
                      <td><span className="badge badge-orange">{row.count}</span></td>
                      <td style={{width:180}}>
                        <div style={{background:'#1e2235',borderRadius:4,height:8}}>
                          <div style={{background:'#f97316',width:`${(row.count/(data.zip[0]?.count||1))*100}%`,height:'100%',borderRadius:4}} />
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
