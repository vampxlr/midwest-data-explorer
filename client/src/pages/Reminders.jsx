import React, { useEffect, useState } from 'react';
import { toast } from 'react-hot-toast';
import { api } from '../api.jsx';

/**
 * 📣 Reminders — re-engagement campaigns for lapsed registrants.
 * Open events are auto-mapped to their past-year editions; the lapsed audience
 * (attended before, not graduated, not registered this year) gets a chosen
 * template via Mailchimp. Templates are editable here; open/click stats come
 * back from Mailchimp reports.
 */
export default function Reminders() {
  const [audiences, setAudiences] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [history, setHistory] = useState([]);
  const [pick, setPick] = useState({});        // eventId -> templateId
  const [busy, setBusy] = useState({});        // eventId -> 'test'|'send'
  const [editing, setEditing] = useState(null); // template being edited
  const [loadingStats, setLoadingStats] = useState(false);

  useEffect(() => {
    api.reminderTemplates().then(r => setTemplates(r.data.templates)).catch(() => {});
    api.reminderHistory(false).then(r => setHistory(r.data.campaigns)).catch(() => {});
    api.reminderAudiences().then(r => setAudiences(r.data.audiences))
      .catch(err => { setAudiences([]); toast.error(err.response?.data?.error || 'Could not compute audiences'); });
  }, []);

  async function send(a, test) {
    const templateId = pick[a.eventId] || templates[0]?.id;
    if (!templateId) return toast.error('Pick a template first');
    let testEmail = null;
    if (test) {
      testEmail = window.prompt('Send a test of this email to which address?');
      if (!testEmail) return;
    } else if (!window.confirm(`Send "${templates.find(t => t.id === templateId)?.name}" to ${a.lapsed} lapsed contacts for ${a.name}?\n\nThis is a REAL send through Mailchimp.`)) return;
    setBusy(b => ({ ...b, [a.eventId]: test ? 'test' : 'send' }));
    try {
      const r = await api.sendReminder({ eventId: a.eventId, templateId, testEmail });
      toast.success(test ? `Test sent to ${testEmail}` : `Sent to ${r.data.sent} contacts 🎉`);
      if (!test) api.reminderHistory(false).then(x => setHistory(x.data.campaigns)).catch(() => {});
    } catch (err) { toast.error(err.response?.data?.error || 'Send failed'); }
    finally { setBusy(b => ({ ...b, [a.eventId]: null })); }
  }

  async function saveTemplates(next) {
    try {
      await api.saveReminderTemplates(next);
      setTemplates(next);
      toast.success('Templates saved');
    } catch (err) { toast.error(err.response?.data?.error || 'Save failed'); }
  }

  async function refreshStats() {
    setLoadingStats(true);
    try { setHistory((await api.reminderHistory(true)).data.campaigns); }
    catch { toast.error('Could not load Mailchimp stats'); }
    finally { setLoadingStats(false); }
  }

  const fmtD = (d) => d || '—';

  return (
    <div>
      <div className="page-header">
        <h1>📣 Reminders</h1>
        <p>Win back last year's families: each open event is matched to its past editions, and everyone who played before (and hasn't graduated) but isn't registered this year can get a reminder — sent through Mailchimp into the Midwest Data Explorer audience</p>
      </div>

      {/* Audiences */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <h2 style={{ margin: 0 }}>Lapsed audiences by open event</h2>
          <button className="btn-secondary" style={{ width: 'auto', margin: 0 }} title="Numbers are cached for the day — recompute after a Smart Update or deadline change"
            onClick={() => { setAudiences(null); api.reminderAudiences(true).then(r => setAudiences(r.data.audiences)).catch(() => setAudiences([])); }}>
            ↻ Recompute
          </button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 10px' }}>
          Lapsed = attended a past edition, graduation year {new Date().getFullYear()}+ (or unknown), has an email, not registered this year. Sorted by closest final deadline.
        </p>
        {!audiences ? <div className="no-data" style={{ padding: 16 }}>Computing audiences from registration history…</div>
          : audiences.length === 0 ? <div className="no-data" style={{ padding: 16 }}>No open events with matchable past editions found.</div> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr><th>Open event</th><th>Registered</th><th>Past editions</th><th>Lapsed</th><th>Early bird</th><th>Final</th><th>Template</th><th></th></tr></thead>
              <tbody>
                {audiences.map(a => (
                  <tr key={a.eventId}>
                    <td style={{ color: 'var(--text-1)', fontWeight: 500 }}>
                      {a.name}
                      {a.registered === 0 && <span className="badge" style={{ marginLeft: 6, fontSize: 9, background: 'rgba(239,68,68,0.12)', color: '#ef4444', padding: '2px 6px', borderRadius: 999 }}>empty</span>}
                    </td>
                    <td style={{ fontWeight: 600, color: a.registered ? 'var(--text-1)' : 'var(--text-4)' }}>{a.registered ?? '—'}</td>
                    <td style={{ fontSize: 12 }} title={a.past.map(p => `${p.name} — ${p.registered} registered`).join('\n')}>
                      {a.past.map(p => `${p.name.match(/20\d\d/)?.[0] || p.name} (${p.registered})`).join(', ')}
                    </td>
                    <td style={{ fontWeight: 700, color: a.lapsed > 0 ? 'var(--accent-2)' : 'var(--text-4)' }}>{a.lapsed ?? '—'}</td>
                    <td>{fmtD(a.deadlines?.earlyBird)}</td>
                    <td>{fmtD(a.deadlines?.finalDeadline)}</td>
                    <td>
                      <select className="field-input" style={{ fontSize: 12, maxWidth: 190 }} value={pick[a.eventId] || templates[0]?.id || ''}
                        onChange={e => setPick(p => ({ ...p, [a.eventId]: e.target.value }))}>
                        {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn-chart" style={{ marginRight: 4 }} disabled={!!busy[a.eventId] || !a.lapsed} onClick={() => send(a, true)}>
                        {busy[a.eventId] === 'test' ? '…' : '✉ Test'}
                      </button>
                      <button className="btn-action-green" disabled={!!busy[a.eventId] || !a.lapsed} onClick={() => send(a, false)}>
                        {busy[a.eventId] === 'send' ? 'Sending…' : `Send (${a.lapsed ?? 0})`}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Templates */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <h2 style={{ margin: 0 }}>Email templates</h2>
          <button className="btn-secondary" style={{ width: 'auto', margin: 0 }}
            onClick={() => setEditing({ id: `custom-${Date.now().toString(36)}`, name: 'New template', subject: '', body: '' })}>+ New template</button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '6px 0 10px' }}>
          Placeholders filled automatically at send time: <code>{'{{FIRST_NAME}}'}</code> <code>{'{{PAST_LEAGUE}}'}</code> (per person) · <code>{'{{TARGET_LEAGUE}}'}</code> <code>{'{{EB_DATE}}'}</code> <code>{'{{EB_PRICE}}'}</code> <code>{'{{FR_DATE}}'}</code> <code>{'{{FR_PRICE}}'}</code> <code>{'{{REGISTER_URL}}'}</code> (per league, from live deadline data)
        </p>
        <div style={{ display: 'grid', gap: 8 }}>
          {templates.map(t => (
            <div key={t.id} style={{ border: '1px solid var(--border-sub)', borderRadius: 10, padding: '10px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <div>
                  <b style={{ color: 'var(--text-1)' }}>{t.name}</b>
                  <div style={{ fontSize: 12, color: 'var(--text-3)' }}>Subject: {t.subject}</div>
                </div>
                <div style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn-chart" style={{ marginRight: 4 }} onClick={() => setEditing({ ...t })}>Edit</button>
                  <button className="btn-chart" onClick={() => { if (window.confirm(`Delete template "${t.name}"?`)) saveTemplates(templates.filter(x => x.id !== t.id)); }}>🗑</button>
                </div>
              </div>
              <pre style={{ fontSize: 11.5, color: 'var(--text-2)', whiteSpace: 'pre-wrap', margin: '8px 0 0', maxHeight: 90, overflow: 'hidden', fontFamily: 'inherit' }}>{t.body}</pre>
            </div>
          ))}
        </div>
        {editing && (
          <div style={{ marginTop: 14, border: '1px solid var(--accent)', borderRadius: 10, padding: 14 }}>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
              <input className="field-input" style={{ flex: 1, minWidth: 180 }} placeholder="Template name" value={editing.name} onChange={e => setEditing(x => ({ ...x, name: e.target.value }))} />
              <input className="field-input" style={{ flex: 2, minWidth: 240 }} placeholder="Email subject" value={editing.subject} onChange={e => setEditing(x => ({ ...x, subject: e.target.value }))} />
            </div>
            <textarea className="field-input" style={{ width: '100%', minHeight: 180, boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 13 }}
              placeholder={'Hi {{FIRST_NAME}},\n\n…'} value={editing.body} onChange={e => setEditing(x => ({ ...x, body: e.target.value }))} />
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn-primary" style={{ width: 'auto' }} onClick={() => {
                if (!editing.name || !editing.subject || !editing.body) return toast.error('Name, subject and body are all required');
                const others = templates.filter(x => x.id !== editing.id);
                saveTemplates([...others, editing]);
                setEditing(null);
              }}>Save template</button>
              <button className="btn-secondary" style={{ width: 'auto', margin: 0 }} onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* History + stats */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
          <h2 style={{ margin: 0 }}>Sent campaigns</h2>
          <button className="btn-secondary" style={{ width: 'auto', margin: 0 }} onClick={refreshStats} disabled={loadingStats}>
            {loadingStats ? 'Fetching from Mailchimp…' : '📊 Refresh open/click stats'}
          </button>
        </div>
        {history.length === 0 ? <div className="no-data" style={{ padding: 16 }}>Nothing sent yet.</div> : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead><tr><th>When</th><th>Event</th><th>Template</th><th>Recipients</th><th>Opens</th><th>Open rate</th><th>Clicks</th><th>Unsubs</th></tr></thead>
              <tbody>
                {history.map((c, i) => (
                  <tr key={i}>
                    <td>{String(c.at).replace('T', ' ').slice(0, 16)}</td>
                    <td style={{ color: 'var(--text-1)' }}>{c.eventName}</td>
                    <td>{c.templateName}</td>
                    <td>{c.recipients}</td>
                    <td>{c.stats?.opens ?? '—'}</td>
                    <td>{c.stats?.openRate != null ? `${Math.round(c.stats.openRate * 100)}%` : '—'}</td>
                    <td>{c.stats?.clicks ?? '—'}</td>
                    <td>{c.stats?.unsubs ?? '—'}</td>
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
