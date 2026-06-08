/**
 * BootTerminal — shown during app startup instead of a plain spinner.
 * Connects to /api/boot/stream and renders a live terminal log.
 */
import React, { useEffect, useRef, useState } from 'react';
import { withToken } from '../api.jsx';

const LEVEL_COLOR = {
  info:     'var(--text-3)',
  ok:       '#22c55e',
  error:    '#ef4444',
  warn:     '#f97316',
  call:     '#60a5fa',
  response: '#a78bfa',
  save:     '#34d399',
  skip:     'var(--text-2)',
  wait:     'var(--text-4)',
};

export default function BootTerminal({ orgId = '8008', onReady }) {
  const [lines, setLines]     = useState([]);
  const [status, setStatus]   = useState('connecting'); // connecting | running | ready | error
  const [summary, setSummary] = useState(null);
  const bottomRef = useRef(null);

  useEffect(() => {
    const es = new EventSource(withToken(`/api/boot/stream?orgId=${orgId}`));

    es.addEventListener('log', e => {
      const entry = JSON.parse(e.data);
      setLines(prev => [...prev, entry]);
    });

    es.addEventListener('ready', e => {
      const data = JSON.parse(e.data);
      setSummary(data);
      setStatus('ready');
      es.close();
      // Small pause so user can see the "Ready" message before app renders
      setTimeout(() => onReady(data), 800);
    });

    es.addEventListener('error', e => {
      try {
        const d = JSON.parse(e.data);
        setLines(prev => [...prev, { ts: new Date().toLocaleTimeString(), msg: 'FATAL: ' + d.message, level: 'error' }]);
      } catch {}
      setStatus('error');
      es.close();
    });

    es.onopen  = () => setStatus('running');
    es.onerror = () => {
      setStatus('error');
      setLines(prev => [...prev, { ts: '', msg: 'Connection to server lost. Is the server running on port 3001?', level: 'error' }]);
      es.close();
    };

    return () => es.close();
  }, []);

  // Auto-scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  const statusColor =
    status === 'ready'      ? '#22c55e' :
    status === 'error'      ? '#ef4444' :
    status === 'connecting' ? '#f97316' : 'var(--accent-light)';

  const statusLabel =
    status === 'ready'      ? 'READY' :
    status === 'error'      ? 'ERROR' :
    status === 'connecting' ? 'CONNECTING' : 'INITIALIZING';

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: '#080a0f',
      display: 'flex', flexDirection: 'column',
      fontFamily: '"Cascadia Code","Fira Code","Consolas",monospace',
      zIndex: 9999,
    }}>
      {/* Title bar */}
      <div style={{
        background: 'var(--surface-3)', borderBottom: '1px solid var(--surface-1)',
        padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <div style={{ display: 'flex', gap: 6 }}>
          {['#ef4444','#f97316','#22c55e'].map(c => (
            <div key={c} style={{ width:12, height:12, borderRadius:'50%', background:c }} />
          ))}
        </div>
        <span style={{ color: 'var(--text-4)', fontSize: 13 }}>
          Midwest 3on3 Data Explorer — boot log
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {status !== 'ready' && status !== 'error' && (
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor, animation: 'pulse 1s infinite' }} />
          )}
          <span style={{ color: statusColor, fontSize: 12, fontWeight: 700 }}>{statusLabel}</span>
        </div>
      </div>

      {/* Terminal body */}
      <div style={{
        flex: 1, overflowY: 'auto', padding: '16px 20px',
        fontSize: 13, lineHeight: 1.7,
      }}>
        {lines.map((line, i) => (
          <div key={i} style={{ display: 'flex', gap: 12 }}>
            <span style={{ color:'#1e3a5f', flexShrink:0, userSelect:'none', minWidth:64 }}>{line.ts}</span>
            <span style={{ color: LEVEL_COLOR[line.level] || 'var(--text-3)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {line.msg}
            </span>
          </div>
        ))}

        {/* Blinking cursor while running */}
        {(status === 'connecting' || status === 'running') && (
          <div style={{ display: 'flex', gap: 12, marginTop: 2 }}>
            <span style={{ color: '#2d3748' }}>{new Date().toLocaleTimeString('en-US',{hour12:false})}</span>
            <span style={{ color: '#22c55e', animation: 'blink 1s step-end infinite' }}>█</span>
          </div>
        )}

        {/* Ready state */}
        {status === 'ready' && summary && (
          <div style={{
            marginTop: 16, background: '#0d1f0d', border: '1px solid #166534',
            borderRadius: 8, padding: '12px 16px',
          }}>
            <div style={{ color: '#22c55e', fontWeight: 700, marginBottom: 8 }}>✓ BOOT COMPLETE — launching app…</div>
            <div style={{ color: 'var(--text-3)', fontSize: 12 }}>
              {summary.recentEvents?.length} events loaded · {summary.storeResults} results in store
            </div>
          </div>
        )}

        {/* Error state */}
        {status === 'error' && (
          <div style={{
            marginTop: 16, background: '#1c0505', border: '1px solid #7f1d1d',
            borderRadius: 8, padding: '12px 16px',
          }}>
            <div style={{ color: '#ef4444', fontWeight: 700, marginBottom: 8 }}>✗ BOOT FAILED</div>
            <div style={{ color: 'var(--text-2)', fontSize: 12 }}>Make sure the API server is running: <code>cd server &amp;&amp; node index.js</code></div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Stats bar at bottom */}
      <div style={{
        background: 'var(--surface-3)', borderTop: '1px solid var(--surface-1)',
        padding: '8px 20px', fontSize: 11, color: 'var(--text-5)',
        display: 'flex', gap: 24,
      }}>
        <span>{lines.length} log lines</span>
        <span>org: {orgId}</span>
        <span>scope: all data</span>
      </div>

      <style>{`
        @keyframes pulse  { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes blink  { 0%,100%{opacity:1} 50%{opacity:0} }
      `}</style>
    </div>
  );
}
