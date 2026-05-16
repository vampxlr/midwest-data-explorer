import React, { useState } from 'react';
import { api } from '../api';
import { toast } from 'react-hot-toast';

const SAMPLE_QUERIES = [
  {
    label: 'List Organizations',
    query: `query {
  organizations(perPage: 50, page: 1) {
    pageInformation { count pages page perPage }
    results { id name }
  }
}`,
  },
  {
    label: 'List Registrations',
    query: `query {
  registrations(organizationId: 8008, page: 1, perPage: 50) {
    pageInformation { count pages }
    results {
      id name open close status
      sport resultsCompleted monetary
    }
  }
}`,
  },
  {
    label: 'Profiles (All)',
    query: `query {
  profiles(organizationId: 8008, page: 1, perPage: 50) {
    pageInformation { count pages }
    results {
      id firstName lastName email phone
      graduationYear gender dateOfBirth
      address { city state postalCode country }
    }
  }
}`,
  },
  {
    label: 'Registration Results + Answers',
    query: `query {
  registration(id: "54529", organizationId: 8008) {
    id name resultsCompleted
    registrationResults {
      id profileId completed status
      answers {
        name
        ... on StringRegistrationResultAnswer { strValue: value }
        ... on NumberRegistrationResultAnswer { numValue: value }
        ... on ArrayRegistrationResultAnswer { arrValue: value }
      }
    }
  }
}`,
  },
  {
    label: 'Single Profile',
    query: `query {
  profile(id: REPLACE_PROFILE_ID, organizationId: 8008) {
    id firstName lastName email
    graduationYear gender dateOfBirth
    address { city state postalCode country }
    sportsEngineId
  }
}`,
  },
  {
    label: 'Events',
    query: `query {
  events(organizationId: 8008, page: 1, perPage: 50) {
    pageInformation { count pages }
    results { id name }
  }
}`,
  },
  {
    label: 'Schema Introspection',
    query: `{
  __schema {
    queryType { name }
    types {
      name kind
      fields { name type { name kind } }
    }
  }
}`,
  },
  {
    label: 'Type Inspector',
    query: `{
  __type(name: "Profile") {
    name
    fields {
      name
      type { name kind ofType { name } }
    }
  }
}`,
  },
];

function JsonView({ data }) {
  const str = JSON.stringify(data, null, 2);

  const colorize = (text) => {
    return text
      .replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?)/g, (match) => {
        if (match.endsWith(':')) return `<span style="color:#60a5fa">${match}</span>`;
        return `<span style="color:#22c55e">${match}</span>`;
      })
      .replace(/\b(true|false)\b/g, '<span style="color:#f97316">$1</span>')
      .replace(/\bnull\b/g, '<span style="color:#ef4444">null</span>')
      .replace(/\b(-?\d+\.?\d*)\b/g, '<span style="color:#a855f7">$1</span>');
  };

  return (
    <pre style={{
      background: '#0a0c12', padding: 16, borderRadius: 8, overflow: 'auto',
      fontSize: 12, lineHeight: 1.6, color: '#e2e8f0', maxHeight: 500,
      fontFamily: '"Fira Code", "Cascadia Code", monospace',
    }} dangerouslySetInnerHTML={{ __html: colorize(str) }} />
  );
}

function TableView({ data }) {
  // Try to extract a flat array from the result
  const findArray = (obj) => {
    if (Array.isArray(obj)) return obj;
    if (obj && typeof obj === 'object') {
      for (const v of Object.values(obj)) {
        const found = findArray(v);
        if (found) return found;
      }
    }
    return null;
  };

  const rows = findArray(data?.data);
  if (!rows || rows.length === 0) return <div className="no-data">No tabular data found in result.</div>;

  const flattenObj = (obj, prefix = '') => {
    return Object.entries(obj || {}).reduce((acc, [k, v]) => {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        Object.assign(acc, flattenObj(v, key));
      } else if (Array.isArray(v)) {
        acc[key] = v.map(i => typeof i === 'object' ? JSON.stringify(i) : i).join(', ');
      } else {
        acc[key] = v;
      }
      return acc;
    }, {});
  };

  const flatRows = rows.map(r => flattenObj(r));
  const cols = Object.keys(flatRows[0] || {});

  return (
    <div style={{ overflowX: 'auto', maxHeight: 500, overflowY: 'auto' }}>
      <table className="data-table">
        <thead>
          <tr>{cols.map(c => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {flatRows.map((row, i) => (
            <tr key={i}>
              {cols.map(c => (
                <td key={c} style={{ color: '#94a3b8', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {String(row[c] ?? '')}
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
  const [query, setQuery] = useState(SAMPLE_QUERIES[0].query);
  const [variables, setVariables] = useState('{}');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState('json');
  const [error, setError] = useState(null);
  const [execTime, setExecTime] = useState(null);
  const [history, setHistory] = useState([]);

  async function runQuery() {
    setLoading(true);
    setError(null);
    const t0 = Date.now();
    try {
      let vars = {};
      try { vars = JSON.parse(variables); } catch {}
      const res = await api.graphql(query, vars);
      setResult(res.data);
      setExecTime(Date.now() - t0);
      setHistory(prev => [{ query: query.slice(0, 80) + '...', ts: new Date().toLocaleTimeString() }, ...prev.slice(0, 9)]);
      if (res.data?.errors) {
        toast.error('GraphQL errors returned');
      } else {
        toast.success(`Query executed in ${Date.now() - t0}ms`);
      }
    } catch (err) {
      setError(err.response?.data || { message: err.message });
      toast.error('Query failed');
    } finally {
      setLoading(false);
    }
  }

  function downloadCSV() {
    if (!result) return;
    const findArray = (obj) => {
      if (Array.isArray(obj)) return obj;
      if (obj && typeof obj === 'object') {
        for (const v of Object.values(obj)) { const f = findArray(v); if (f) return f; }
      }
      return null;
    };
    const rows = findArray(result?.data);
    if (!rows?.length) { toast.error('No tabular data to export'); return; }
    const flat = rows.map(r => {
      const out = {};
      const traverse = (o, prefix = '') => {
        for (const [k, v] of Object.entries(o || {})) {
          const key = prefix ? `${prefix}.${k}` : k;
          if (v && typeof v === 'object' && !Array.isArray(v)) traverse(v, key);
          else out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
        }
      };
      traverse(r);
      return out;
    });
    const cols = Object.keys(flat[0] || {});
    const csv = [cols.join(','), ...flat.map(r => cols.map(c => JSON.stringify(r[c] ?? '')).join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'query-result.csv'; a.click();
    URL.revokeObjectURL(url);
    toast.success('CSV downloaded');
  }

  return (
    <div>
      <div className="page-header">
        <h1>Query Explorer</h1>
        <p>Run custom GraphQL queries against the SportsEngine API</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 20 }}>
        {/* Sample queries sidebar */}
        <div>
          <div className="card" style={{ padding: 12 }}>
            <h3 style={{ marginBottom: 10, color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>Sample Queries</h3>
            {SAMPLE_QUERIES.map((sq, i) => (
              <button
                key={i}
                onClick={() => setQuery(sq.query)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  background: query === sq.query ? '#1e3a5f' : 'transparent',
                  border: 'none', borderRadius: 6, padding: '8px 10px',
                  color: query === sq.query ? '#60a5fa' : '#64748b',
                  fontSize: 13, cursor: 'pointer', marginBottom: 2,
                  transition: 'all 0.1s',
                }}
              >
                {sq.label}
              </button>
            ))}
          </div>

          {history.length > 0 && (
            <div className="card" style={{ padding: 12, marginTop: 0 }}>
              <h3 style={{ marginBottom: 10, color: '#64748b', fontSize: 11, textTransform: 'uppercase', letterSpacing: 1 }}>History</h3>
              {history.map((h, i) => (
                <div key={i} style={{ fontSize: 11, color: '#475569', marginBottom: 6, lineHeight: 1.4 }}>
                  <span style={{ color: '#64748b' }}>{h.ts}</span>
                  <div style={{ color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {h.query}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Editor + results */}
        <div>
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <h2 style={{ margin: 0 }}>GraphQL Query</h2>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-secondary" style={{ width: 'auto', margin: 0 }} onClick={downloadCSV} disabled={!result}>
                  ↓ Export CSV
                </button>
                <button className="btn-primary" onClick={runQuery} disabled={loading}>
                  {loading ? '⏳ Running...' : '▶ Run Query'}
                </button>
              </div>
            </div>

            <textarea
              value={query}
              onChange={e => setQuery(e.target.value)}
              style={{
                width: '100%', height: 220, background: '#0a0c12',
                border: '1px solid #2a2d3e', borderRadius: 8, padding: 14,
                color: '#e2e8f0', fontSize: 13, fontFamily: '"Fira Code", monospace',
                resize: 'vertical', outline: 'none', lineHeight: 1.6,
              }}
              placeholder="Enter your GraphQL query here..."
              spellCheck={false}
            />

            <div style={{ marginTop: 12 }}>
              <label style={{ fontSize: 12, color: '#64748b', display: 'block', marginBottom: 6 }}>Variables (JSON)</label>
              <textarea
                value={variables}
                onChange={e => setVariables(e.target.value)}
                style={{
                  width: '100%', height: 60, background: '#0a0c12',
                  border: '1px solid #2a2d3e', borderRadius: 8, padding: 10,
                  color: '#e2e8f0', fontSize: 12, fontFamily: '"Fira Code", monospace',
                  resize: 'none', outline: 'none',
                }}
                placeholder="{}"
                spellCheck={false}
              />
            </div>
          </div>

          {(result || error) && (
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button className={`tab ${viewMode === 'json' ? 'active' : ''}`} onClick={() => setViewMode('json')} style={{ padding: '6px 12px' }}>JSON</button>
                  <button className={`tab ${viewMode === 'table' ? 'active' : ''}`} onClick={() => setViewMode('table')} style={{ padding: '6px 12px' }}>Table</button>
                </div>
                {execTime && <span style={{ fontSize: 12, color: '#22c55e' }}>✓ {execTime}ms</span>}
              </div>

              {error && (
                <div style={{ background: '#1c0a0a', border: '1px solid #7f1d1d', borderRadius: 8, padding: 12, marginBottom: 12 }}>
                  <p style={{ color: '#ef4444', fontSize: 13 }}>Error: {JSON.stringify(error)}</p>
                </div>
              )}

              {result && viewMode === 'json' && <JsonView data={result} />}
              {result && viewMode === 'table' && <TableView data={result} />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
