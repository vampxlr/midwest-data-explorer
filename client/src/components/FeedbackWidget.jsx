import React, { useEffect, useState } from 'react';
import { toast } from 'react-hot-toast';
import { api } from '../api.jsx';

/**
 * Floating feedback button (every signed-in page): report a bug or suggest a
 * feature — lands in the owner's Feedback inbox. Also auto-captures unhandled
 * client errors (rate-limited) so bugs are logged even when nobody reports them.
 */
let errorHookInstalled = false;
export function installErrorHook() {
  if (errorHookInstalled) return;
  errorHookInstalled = true;
  let sent = 0;
  const report = (message, stack) => {
    if (sent >= 5) return;                       // max 5 auto-reports per session
    sent++;
    api.reportError({ message, stack, page: window.location.pathname });
  };
  window.addEventListener('error', e => report(e.message, e.error?.stack));
  window.addEventListener('unhandledrejection', e =>
    report(String(e.reason?.message || e.reason || 'unhandled rejection'), e.reason?.stack));
}

export default function FeedbackWidget() {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState('bug');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { installErrorHook(); }, []);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.sendFeedback({ type, message, page: window.location.pathname });
      toast.success(type === 'bug' ? 'Bug reported — thank you!' : 'Feature idea sent — thank you!');
      setMessage(''); setOpen(false);
    } catch { toast.error('Could not send — try again'); }
    finally { setBusy(false); }
  }

  return (
    <>
      <button onClick={() => setOpen(o => !o)} title="Report a bug or suggest a feature"
        style={{
          position: 'fixed', right: 18, bottom: 18, zIndex: 900, width: 46, height: 46,
          borderRadius: '50%', border: '1px solid var(--border)', cursor: 'pointer',
          background: 'var(--surface-1)', color: 'var(--text-2)', fontSize: 20,
          boxShadow: '0 6px 20px rgba(0,0,0,0.25)',
        }}>💬</button>

      {open && (
        <form onSubmit={submit} style={{
          position: 'fixed', right: 18, bottom: 74, zIndex: 900, width: 320,
          background: 'var(--surface-1)', border: '1px solid var(--border)', borderRadius: 14,
          padding: 16, boxShadow: '0 16px 48px rgba(0,0,0,0.35)',
        }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
            {[['bug', '🐞 Report a bug'], ['feature', '💡 Suggest a feature']].map(([v, l]) => (
              <button key={v} type="button" onClick={() => setType(v)} style={{
                flex: 1, padding: '6px 4px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer',
                border: type === v ? '1px solid var(--accent-light)' : '1px solid var(--border)',
                background: type === v ? 'rgba(99,102,241,0.12)' : 'var(--bg-hover)',
                color: type === v ? 'var(--accent-light)' : 'var(--text-3)',
              }}>{l}</button>
            ))}
          </div>
          <textarea required value={message} onChange={e => setMessage(e.target.value)}
            placeholder={type === 'bug' ? 'What happened? What did you expect?' : 'What would make this app more useful for you?'}
            style={{
              width: '100%', minHeight: 90, resize: 'vertical', boxSizing: 'border-box',
              background: 'var(--bg-hover)', color: 'var(--text-1)', border: '1px solid var(--border)',
              borderRadius: 8, padding: 10, fontSize: 13, fontFamily: 'inherit',
            }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button type="submit" className="btn-primary" style={{ flex: 1 }} disabled={busy}>
              {busy ? 'Sending…' : 'Send'}
            </button>
            <button type="button" className="btn-secondary" style={{ width: 'auto', margin: 0 }} onClick={() => setOpen(false)}>Close</button>
          </div>
        </form>
      )}
    </>
  );
}
