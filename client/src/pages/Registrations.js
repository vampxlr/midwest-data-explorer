import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { toast } from 'react-hot-toast';

export default function Registrations({ ctx }) {
  const { selectedOrg } = ctx;
  const [allRegs, setAllRegs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const perPage = 100;

  useEffect(() => {
    if (selectedOrg?.id) loadAll(selectedOrg.id, 1);
  }, [selectedOrg]);

  async function loadAll(orgId, pg) {
    setLoading(true);
    try {
      const res = await api.registrations(orgId, pg, perPage);
      const data = res.data?.data?.registrations;
      setAllRegs(data?.results || []);
      setTotalPages(data?.pageInformation?.pages || 1);
      setTotal(data?.pageInformation?.count || 0);
      setPage(pg);
    } catch (err) {
      toast.error('Failed to load registrations');
    } finally {
      setLoading(false);
    }
  }

  const filtered = allRegs.filter(r =>
    search === '' || r.name.toLowerCase().includes(search.toLowerCase())
  );

  const statusLabel = (s) => {
    if (s === 1) return <span className="badge badge-green">Open</span>;
    if (s === 2) return <span className="badge" style={{ background: '#1e2235', color: '#64748b' }}>Closed</span>;
    return <span className="badge badge-orange">{s}</span>;
  };

  function downloadCSV() {
    const headers = ['ID', 'Name', 'Status', 'Sport', 'Open', 'Close', 'Results Completed', 'Monetary'];
    const rows = filtered.map(r => [
      r.id, `"${r.name}"`, r.status, r.sport || '',
      r.open ? new Date(r.open).toLocaleDateString() : '',
      r.close ? new Date(r.close).toLocaleDateString() : '',
      r.resultsCompleted, r.monetary
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'registrations.csv'; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <div className="page-header">
        <h1>All Registrations</h1>
        <p>{selectedOrg?.name} — {total} total registrations</p>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center' }}>
        <input
          type="text"
          placeholder="Search registrations..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{
            flex: 1, background: '#13161f', border: '1px solid #2a2d3e',
            color: '#e2e8f0', borderRadius: 8, padding: '10px 14px',
            fontSize: 14, outline: 'none',
          }}
        />
        <button className="btn-secondary" style={{ width: 'auto', margin: 0 }} onClick={downloadCSV}>
          ↓ Export CSV
        </button>
      </div>

      {/* Pagination */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
        <button className="btn-secondary" style={{ width: 'auto', margin: 0 }}
          onClick={() => loadAll(selectedOrg.id, page - 1)} disabled={page <= 1 || loading}>
          ← Prev
        </button>
        <span style={{ color: '#64748b', fontSize: 13 }}>Page {page} of {totalPages}</span>
        <button className="btn-secondary" style={{ width: 'auto', margin: 0 }}
          onClick={() => loadAll(selectedOrg.id, page + 1)} disabled={page >= totalPages || loading}>
          Next →
        </button>
        <span style={{ color: '#475569', fontSize: 12, marginLeft: 8 }}>
          Showing {filtered.length} of {allRegs.length} on this page
        </span>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        {loading ? (
          <div className="no-data">Loading...</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Sport</th>
                  <th>Open</th>
                  <th>Close</th>
                  <th>Completions</th>
                  <th>Paid</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => (
                  <tr key={r.id}>
                    <td style={{ fontFamily: 'monospace', color: '#60a5fa' }}>{r.id}</td>
                    <td style={{ color: '#e2e8f0', maxWidth: 300 }}>{r.name}</td>
                    <td>{statusLabel(r.status)}</td>
                    <td style={{ color: '#94a3b8' }}>{r.sport || '—'}</td>
                    <td style={{ color: '#64748b', fontSize: 12 }}>
                      {r.open ? new Date(r.open).toLocaleDateString() : '—'}
                    </td>
                    <td style={{ color: '#64748b', fontSize: 12 }}>
                      {r.close ? new Date(r.close).toLocaleDateString() : '—'}
                    </td>
                    <td>
                      <span className="badge badge-orange">{r.resultsCompleted || 0}</span>
                    </td>
                    <td>
                      {r.monetary
                        ? <span className="badge badge-green">$</span>
                        : <span style={{ color: '#475569', fontSize: 12 }}>Free</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
