import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.jsx';
import { invalidateDeadlineCache } from '../deadlines.jsx';
import { toast } from 'react-hot-toast';

// Registration deadlines admin: scrape, coverage, manual overrides, import/export.
export default function DeadlinesCard() {
  const [deadlines, setDeadlines] = useState({});
  const [coverage, setCoverage] = useState(null);
  const [scraping, setScraping] = useState(false);
  const [editing, setEditing] = useState(null); // eventId

  async function load({ invalidate = false } = {}) {
    try {
      const [d, c] = await Promise.all([api.getDeadlines(), api.deadlineCoverage()]);
      setDeadlines(d.data.deadlines || {});
      setCoverage(c.data);
      // after an import/scrape/edit, push the fresh list to every chart too
      if (invalidate) invalidateDeadlineCache();
    } catch {}
  }
  useEffect(() => { load(); }, []);

  // The edit row can land far down a long table with no visual cue it opened
  // at all — scroll it into view whenever `editing` changes.
  useEffect(() => {
    if (!editing) return;
    const el = document.getElementById(`deadline-row-${editing}`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [editing]);

  // "Add manually" for an uncovered event: create an empty manual row and open it
  async function addMissing(ev) {
    try {
      await api.setDeadline(ev.id, { eventName: ev.name });
      await load({ invalidate: true });
      setEditing(ev.id);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not add — try again');
    }
  }

  async function scrape() {
    setScraping(true);
    try {
      const r = await api.scrapeDeadlines();
      toast.success(`Scraped ${r.data.pagesScanned} pages — ${r.data.matched} events matched`);
      if (r.data.unmatched?.length) toast(`${r.data.unmatched.length} page(s) could not be matched`, { icon: '⚠️' });
      load({ invalidate: true });
    } catch (err) { toast.error(err.response?.data?.error || err.message); }
    finally { setScraping(false); }
  }

  async function save(id, d) {
    try {
      await api.setDeadline(id, d);
      toast.success('Saved (manual override — scraping will not overwrite it)');
      setEditing(null);
      load({ invalidate: true });
    } catch (err) { toast.error(err.message); }
  }

  const entries = Object.entries(deadlines).sort((a, b) => (b[1].earlyBird || '').localeCompare(a[1].earlyBird || ''));

  // Scraper stores site-relative paths ("/leagues/summer/wayzata-league"),
  // manual entries may hold full URLs — normalize both to something clickable.
  const sourceUrl = (d) => d.source ? (String(d.source).startsWith('http') ? d.source : `https://www.midwest3on3.com${d.source}`) : null;

  return (
    <div className="card" style={{ marginTop:20 }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:8, marginBottom:8 }}>
        <h2 style={{ margin:0 }}>Registration Deadlines</h2>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
          <button className="btn-secondary" style={{ width:'auto', margin:0 }} title="Download every deadline as a JSON file (portable to production)"
            onClick={() => { window.location.href = api.deadlinesExportUrl(); }}>
            ⬇ Export file
          </button>
          <label className="btn-secondary" style={{ width:'auto', margin:0, cursor:'pointer' }} title="Import a previously exported deadlines file (merges with existing)">
            ⬆ Import file
            <input type="file" accept=".json,application/json" style={{ display:'none' }}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                try {
                  const parsed = JSON.parse(await file.text());
                  const r = await api.importDeadlines({ deadlines: parsed.deadlines || parsed, mode: 'merge' });
                  toast.success(`Imported ${r.data.imported} deadlines (${r.data.skipped} skipped) — ${r.data.total} total`);
                  load({ invalidate: true });
                } catch (err) {
                  toast.error(err.response?.data?.error || 'Not a valid deadlines file');
                }
              }} />
          </label>
          <button className="btn-primary" onClick={scrape} disabled={scraping}>
            {scraping ? 'Scraping midwest3on3.com…' : '🌐 Scrape from midwest3on3.com'}
          </button>
        </div>
      </div>
      <p style={{ fontSize:12, color:'var(--text-3)', margin:'0 0 12px', lineHeight:1.5 }}>
        Early-bird and final registration deadlines pulled from the league/tournament/camp pages,
        matched to SportsEngine events, and shown as EB/Final markers on the YoY comparison charts.
        Edits here become manual overrides that scraping never overwrites.
      </p>
      {/* Coverage: which of this year's events still lack deadlines */}
      {coverage && (
        <div style={{ marginBottom:14, padding:'10px 14px', borderRadius:10,
          background: coverage.covered === coverage.total ? 'rgba(34,197,94,0.08)' : 'rgba(249,115,22,0.08)',
          border: `1px solid ${coverage.covered === coverage.total ? 'rgba(34,197,94,0.3)' : 'rgba(249,115,22,0.3)'}` }}>
          <div style={{ fontSize:12, fontWeight:700, color: coverage.covered === coverage.total ? 'var(--viz-up)' : 'var(--accent-2)', marginBottom: coverage.covered === coverage.total ? 0 : 8 }}>
            {coverage.year} coverage: {coverage.covered}/{coverage.total} events have deadlines
          </div>
          {coverage.events.filter(e => !e.has).map(ev => (
            <div key={ev.id} style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:8, padding:'3px 0', fontSize:12 }}>
              <span style={{ color:'var(--text-2)' }}>✗ {ev.name}</span>
              <button className="btn-chart" style={{ padding:'3px 10px', fontSize:11 }} onClick={() => addMissing(ev)}>+ Add manually</button>
            </div>
          ))}
        </div>
      )}

      {entries.length === 0 ? <div className="no-data">No deadlines yet — run the scraper.</div> : (
        <div style={{ overflowX:'auto' }}>
          <table className="data-table">
            <thead><tr><th>Event</th><th>Early bird</th><th>EB price</th><th>Final</th><th>Final price</th><th></th></tr></thead>
            <tbody>
              {entries.map(([id, d]) => editing === id ? (
                <EditRow key={id} id={id} d={d} onSave={save} onCancel={() => setEditing(null)} />
              ) : (
                <tr key={id} id={`deadline-row-${id}`}>
                  <td style={{ color:'var(--text-1)', fontWeight:500 }}>
                    {d.eventName}
                    {d.manual && <span className="badge badge-purple" style={{ marginLeft:6, fontSize:9 }}>manual</span>}
                    {sourceUrl(d) && <a href={sourceUrl(d)} target="_blank" rel="noopener noreferrer" title={`Open the page these deadlines came from: ${sourceUrl(d)}`} style={{ marginLeft:6, fontSize:12, textDecoration:'none' }}>🔗</a>}
                  </td>
                  <td>{d.earlyBird || '—'}</td>
                  <td>{d.earlyBirdPrice ? `$${d.earlyBirdPrice}` : '—'}</td>
                  <td>{d.finalDeadline || '—'}</td>
                  <td>{d.finalPrice ? `$${d.finalPrice}` : '—'}</td>
                  <td><button className="btn-chart" onClick={() => setEditing(id)}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function EditRow({ id, d, onSave, onCancel }) {
  const [f, setF] = useState({ ...d });
  return (
    <tr id={`deadline-row-${id}`} style={{ background: 'rgba(99,102,241,0.08)' }}>
      <td style={{ color:'var(--text-1)' }}>
        {d.eventName}
        <input type="url" className="field-input" style={{ display:'block', width:'100%', minWidth:180, marginTop:4, fontSize:11, boxSizing:'border-box' }}
          value={f.source || ''} placeholder="Page URL (e.g. https://www.midwest3on3.com/leagues/…)"
          onChange={e => setF(x => ({ ...x, source: e.target.value }))} />
      </td>
      <td><input type="date" className="field-input" value={f.earlyBird || ''} onChange={e => setF(x => ({ ...x, earlyBird: e.target.value }))} /></td>
      <td><input type="number" className="field-input" style={{ width:80 }} value={f.earlyBirdPrice ?? ''} onChange={e => setF(x => ({ ...x, earlyBirdPrice: e.target.value ? Number(e.target.value) : null }))} /></td>
      <td><input type="date" className="field-input" value={f.finalDeadline || ''} onChange={e => setF(x => ({ ...x, finalDeadline: e.target.value }))} /></td>
      <td><input type="number" className="field-input" style={{ width:80 }} value={f.finalPrice ?? ''} onChange={e => setF(x => ({ ...x, finalPrice: e.target.value ? Number(e.target.value) : null }))} /></td>
      <td style={{ whiteSpace:'nowrap' }}>
        <button className="btn-action-green" style={{ marginRight:4 }} onClick={() => onSave(id, f)}>Save</button>
        <button className="btn-chart" onClick={onCancel}>✕</button>
      </td>
    </tr>
  );
}
