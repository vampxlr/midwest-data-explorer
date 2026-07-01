import React, { useEffect, useState } from 'react';
import { api } from '../api.jsx';
import { toast } from 'react-hot-toast';

export default function SchemaExplorer() {
  const [schema, setSchema] = useState(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedType, setSelectedType] = useState(null);

  useEffect(() => { fetchSchema(); }, []);

  async function fetchSchema() {
    setLoading(true);
    try {
      const res = await api.schema();
      setSchema(res.data?.data?.__schema);
    } catch (err) {
      toast.error('Failed to load schema: ' + err.message);
    } finally {
      setLoading(false);
    }
  }

  if (loading) return <div className="loading-screen"><div className="spinner" /><p>Loading API schema...</p></div>;

  const types = (schema?.types || []).filter(t =>
    !t.name.startsWith('__') &&
    t.kind !== 'SCALAR' &&
    t.kind !== 'ENUM' &&
    (search === '' || t.name.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div>
      <div className="page-header">
        <h1>Schema Explorer</h1>
        <p>Browse all available GraphQL types and fields</p>
      </div>

      <input
        type="text"
        placeholder="Search types..."
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{
          width: '100%', background: 'var(--surface-2)', border: '1px solid var(--line)',
          color: 'var(--text-1)', borderRadius: 8, padding: '10px 14px',
          fontSize: 14, outline: 'none', marginBottom: 16,
        }}
      />

      <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 20 }}>
        {/* Type list */}
        <div className="card" style={{ padding: 8, maxHeight: 600, overflowY: 'auto' }}>
          {types.length === 0 && <div className="no-data">No types found</div>}
          {types.map(t => (
            <button
              key={t.name}
              onClick={() => setSelectedType(t)}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                background: selectedType?.name === t.name ? 'var(--chip-bg)' : 'transparent',
                border: 'none', borderRadius: 6, padding: '8px 12px',
                color: selectedType?.name === t.name ? 'var(--accent-light)' : 'var(--text-2)',
                fontSize: 13, cursor: 'pointer', marginBottom: 2,
                transition: 'all 0.1s',
              }}
            >
              <span style={{
                display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
                background: t.kind === 'OBJECT' ? '#22c55e' : t.kind === 'INPUT_OBJECT' ? '#f97316' : '#a855f7',
                marginRight: 8,
              }} />
              {t.name}
              <span style={{ fontSize: 10, color: 'var(--text-4)', marginLeft: 6 }}>{t.kind}</span>
            </button>
          ))}
        </div>

        {/* Type detail */}
        <div>
          {!selectedType ? (
            <div className="card">
              <div className="no-data">Select a type to view its fields.</div>
            </div>
          ) : (
            <div className="card">
              <div style={{ marginBottom: 16 }}>
                <h2>{selectedType.name}</h2>
                <span className="badge badge-blue" style={{ marginRight: 8 }}>{selectedType.kind}</span>
                {selectedType.description && (
                  <p style={{ color: 'var(--text-3)', fontSize: 13, marginTop: 8 }}>{selectedType.description}</p>
                )}
              </div>

              {selectedType.fields && selectedType.fields.length > 0 ? (
                <table className="data-table">
                  <thead>
                    <tr><th>Field</th><th>Type</th><th>Description</th></tr>
                  </thead>
                  <tbody>
                    {selectedType.fields.map(f => {
                      const typeName = f.type?.name || f.type?.ofType?.name || f.type?.ofType?.ofType?.name || '...';
                      return (
                        <tr key={f.name}>
                          <td style={{ color: 'var(--accent-light)', fontFamily: 'monospace', fontWeight: 600 }}>{f.name}</td>
                          <td><span className="badge badge-purple">{typeName}</span></td>
                          <td style={{ color: 'var(--text-3)', fontSize: 12 }}>{f.description || '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : (
                <div className="no-data">No fields available for this type.</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
