import React, { useState } from 'react';
import { api } from '../api.jsx';
import { toast } from 'react-hot-toast';

const SCENARIOS = [
  {
    group: 'Graduation Year Focus',
    items: [
      {
        label: 'All 2025+ Grad Year Breakdown',
        desc: 'Aggregate graduation year counts across every 2025+ registration',
        type: 'rest',
        url: '/api/analytics/aggregate?orgId=8008&fromYear=2025',
      },
      {
        label: '2025 Grad Players Only',
        desc: 'How many players graduating in 2025 registered across all 2025+ events',
        type: 'rest',
        url: '/api/analytics/aggregate?orgId=8008&fromYear=2025&gradYearFilter=2025',
      },
      {
        label: '2026 Grad Players Only',
        desc: 'Focus on 2026 graduating class across all recent events',
        type: 'rest',
        url: '/api/analytics/aggregate?orgId=8008&fromYear=2025&gradYearFilter=2026',
      },
      {
        label: '2025 + 2026 Combined',
        desc: 'Combined count of 2025 and 2026 graduating players',
        type: 'rest',
        url: '/api/analytics/aggregate?orgId=8008&fromYear=2025&gradYearFilter=2025,2026',
      },
      {
        label: 'Recent Registrations List',
        desc: 'All 2025+ events sorted by most recent',
        type: 'rest',
        url: '/api/registrations/recent?orgId=8008&fromYear=2025',
      },
    ],
  },
  {
    group: 'Single Event Deep Dive',
    items: [
      {
        label: 'Analyze Specific Event',
        desc: 'Full analytics for one registration — replace the ID',
        type: 'graphql',
        query: `query {
  registration(id: "1072679", organizationId: 8008) {
    id name resultsCompleted
    registrationResults {
      id profileId completed status
      answers {
        name
        ... on StringRegistrationResultAnswer { strValue: value }
        ... on NumberRegistrationResultAnswer { numValue: value }
      }
    }
  }
}`,
      },
      {
        label: '2026 Eden Prairie — Grad Years',
        desc: 'Single event: 2026 Eden Prairie registration answers',
        type: 'rest',
        url: '/api/analytics/registration?registrationId=1072679&orgId=8008',
      },
      {
        label: 'Wayzata 2026 League',
        desc: 'Analytics for the Wayzata 2026 registration',
        type: 'rest',
        url: '/api/analytics/registration?registrationId=1081198&orgId=8008',
      },
    ],
  },
  {
    group: 'Demographics',
    items: [
      {
        label: 'Profiles — Page 1',
        desc: 'Browse all registrant profiles with address and demographics',
        type: 'graphql',
        query: `query {
  profiles(organizationId: 8008, page: 1, perPage: 50) {
    pageInformation { count pages }
    results {
      id firstName lastName email
      graduationYear gender dateOfBirth
      address { city state postalCode country }
    }
  }
}`,
      },
      {
        label: 'All 2025+ Registrations',
        desc: 'List every registration from 2025 onwards',
        type: 'graphql',
        query: `query {
  registrations(organizationId: 8008, page: 7, perPage: 100) {
    pageInformation { count pages }
    results {
      id name open close status resultsCompleted
    }
  }
}`,
      },
      {
        label: 'Organizations',
        desc: 'List all organizations this API key has access to',
        type: 'graphql',
        query: `query {
  organizations(perPage: 50, page: 1) {
    pageInformation { count }
    results { id name }
  }
}`,
      },
    ],
  },
  {
    group: 'Schema & Debug',
    items: [
      {
        label: 'Registration Type Fields',
        desc: 'What fields are on a Registration object',
        type: 'graphql',
        query: `{
  __type(name: "Registration") {
    name
    fields { name type { name kind ofType { name } } }
  }
}`,
      },
      {
        label: 'Profile Type Fields',
        desc: 'All fields available on a Profile',
        type: 'graphql',
        query: `{
  __type(name: "Profile") {
    name
    fields { name type { name kind ofType { name } } }
  }
}`,
      },
      {
        label: 'All Query Types',
        desc: 'Every available GraphQL query',
        type: 'graphql',
        query: `{
  __type(name: "Query") {
    fields {
      name
      args { name type { name kind ofType { name } } }
    }
  }
}`,
      },
    ],
  },
];

function JsonView({ data }) {
  const colorize = (text) =>
    text
      .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?)/g, m =>
        m.endsWith(':')
          ? `<span style="color:var(--accent-light)">${m}</span>`
          : `<span style="color:#22c55e">${m}</span>`)
      .replace(/\b(true|false)\b/g, '<span style="color:#f97316">$1</span>')
      .replace(/\bnull\b/g, '<span style="color:#ef4444">null</span>')
      .replace(/\b(-?\d+\.?\d*)\b/g, '<span style="color:#a855f7">$1</span>');
  return (
    <pre style={{background:'var(--surface-3)',padding:16,borderRadius:8,overflow:'auto',fontSize:12,lineHeight:1.6,
      color:'var(--text-1)',maxHeight:520,fontFamily:'monospace'}}
      dangerouslySetInnerHTML={{__html:colorize(JSON.stringify(data,null,2))}} />
  );
}

function FlatTable({ data }) {
  const findArr = (o) => {
    if (Array.isArray(o)) return o;
    if (o && typeof o === 'object') {
      for (const v of Object.values(o)) { const f=findArr(v); if(f) return f; }
    }
    return null;
  };
  const rows = findArr(data);
  if (!rows?.length) return <div className="no-data">No tabular data in result</div>;
  const flatten = (obj,pre='') => Object.entries(obj||{}).reduce((acc,[k,v])=>{
    const key=pre?`${pre}.${k}`:k;
    if(v&&typeof v==='object'&&!Array.isArray(v)) Object.assign(acc,flatten(v,key));
    else acc[key]=Array.isArray(v)?v.map(i=>typeof i==='object'?JSON.stringify(i):i).join(', '):v;
    return acc;
  },{});
  const flat=rows.map(r=>flatten(r));
  const cols=Object.keys(flat[0]||{});
  return (
    <div style={{overflowX:'auto',maxHeight:500,overflowY:'auto'}}>
      <table className="data-table">
        <thead><tr>{cols.map(c=><th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {flat.map((row,i)=>(
            <tr key={i}>
              {cols.map(c=>(
                <td key={c} style={{color:'var(--text-2)',maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                  {String(row[c]??'')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function QueryExplorer() {
  const [query, setQuery]       = useState('');
  const [restUrl, setRestUrl]   = useState('');
  const [variables, setVariables] = useState('{}');
  const [result, setResult]     = useState(null);
  const [loading, setLoading]   = useState(false);
  const [viewMode, setViewMode] = useState('json');
  const [error, setError]       = useState(null);
  const [execTime, setExecTime] = useState(null);
  const [queryType, setQueryType] = useState('graphql'); // 'graphql' | 'rest'

  async function run() {
    setLoading(true); setError(null); setResult(null);
    const t0 = Date.now();
    try {
      let res;
      if (queryType === 'graphql') {
        let vars = {};
        try { vars = JSON.parse(variables); } catch {}
        res = await api.graphql(query, vars);
        setResult(res.data);
      } else {
        const { default: axios } = await import('axios');
        res = await axios.get(restUrl);
        setResult(res.data);
      }
      setExecTime(Date.now()-t0);
      toast.success(`Done in ${Date.now()-t0}ms`);
    } catch (err) {
      setError(err.response?.data || {message:err.message});
      toast.error('Query failed');
    } finally { setLoading(false); }
  }

  function loadScenario(item) {
    if (item.type === 'graphql') {
      setQueryType('graphql');
      setQuery(item.query||'');
      setRestUrl('');
    } else {
      setQueryType('rest');
      setRestUrl(item.url||'');
      setQuery('');
    }
    setResult(null); setError(null);
  }

  function downloadCSV() {
    if (!result) return;
    const findArr = (o) => {
      if (Array.isArray(o)) return o;
      if (o&&typeof o==='object') for (const v of Object.values(o)) { const f=findArr(v); if(f) return f; }
      return null;
    };
    const rows = findArr(result);
    if (!rows?.length) { toast.error('No tabular data'); return; }
    const flat = rows.map(r => {
      const out={};
      const t=(o,p='')=>{ for(const [k,v] of Object.entries(o||{})){
        const key=p?`${p}.${k}`:k;
        if(v&&typeof v==='object'&&!Array.isArray(v))t(v,key); else out[key]=Array.isArray(v)?JSON.stringify(v):v;
      }};
      t(r); return out;
    });
    const cols=Object.keys(flat[0]||{});
    const csv=[cols.join(','),...flat.map(r=>cols.map(c=>JSON.stringify(r[c]??'')).join(','))].join('\n');
    const blob=new Blob([csv],{type:'text/csv'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=url; a.download='query-result.csv'; a.click();
    URL.revokeObjectURL(url);
    toast.success('CSV downloaded');
  }

  return (
    <div>
      <div className="page-header">
        <h1>Query Explorer</h1>
        <p>Pre-built scenarios for graduation year analysis, plus custom GraphQL and REST queries</p>
      </div>

      <div style={{display:'grid',gridTemplateColumns:'260px 1fr',gap:20}}>
        {/* Scenario sidebar */}
        <div style={{maxHeight:'85vh',overflowY:'auto'}}>
          {SCENARIOS.map(group => (
            <div key={group.group} className="card" style={{padding:12,marginBottom:12}}>
              <h3 style={{fontSize:11,textTransform:'uppercase',letterSpacing:1,color:'var(--text-4)',marginBottom:10}}>
                {group.group}
              </h3>
              {group.items.map((item,i) => (
                <button key={i} onClick={()=>loadScenario(item)}
                  title={item.desc}
                  style={{
                    display:'block',width:'100%',textAlign:'left',
                    background:'transparent',border:'none',borderRadius:6,
                    padding:'8px 10px',color:'var(--text-3)',fontSize:13,cursor:'pointer',
                    marginBottom:2,transition:'all 0.1s',lineHeight:1.3,
                  }}
                  onMouseEnter={e=>e.target.style.background='var(--surface-1)'}
                  onMouseLeave={e=>e.target.style.background='transparent'}>
                  <div style={{fontWeight:600}}>{item.label}</div>
                  <div style={{fontSize:11,color:'var(--text-4)',marginTop:2}}>{item.desc}</div>
                </button>
              ))}
            </div>
          ))}
        </div>

        {/* Editor */}
        <div>
          <div className="card">
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
              <div style={{display:'flex',gap:6}}>
                <button onClick={()=>setQueryType('graphql')}
                  style={{padding:'6px 14px',borderRadius:6,fontSize:12,fontWeight:600,border:'none',cursor:'pointer',
                    background:queryType==='graphql'?'#1d4ed8':'var(--surface-1)',color:queryType==='graphql'?'#fff':'var(--text-3)'}}>
                  GraphQL
                </button>
                <button onClick={()=>setQueryType('rest')}
                  style={{padding:'6px 14px',borderRadius:6,fontSize:12,fontWeight:600,border:'none',cursor:'pointer',
                    background:queryType==='rest'?'#1d4ed8':'var(--surface-1)',color:queryType==='rest'?'#fff':'var(--text-3)'}}>
                  REST
                </button>
              </div>
              <div style={{display:'flex',gap:8}}>
                <button className="btn-secondary" style={{width:'auto',margin:0}} onClick={downloadCSV} disabled={!result}>
                  Export CSV
                </button>
                <button className="btn-primary" onClick={run} disabled={loading}>
                  {loading?'Running…':'Run'}
                </button>
              </div>
            </div>

            {queryType==='graphql' ? (
              <>
                <textarea value={query} onChange={e=>setQuery(e.target.value)}
                  style={{width:'100%',height:200,background:'var(--surface-3)',border:'1px solid var(--line)',
                    borderRadius:8,padding:14,color:'var(--text-1)',fontSize:13,fontFamily:'monospace',
                    resize:'vertical',outline:'none',lineHeight:1.6}}
                  placeholder="Select a scenario from the left, or type a GraphQL query…" spellCheck={false} />
                <div style={{marginTop:10}}>
                  <label style={{fontSize:11,color:'var(--text-3)',display:'block',marginBottom:4}}>Variables (JSON)</label>
                  <textarea value={variables} onChange={e=>setVariables(e.target.value)}
                    style={{width:'100%',height:50,background:'var(--surface-3)',border:'1px solid var(--line)',
                      borderRadius:8,padding:10,color:'var(--text-1)',fontSize:12,fontFamily:'monospace',
                      resize:'none',outline:'none'}}
                    placeholder="{}" spellCheck={false} />
                </div>
              </>
            ) : (
              <div>
                <label style={{fontSize:11,color:'var(--text-3)',display:'block',marginBottom:6}}>REST Endpoint URL</label>
                <input value={restUrl} onChange={e=>setRestUrl(e.target.value)}
                  style={{width:'100%',background:'var(--surface-3)',border:'1px solid var(--line)',borderRadius:8,
                    padding:'10px 14px',color:'var(--text-1)',fontSize:13,fontFamily:'monospace',outline:'none'}}
                  placeholder="/api/analytics/aggregate?orgId=8008&fromYear=2025&gradYearFilter=2025" />
                <p style={{color:'var(--text-4)',fontSize:11,marginTop:6}}>
                  Available: /api/registrations/recent · /api/analytics/registration · /api/analytics/aggregate · /api/profiles
                </p>
              </div>
            )}
          </div>

          {(result||error) && (
            <div className="card">
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
                <div style={{display:'flex',gap:4}}>
                  <button className={`tab ${viewMode==='json'?'active':''}`} onClick={()=>setViewMode('json')} style={{padding:'6px 12px'}}>JSON</button>
                  <button className={`tab ${viewMode==='table'?'active':''}`} onClick={()=>setViewMode('table')} style={{padding:'6px 12px'}}>Table</button>
                </div>
                {execTime && <span style={{fontSize:12,color:'#22c55e'}}>{execTime}ms</span>}
              </div>
              {error && (
                <div style={{background:'rgba(239,68,68,0.12)',border:'1px solid rgba(239,68,68,0.35)',borderRadius:8,padding:12,marginBottom:12}}>
                  <p style={{color:'#ef4444',fontSize:13}}>Error: {JSON.stringify(error)}</p>
                </div>
              )}
              {result && viewMode==='json'   && <JsonView data={result} />}
              {result && viewMode==='table'  && <FlatTable data={result} />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
