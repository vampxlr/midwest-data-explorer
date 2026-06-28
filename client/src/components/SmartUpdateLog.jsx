import React from 'react';

// Terminal-style log body for a useSmartUpdate() run. Meant to live inside
// a <Collapsible/> at the bottom of the page — pass the hook's `log` array.
export default function SmartUpdateLog({ log = [] }) {
  return (
    <div style={{
      background:'var(--surface-3)', borderRadius:8, padding:10, maxHeight:260,
      overflowY:'auto', fontFamily:'monospace', fontSize:11,
    }}>
      {log.length === 0
        ? <span style={{ color:'var(--text-5)' }}>No log entries yet — run Smart Update above to see live progress here.</span>
        : log.map((entry, i) => (
          <div key={i} style={{
            color: entry.level==='error' ? '#ef4444' : entry.level==='warn' ? '#f97316' : entry.level==='ok' ? '#22c55e' : 'var(--text-3)',
            marginBottom:2, lineHeight:1.5,
          }}>
            <span style={{ color:'var(--text-5)', marginRight:6 }}>{entry.ts?.slice?.(11,19) || entry.ts || ''}</span>{entry.msg}
          </div>
        ))}
    </div>
  );
}
