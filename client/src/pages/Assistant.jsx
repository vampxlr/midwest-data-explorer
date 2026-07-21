import React, { useEffect, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';
import { api } from '../api.jsx';

/**
 * 🤖 Sarah — the AI registration assistant that lives on midwest3on3.com.
 * Configure her persona + API key, build the site knowledge base, copy the
 * one-line embed snippet, test-chat with her, and review conversations/leads.
 */
export default function Assistant() {
  const [cfg, setCfg] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const [geminiKey, setGeminiKey] = useState('');
  const [mcKey, setMcKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [inbox, setInbox] = useState(null);
  const [tab, setTab] = useState('leads');

  const [loadErr, setLoadErr] = useState(null);
  const load = () => api.getAssistant().then(r => setCfg(r.data))
    .catch(err => setLoadErr(err.response?.status === 403
      ? 'Your account does not have admin access for this page — if you were recently promoted, sign out and sign back in to refresh your session.'
      : (err.response?.data?.error || 'Could not load assistant settings — try refreshing.')));
  useEffect(() => { load(); api.getAssistantConvos().then(r => setInbox(r.data)).catch(() => {}); }, []);
  if (loadErr && !cfg) return <div className="no-data" style={{ padding: 20 }}>⚠ {loadErr}</div>;
  if (!cfg) return <div className="no-data" style={{ padding: 20 }}>Loading…</div>;
  const upd = (patch) => setCfg(c => ({ ...c, ...patch }));

  async function save() {
    setBusy(true);
    try {
      await api.saveAssistant({
        name: cfg.name, greeting: cfg.greeting, model: cfg.model, accent: cfg.accent,
        extraInstructions: cfg.extraInstructions, kbDocUrl: cfg.kbDocUrl || '', leadNotifyEmail: cfg.leadNotifyEmail || '',
        mailchimpListId: cfg.mailchimpListId || '',
        ...(mcKey.trim() ? { mailchimpKey: mcKey.trim() } : {}),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(geminiKey.trim() ? { geminiKey: geminiKey.trim() } : {}),
      });
      setApiKey(''); setGeminiKey('');
      toast.success('Assistant settings saved');
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Save failed'); }
    finally { setBusy(false); }
  }

  async function rebuild() {
    setRebuilding(true);
    try {
      const r = await api.rebuildAssistantKb();
      toast.success(`Knowledge base rebuilt — ${r.data.pages} pages, ${(r.data.chars / 1000).toFixed(0)}k characters`);
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Rebuild failed'); }
    finally { setRebuilding(false); }
  }

  return (
    <div>
      <div className="page-header">
        <h1>🤖 {cfg.name} — Site Assistant</h1>
        <p>An AI chat agent for midwest3on3.com — answers from the site's content plus LIVE league data (deadlines, prices, open status), and captures leads into Meta</p>
      </div>

      {/* Status + embed */}
      <div className="card">
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 14 }}>
          <Status ok={cfg.model?.startsWith('gemini') ? cfg.hasGeminiKey : cfg.hasApiKey}
            okText={`AI connected (${cfg.model?.startsWith('gemini') ? 'Gemini' : 'Claude'})`}
            badText={`No ${cfg.model?.startsWith('gemini') ? 'Gemini' : 'Anthropic'} key for the selected model — assistant offline`} />
          <Status ok={!!cfg.kb} okText={cfg.kb ? `Knowledge base: ${cfg.kb.pages} pages` : ''} badText="Knowledge base not built yet" />
        </div>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-3)', marginBottom: 6 }}>
          Paste this ONE line into the website (Squarespace: Settings → Advanced → Code Injection → Footer):
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <code style={{ fontSize: 11, background: 'var(--bg-hover)', padding: '8px 12px', borderRadius: 8, wordBreak: 'break-all', flex: 1, minWidth: 260 }}>{cfg.embed}</code>
          <button className="btn-secondary" style={{ width: 'auto', margin: 0 }}
            onClick={() => navigator.clipboard.writeText(cfg.embed).then(() => toast.success('Embed snippet copied'))}>📋 Copy</button>
        </div>
      </div>

      {/* Settings */}
      <div className="card">
        <h2>Persona & AI settings</h2>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
          <Field label="Assistant name">
            <input className="field-input" style={{ width: 130 }} value={cfg.name} onChange={e => upd({ name: e.target.value })} />
          </Field>
          <Field label={`Anthropic API key ${cfg.hasApiKey ? '(saved)' : '— console.anthropic.com'}`}>
            <input className="field-input" type="password" style={{ width: 230 }} value={apiKey}
              placeholder={cfg.hasApiKey ? '••••••••  (unchanged)' : 'sk-ant-…'}
              onChange={e => setApiKey(e.target.value)} />
          </Field>
          <Field label={`Gemini API key ${cfg.hasGeminiKey ? '(saved)' : '— aistudio.google.com (free tier)'}`}>
            <input className="field-input" type="password" style={{ width: 230 }} value={geminiKey}
              placeholder={cfg.hasGeminiKey ? '••••••••  (unchanged)' : 'AIza…'}
              onChange={e => setGeminiKey(e.target.value)} />
          </Field>
          <Field label="Model (needs the matching key above)">
            <select className="field-input" value={cfg.model} onChange={e => upd({ model: e.target.value })}>
              <option value="claude-haiku-4-5-20251001">Claude Haiku 4.5 — fast & cheap</option>
              <option value="claude-sonnet-5">Claude Sonnet 5 — smarter, pricier</option>
              <option value="gemini-flash-lite-latest">Gemini Flash-Lite — best free-tier limits (15/min)</option>
              <option value="gemini-flash-latest">Gemini Flash (latest) — free tier ~20/day</option>
              <option value="gemini-2.5-flash">Gemini 2.5 Flash — older keys only</option>
            </select>
          </Field>
          <Field label="Accent color">
            <input type="color" className="field-input" style={{ width: 60, padding: 2, height: 34 }} value={cfg.accent} onChange={e => upd({ accent: e.target.value })} />
          </Field>
        </div>
        <Field label="Greeting (first message visitors see)">
          <textarea className="field-input" style={{ width: '100%', minHeight: 54, boxSizing: 'border-box' }} value={cfg.greeting} onChange={e => upd({ greeting: e.target.value })} />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
          <Field label={cfg.hasMailchimp ? 'Mailchimp API key (saved ✓ — paste to replace)' : 'Mailchimp API key (optional — leads auto-added to your audience)'}>
            <input className="field-input" style={{ width: '100%', boxSizing: 'border-box' }} type="password" value={mcKey} onChange={e => setMcKey(e.target.value)} placeholder={cfg.hasMailchimp ? '••••••••' : 'xxxxxxxx-us21'} />
          </Field>
          <Field label="Mailchimp Audience ID (Mailchimp → Audience → Settings)">
            <input className="field-input" style={{ width: '100%', boxSizing: 'border-box' }} value={cfg.mailchimpListId || ''} onChange={e => upd({ mailchimpListId: e.target.value })} placeholder="e.g. a1b2c3d4e5" />
          </Field>
        </div>
        <div style={{ marginTop: 10 }}>
          <Field label={`Lead notification email (optional — get an email each time a visitor leaves their contact)${cfg.emailConfigured ? '' : ' — ⚠ email sending is off until RESEND_API_KEY is set on the server'}`}>
            <input className="field-input" style={{ width: '100%', boxSizing: 'border-box' }} value={cfg.leadNotifyEmail || ''} onChange={e => upd({ leadNotifyEmail: e.target.value })} placeholder="you@example.com" />
          </Field>
        </div>
        <div style={{ marginTop: 10 }}>
          <Field label="Knowledge doc URL (optional — a Google Doc with policies/FAQs; set sharing to 'Anyone with the link'. Re-fetched on every KB rebuild)">
            <input className="field-input" style={{ width: '100%', boxSizing: 'border-box' }} value={cfg.kbDocUrl || ''} onChange={e => upd({ kbDocUrl: e.target.value })} placeholder="https://docs.google.com/document/d/…" />
          </Field>
        </div>
        <div style={{ marginTop: 10 }}>
          <Field label="Extra instructions for the assistant (optional — e.g. current promos, tone, things to push)">
            <textarea className="field-input" style={{ width: '100%', minHeight: 54, boxSizing: 'border-box' }} value={cfg.extraInstructions} onChange={e => upd({ extraInstructions: e.target.value })} placeholder="e.g. This month, emphasize the fall leagues — early bird ends soon." />
          </Field>
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn-primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button>
          <button className="btn-secondary" style={{ width: 'auto', margin: 0 }} onClick={rebuild} disabled={rebuilding}>
            {rebuilding ? '🌐 Scraping midwest3on3.com…' : '🌐 Rebuild knowledge base'}
          </button>
          {cfg.kb && <span style={{ fontSize: 11, color: 'var(--text-4)' }}>
            KB built {String(cfg.kb.builtAt).replace('T', ' ').slice(0, 16)} · {cfg.kb.pages} pages{cfg.kb.docChars ? ` + owner doc (${(cfg.kb.docChars / 1000).toFixed(0)}k)` : ''} · {(cfg.kb.chars / 1000).toFixed(0)}k chars
          </span>}
        </div>
      </div>

      {/* Test chat */}
      <TestChat embed={cfg.embed} name={cfg.name}
        hasApiKey={cfg.model?.startsWith('gemini') ? cfg.hasGeminiKey : cfg.hasApiKey} />

      {/* Inbox */}
      <div className="card">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          <h2 style={{ margin: 0 }}>Inbox</h2>
          {[['leads', `🎯 Leads (${inbox?.leads?.length ?? 0})`], ['convos', `💬 Conversations (${inbox?.convos?.length ?? 0})`]].map(([v, l]) => (
            <button key={v} onClick={() => setTab(v)} className={tab === v ? 'btn-primary' : 'btn-secondary'}
              style={{ width: 'auto', margin: 0, padding: '4px 14px', fontSize: 12 }}>{l}</button>
          ))}
        </div>
        {!inbox ? <div className="no-data">Loading…</div> : tab === 'leads' ? (
          inbox.leads.length === 0 ? <div className="no-data" style={{ padding: 16 }}>No leads captured yet — when a visitor shares an email or phone in chat, it lands here (and fires a Meta CAPI Lead event).</div> : (
            <div style={{ display: 'grid', gap: 6, maxHeight: 360, overflowY: 'auto' }}>
              {inbox.leads.map((l, i) => (
                <div key={i} style={{ border: '1px solid var(--border-sub)', borderRadius: 8, padding: '8px 12px', fontSize: 12.5 }}>
                  <b>{l.email || l.phone}</b>
                  <span style={{ color: 'var(--text-4)' }}> · {String(l.at).replace('T', ' ').slice(0, 16)}{l.page ? ` · ${l.page.replace(/^https?:\/\/[^/]+/, '')}` : ''}</span>
                  <div style={{ color: 'var(--text-3)', fontSize: 11.5, marginTop: 3 }}>{l.context}</div>
                </div>
              ))}
            </div>
          )
        ) : (
          inbox.convos.length === 0 ? <div className="no-data" style={{ padding: 16 }}>No conversations yet.</div> : (
            <div style={{ display: 'grid', gap: 6, maxHeight: 360, overflowY: 'auto' }}>
              {inbox.convos.map((c, i) => (
                <div key={i} style={{ border: '1px solid var(--border-sub)', borderRadius: 8, padding: '8px 12px', fontSize: 12.5 }}>
                  <div style={{ color: 'var(--text-4)', fontSize: 11 }}>{String(c.at).replace('T', ' ').slice(0, 16)} · session {c.sessionId?.slice(0, 8)}{c.page ? ` · ${String(c.page).replace(/^https?:\/\/[^/]+/, '')}` : ''}</div>
                  <div style={{ marginTop: 3 }}><b>Q:</b> {c.q}</div>
                  <div style={{ color: 'var(--text-2)', marginTop: 2 }}><b>A:</b> {c.a}</div>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'block' }}>
      <span className="field-label" style={{ display: 'block', marginBottom: 4 }}>{label}</span>
      {children}
    </label>
  );
}

function Status({ ok, okText, badText }) {
  return (
    <span style={{
      fontSize: 12, fontWeight: 700, padding: '4px 14px', borderRadius: 999,
      background: ok ? 'rgba(34,197,94,0.12)' : 'rgba(245,158,11,0.12)',
      color: ok ? 'var(--viz-up)' : '#f59e0b',
    }}>{ok ? `✓ ${okText}` : `⚠ ${badText}`}</span>
  );
}

// Bare URLs in replies become clickable, exactly like the site widget does
function linkify(text, role) {
  const parts = String(text).split(/(https?:\/\/[^\s]+)/g);
  return parts.map((p, i) => /^https?:\/\//.test(p)
    ? <a key={i} href={p} target="_blank" rel="noopener noreferrer"
        style={{ color: role === 'user' ? '#fff' : 'var(--accent-light)', textDecoration: 'underline', wordBreak: 'break-all' }}>{p}</a>
    : p);
}

// Try Sarah right here — uses the same public endpoint the site widget calls
function TestChat({ embed, name, hasApiKey }) {
  const key = (embed.match(/key=([^"&]+)/) || [])[1] || '';
  const [hist, setHist] = useState([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [hist]);

  async function send(e) {
    e.preventDefault();
    const text = q.trim();
    if (!text || busy) return;
    setQ('');
    const next = [...hist, { role: 'user', content: text }];
    setHist(next);
    setBusy(true);
    try {
      const r = await api.assistantChat({ key, sessionId: 'admin-test', page: 'admin-test', messages: next.slice(-12) });
      setHist(h => [...h, { role: 'assistant', content: r.data.reply }]);
    } catch (err) {
      setHist(h => [...h, { role: 'assistant', content: err.response?.data?.reply || 'Error — check the API key and try again.' }]);
    } finally { setBusy(false); }
  }

  return (
    <div className="card">
      <h2>Test {name} here</h2>
      {!hasApiKey && <p style={{ fontSize: 12, color: '#f59e0b', margin: '4px 0 10px' }}>⚠ No API key yet — she'll reply with the offline message until one is saved above.</p>}
      <div style={{ background: 'var(--bg-hover)', borderRadius: 10, padding: 12, minHeight: 120, maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {hist.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--text-4)' }}>Ask something a parent would — "how much is the Woodbury league?", "when does early bird end for Andover?", "what age groups can play?"</div>}
        {hist.map((m, i) => (
          <div key={i} style={{
            alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start', maxWidth: '80%',
            background: m.role === 'user' ? 'var(--accent)' : 'var(--surface-1)',
            color: m.role === 'user' ? '#fff' : 'var(--text-1)',
            border: m.role === 'user' ? 'none' : '1px solid var(--border-sub)',
            borderRadius: 12, padding: '7px 12px', fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}>{linkify(m.content, m.role)}</div>
        ))}
        {busy && <div style={{ fontSize: 12, color: 'var(--text-4)' }}>…</div>}
        <div ref={endRef} />
      </div>
      <form onSubmit={send} style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <input className="field-input" style={{ flex: 1 }} value={q} onChange={e => setQ(e.target.value)}
          placeholder="Type a test question…" maxLength={500} />
        <button className="btn-primary" type="submit" disabled={busy}>Send</button>
      </form>
    </div>
  );
}
