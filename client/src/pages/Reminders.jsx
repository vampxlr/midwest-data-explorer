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
const TEST_EMAIL_KEY = 'reminders-test-email';

/**
 * Days-remaining line under a deadline. A passed deadline says so explicitly —
 * rendering nothing looks like missing data, and "is this still open?" is the
 * exact question this table exists to answer.
 */
function Countdown({ days, warnAt }) {
  if (days == null) return null;
  const [text, color] =
    days < 0 ? [`passed ${Math.abs(days)}d ago`, 'var(--text-4)']
    : days === 0 ? ['today', '#ef4444']
    : days === 1 ? ['tomorrow', '#ef4444']
    : [`in ${days} days`, days <= warnAt ? 'var(--accent-2)' : 'var(--text-4)'];
  return <div style={{ fontSize: 10, color, fontWeight: 700 }}>{text}</div>;
}

export default function Reminders() {
  const [audiences, setAudiences] = useState(null);
  const [templates, setTemplates] = useState([]);
  const [history, setHistory] = useState([]);
  const [pick, setPick] = useState({});        // eventId -> templateId
  const [busy, setBusy] = useState({});        // eventId -> 'test'|'send'
  const [editing, setEditing] = useState(null); // template being edited
  const [loadingStats, setLoadingStats] = useState(false);
  const [preview, setPreview] = useState(null); // {subject, html, name}
  const [clicks, setClicks] = useState(null);   // {clicks[], totals}
  const [loadingClicks, setLoadingClicks] = useState(false);

  async function loadClicks() {
    setLoadingClicks(true);
    try { setClicks((await api.reminderClicks()).data); }
    catch (err) { toast.error(err.response?.data?.error || 'Could not load clicks'); }
    finally { setLoadingClicks(false); }
  }

  // `ev` lets a row preview its OWN league. Without it every preview rendered
  // the first audience's prices and dates, which is misleading the moment two
  // leagues differ.
  async function showPreview(t, inline, ev) {
    try {
      const r = await api.previewReminder({
        templateId: t.id, eventId: ev?.eventId || audiences?.[0]?.eventId,
        ...(inline ? { template: { subject: t.subject, body: t.body, design: t.design || 'court', preheader: t.preheader, showPrices: t.showPrices } } : {}),
      });
      setPreview({ ...r.data, name: t.name, league: ev?.name || null });
    } catch (err) { toast.error(err.response?.data?.error || 'Preview failed'); }
  }

  useEffect(() => {
    api.reminderTemplates().then(r => setTemplates(r.data.templates)).catch(() => {});
    api.reminderHistory(false).then(r => setHistory(r.data.campaigns)).catch(() => {});
    api.reminderAudiences().then(r => setAudiences(r.data.audiences))
      .catch(err => { setAudiences([]); toast.error(err.response?.data?.error || 'Could not compute audiences'); });
  }, []);

  async function send(a, test) {
    const templateId = pick[a.eventId] || suggestion(a).id;
    if (!templateId) return toast.error('Pick a template first');
    let testEmail = null;
    if (test) {
      testEmail = window.prompt(
        'Send a test to which address(es)? Separate multiple with commas — only these addresses receive it, never real contacts.',
        localStorage.getItem(TEST_EMAIL_KEY) || '');
      if (!testEmail) return;
      localStorage.setItem(TEST_EMAIL_KEY, testEmail.trim());
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

  // Whole days from today to a YYYY-MM-DD deadline (negative = passed).
  const daysTo = (iso) => {
    if (!iso) return null;
    const t = new Date(); t.setHours(12, 0, 0, 0);
    return Math.round((new Date(iso + 'T12:00:00') - t) / 86400000);
  };

  // Which template this event is due for, from its own deadlines. Mirrors the
  // cadence the templates were written for: announce when it opens, nudge a
  // week before early-bird, last call two days before registration closes.
  function suggestion(a) {
    const eb = daysTo(a.deadlines?.earlyBird), fr = daysTo(a.deadlines?.finalDeadline);
    if (fr != null && fr >= 0 && fr <= 3) return { id: 'deadline-2-days', why: `closes in ${fr}d`, urgent: true };
    if (eb != null && eb >= 0 && eb <= 8) return { id: 'early-bird-week', why: `early-bird in ${eb}d`, urgent: true };
    if (eb != null && eb > 8) return { id: 'open-announcement', why: 'open, plenty of time', urgent: false };
    return { id: 'open-announcement', why: 'no upcoming deadline', urgent: false };
  }

  // An event already sent this exact template — don't nag the same families twice.
  const alreadySent = (eventId, templateId) =>
    history.some(c => String(c.eventId) === String(eventId) && c.templateId === templateId);

  const dueNow = (audiences || []).filter(a => a.lapsed > 0 && suggestion(a).urgent && !alreadySent(a.eventId, suggestion(a).id));
  const reach = dueNow.reduce((n, a) => n + (a.lapsed || 0), 0);

  return (
    <div>
      <div className="page-header">
        <h1>📣 Reminders</h1>
        <p>Win back last year's families: each open event is matched to its past editions, and everyone who played before (and hasn't graduated) but isn't registered this year can get a reminder — sent through Mailchimp into the Midwest Data Explorer audience</p>
      </div>

      {/* Action banner — what is actually due today */}
      {dueNow.length > 0 && (
        <div className="card" style={{ borderLeft: '4px solid var(--accent-2)' }}>
          <h2 style={{ margin: '0 0 4px' }}>⚡ {dueNow.length} league{dueNow.length > 1 ? 's' : ''} due for a reminder</h2>
          <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--text-3)' }}>
            Reaching <b style={{ color: 'var(--accent-2)' }}>{reach.toLocaleString()}</b> lapsed families. Based on each league's own deadlines, and hiding anything already sent.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {dueNow.map(a => (
              <span key={a.eventId} style={{ fontSize: 12, background: 'var(--surface-2)', border: '1px solid var(--border-sub)', borderRadius: 999, padding: '5px 11px' }}>
                {a.name.replace(/^20\d\d /, '').replace(/ 3 on 3.*/, '')} · <b>{a.lapsed}</b> · {suggestion(a).why}
              </span>
            ))}
          </div>
        </div>
      )}

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
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {fmtD(a.deadlines?.earlyBird)}
                      <Countdown days={daysTo(a.deadlines?.earlyBird)} warnAt={8} />
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {fmtD(a.deadlines?.finalDeadline)}
                      <Countdown days={daysTo(a.deadlines?.finalDeadline)} warnAt={3} />
                    </td>
                    <td>
                      {(() => { const s = suggestion(a); const sent = alreadySent(a.eventId, s.id); return (
                        <div style={{ fontSize: 10, marginBottom: 3, color: sent ? 'var(--text-4)' : s.urgent ? 'var(--accent-2)' : 'var(--text-4)', fontWeight: 700 }}>
                          {sent ? '✓ already sent' : s.urgent ? `▲ send now — ${s.why}` : s.why}
                        </div>); })()}
                      <select className="field-input" style={{ fontSize: 12, maxWidth: 190 }} value={pick[a.eventId] || suggestion(a).id}
                        onChange={e => setPick(p => ({ ...p, [a.eventId]: e.target.value }))}>
                        {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                      </select>
                      {/* Preview each of the three emails with THIS league's
                          own prices, dates and venue. */}
                      <div style={{ display: 'flex', gap: 4, marginTop: 5, alignItems: 'center' }}>
                        <span style={{ fontSize: 10, color: 'var(--text-4)' }}>👁</span>
                        {[['open-announcement', 'Open'], ['early-bird-week', 'EB'], ['deadline-2-days', 'Final']].map(([id, label]) => {
                          const t = templates.find(x => x.id === id);
                          return t ? (
                            <button key={id} className="btn-chart" style={{ fontSize: 10, padding: '2px 7px' }}
                              title={`Preview the ${label} email with ${a.name} data`}
                              onClick={() => showPreview(t, false, a)}>{label}</button>
                          ) : null;
                        })}
                      </div>
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
          Placeholders filled automatically at send time: <code>{'{{FIRST_NAME}}'}</code> <code>{'{{PAST_LEAGUE}}'}</code> (per person) · <code>{'{{TARGET_LEAGUE}}'}</code> <code>{'{{EB_DATE}}'}</code> <code>{'{{EB_PRICE}}'}</code> <code>{'{{FR_DATE}}'}</code> <code>{'{{FR_PRICE}}'}</code> <code>{'{{EVENT_DETAILS}}'}</code> <code>{'{{REGISTER_URL}}'}</code> (per league, from live deadline data)
          <br />The <b>Court</b> design draws its own When/Where card and price strip, so with it you can leave <code>{'{{EVENT_DETAILS}}'}</code> out entirely.
          Register buttons are rewritten through our click tracker automatically — you don't need <code>{'{{REGISTER_URL}}'}</code> in the body.
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
                  <span className="badge badge-purple" style={{ marginRight: 8, fontSize: 9 }}>{t.design || 'classic'}</span>
                  <button className="btn-chart" style={{ marginRight: 4 }} onClick={() => showPreview(t)}>👁 Preview</button>
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
              <select className="field-input" style={{ minWidth: 200 }} value={editing.design || 'court'} onChange={e => setEditing(x => ({ ...x, design: e.target.value }))}>
                <option value="court">🎨 Court — designed, price strip (default)</option>
                <option value="classic">🎨 Classic — white card, orange header</option>
                <option value="bold">🎨 Bold — dark header, big energy</option>
                <option value="minimal">🎨 Minimal — personal, hand-written feel</option>
              </select>
            </div>
            <input className="field-input" style={{ width: '100%', boxSizing: 'border-box', marginBottom: 8 }}
              placeholder="Preheader — the grey line shown next to the subject in the inbox"
              value={editing.preheader || ''} onChange={e => setEditing(x => ({ ...x, preheader: e.target.value }))} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-3)', marginBottom: 8 }}>
              <input type="checkbox" checked={editing.showPrices !== false} onChange={e => setEditing(x => ({ ...x, showPrices: e.target.checked }))} />
              Show the early-bird vs full-price strip (turn off for after-early-bird emails, where it would be wrong)
            </label>
            <textarea className="field-input" style={{ width: '100%', minHeight: 180, boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 13 }}
              placeholder={'Hi {{FIRST_NAME}},\n\n…'} value={editing.body} onChange={e => setEditing(x => ({ ...x, body: e.target.value }))} />
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn-secondary" style={{ width: 'auto', margin: 0 }} onClick={() => showPreview(editing, true)}>👁 Preview (with current edits)</button>
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

      {/* Email preview modal — real design, real league data, sample recipient */}
      {preview && (
        <div onClick={() => setPreview(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 9000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--surface-1)', borderRadius: 12, width: 'min(680px, 96vw)', maxHeight: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', border: '1px solid var(--border-sub)' }}>
            <div style={{ padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, borderBottom: '1px solid var(--border-sub)' }}>
              <div style={{ minWidth: 0 }}>
                <b style={{ color: 'var(--text-1)' }}>{preview.name}</b>
                {preview.league && <span style={{ fontSize: 12, color: 'var(--accent-2)', marginLeft: 8 }}>· {preview.league}</span>}
                <div style={{ fontSize: 12, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Subject: {preview.subject}</div>
              </div>
              <button className="btn-chart" onClick={() => setPreview(null)}>✕ Close</button>
            </div>
            <iframe title="email preview" srcDoc={preview.html} style={{ border: 'none', width: '100%', flex: 1, minHeight: 480, background: '#fff' }} />
          </div>
        </div>
      )}

      {/* Who clicked — per-person, from our own redirect tracker */}
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 6 }}>
          <h2 style={{ margin: 0 }}>🎯 Who clicked</h2>
          <button className="btn-secondary" style={{ width: 'auto', margin: 0 }} disabled={loadingClicks}
            onClick={loadClicks}>{loadingClicks ? 'Loading…' : '↻ Load click-throughs'}</button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '0 0 10px' }}>
          Mailchimp reports how many clicked; this reports <b>who</b>. Every button goes through our own redirect,
          which records the address and then forwards to the league page. The useful column is
          <b> Registered</b> — a family who clicked but hasn't registered is the warmest lead you have.
        </p>
        {!clicks ? <div className="no-data" style={{ padding: 16 }}>Not loaded. Click-throughs appear here once a campaign has gone out.</div>
          : clicks.clicks.length === 0 ? <div className="no-data" style={{ padding: 16 }}>No tracked clicks yet.</div> : (
          <>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
              {[['Unique clickers', clicks.totals.uniqueClickers], ['Total clicks', clicks.totals.totalClicks],
                ['Registered after clicking', clicks.totals.registeredAfterClick], ['Clicked, not registered', clicks.totals.warmNotRegistered],
                ['Unidentified', clicks.totals.unidentifiedClicks], ['Test clicks', clicks.totals.testClicks]].map(([k, v]) => (
                <div key={k} style={{ background: 'var(--surface-2)', border: '1px solid var(--border-sub)', borderRadius: 10, padding: '10px 16px', minWidth: 130 }}>
                  <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{k}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-1)' }}>{v}</div>
                </div>
              ))}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="data-table">
                <thead><tr><th>Email</th><th>Clicks</th><th>First click</th><th>Last click</th><th>Registered?</th></tr></thead>
                <tbody>
                  {clicks.clicks.map((c, i) => (
                    <tr key={i}>
                      <td style={{ color: 'var(--text-1)' }}>{c.email}</td>
                      <td>{c.clicks}</td>
                      <td style={{ fontSize: 12 }}>{String(c.firstAt).replace('T', ' ').slice(0, 16)}</td>
                      <td style={{ fontSize: 12 }}>{String(c.lastAt).replace('T', ' ').slice(0, 16)}</td>
                      <td>{c.registered
                        ? <span className="badge" style={{ background: 'rgba(34,197,94,0.14)', color: '#22c55e', padding: '2px 8px', borderRadius: 999, fontSize: 10 }}>registered</span>
                        : <span className="badge" style={{ background: 'rgba(234,88,12,0.14)', color: 'var(--accent-2)', padding: '2px 8px', borderRadius: 999, fontSize: 10 }}>warm lead</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
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
