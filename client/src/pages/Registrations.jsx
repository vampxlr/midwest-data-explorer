import React, { useEffect, useState } from 'react';
import { api } from '../api.jsx';
import { toast } from 'react-hot-toast';
import Panel from '../components/Panel.jsx';

export default function Registrations({ ctx }) {
  const { orgId, recentRegs, fromYear } = ctx;
  const [allRegs, setAllRegs]   = useState([]);
  const [loading, setLoading]   = useState(false);
  const [search, setSearch]     = useState('');
  const [page, setPage]         = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal]       = useState(0);
  const [mode, setMode]         = useState('recent'); // 'recent' | 'all'
  const perPage = 100;

  useEffect(() => {
    if (mode === 'recent') {
      setAllRegs(recentRegs);
      setTotal(recentRegs.length);
    } else {
      loadPage(orgId, 1);
    }
  }, [mode, recentRegs, orgId]);

  async function loadPage(oid, pg) {
    setLoading(true);
    try {
      const res = await api.registrations(oid, pg, perPage);
      const d = res.data?.data?.registrations;
      setAllRegs(d?.results || []);
      setTotalPages(d?.pageInformation?.pages || 1);
      setTotal(d?.pageInformation?.count || 0);
      setPage(pg);
    } catch { toast.error('Failed to load registrations'); }
    finally { setLoading(false); }
  }

  const filtered = allRegs.filter(r =>
    search === '' || r.name.toLowerCase().includes(search.toLowerCase())
  );

  function downloadCSV() {
    const headers = ['ID','Name','Status','Sport','Open','Close','Completions','Monetary'];
    const rows = filtered.map(r => [
      r.id, `"${r.name}"`, r.status, r.sport||'',
      r.open ? new Date(r.open).toLocaleDateString() : '',
      r.close? new Date(r.close).toLocaleDateString(): '',
      r.resultsCompleted||0, r.monetary,
    ]);
    const csv = [headers.join(','), ...rows.map(r=>r.join(','))].join('\n');
    const blob = new Blob([csv],{type:'text/csv'});
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a'); a.href=url; a.download='registrations.csv'; a.click();
    URL.revokeObjectURL(url);
    toast.success('CSV downloaded');
  }

  const statusBadge = (s) => {
    if (s===1) return <span className="badge badge-green">Open</span>;
    if (s===2) return <span className="badge" style={{background:'var(--surface-1)',color:'var(--text-3)'}}>Closed</span>;
    return <span className="badge badge-orange">{s}</span>;
  };

  return (
    <div>
      <div className="page-header">
        <h1>Registrations</h1>
        <p>Midwest 3 on 3 · {total} events</p>
      </div>

      <div style={{display:'flex',gap:8,marginBottom:16}}>
        <button onClick={()=>setMode('recent')}
          style={{padding:'8px 18px',borderRadius:8,fontSize:13,fontWeight:700,border:'none',cursor:'pointer',
            background:mode==='recent'?'#2563eb':'var(--surface-1)',color:mode==='recent'?'#fff':'var(--text-3)'}}>
          {fromYear}+ Events ({recentRegs.length})
        </button>
        <button onClick={()=>setMode('all')}
          style={{padding:'8px 18px',borderRadius:8,fontSize:13,fontWeight:700,border:'none',cursor:'pointer',
            background:mode==='all'?'#2563eb':'var(--surface-1)',color:mode==='all'?'#fff':'var(--text-3)'}}>
          All Events (705+)
        </button>
      </div>

      <div style={{display:'flex',gap:12,marginBottom:16,alignItems:'center'}}>
        <input type="text" placeholder="Search events…" value={search} onChange={e=>setSearch(e.target.value)}
          style={{flex:1,background:'var(--surface-2)',border:'1px solid var(--line)',color:'var(--text-1)',
            borderRadius:8,padding:'10px 14px',fontSize:14,outline:'none'}} />
        <button className="btn-secondary" style={{width:'auto',margin:0}} onClick={downloadCSV}>
          Export CSV
        </button>
      </div>

      {mode==='all' && (
        <div style={{display:'flex',gap:8,marginBottom:16,alignItems:'center'}}>
          <button className="btn-secondary" style={{width:'auto',margin:0}}
            onClick={()=>loadPage(orgId,page-1)} disabled={page<=1||loading}>Prev</button>
          <span style={{color:'var(--text-3)',fontSize:13}}>Page {page} / {totalPages}</span>
          <button className="btn-secondary" style={{width:'auto',margin:0}}
            onClick={()=>loadPage(orgId,page+1)} disabled={page>=totalPages||loading}>Next</button>
        </div>
      )}

      <Panel id="registrations-panel-1" style={{padding:0,overflow:'hidden'}}>
        {loading
          ? <div className="no-data">Loading…</div>
          : (
            <div style={{overflowX:'auto'}}>
              <table className="data-table">
                <thead>
                  <tr><th>ID</th><th>Event Name</th><th>Status</th><th>Open</th><th>Close</th><th>Teams</th><th>Paid</th></tr>
                </thead>
                <tbody>
                  {filtered.map(r=>(
                    <tr key={r.id}>
                      <td style={{fontFamily:'monospace',color:'var(--accent-light)',fontSize:12}}>{r.id}</td>
                      <td style={{color:'var(--text-1)',maxWidth:320}}>{r.name}</td>
                      <td>{statusBadge(r.status)}</td>
                      <td style={{color:'var(--text-3)',fontSize:12}}>{r.open?new Date(r.open).toLocaleDateString():'—'}</td>
                      <td style={{color:'var(--text-3)',fontSize:12}}>{r.close?new Date(r.close).toLocaleDateString():'—'}</td>
                      <td><span className="badge badge-orange">{r.resultsCompleted||0}</span></td>
                      <td>{r.monetary?<span className="badge badge-green">$</span>:<span style={{color:'var(--text-4)',fontSize:12}}>Free</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Panel>
    </div>
  );
}
