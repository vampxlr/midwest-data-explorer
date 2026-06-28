import React from 'react';

const BAR_COLOR = {
  idle: 'var(--text-5)', planning: '#f97316', discovering: '#f97316',
  fetching: '#3b82f6', done: '#22c55e', error: '#ef4444',
};

// Quick-glance header: just a button + thin progress bar. Pairs with
// useSmartUpdate() — pass its return value straight through as props.
export default function SmartUpdateBar({ running, phase, pct, current, total, added, skipped, errors, start, stop }) {
  const barColor = BAR_COLOR[phase] || 'var(--text-5)';

  return (
    <div className="card" style={{ marginBottom:16, padding:'14px 18px' }}>
      <div style={{ display:'flex', alignItems:'center', gap:14, flexWrap:'wrap' }}>
        {!running ? (
          <button className="btn-primary" onClick={start} style={{ flexShrink:0 }}>
            ⚡ Smart Update
          </button>
        ) : (
          <button disabled className="btn-primary" style={{ flexShrink:0, background:'var(--chip-bg)', cursor:'not-allowed' }}>
            ⏳ Updating…
          </button>
        )}
        {running && (
          <button onClick={stop} style={{
            flexShrink:0, padding:'8px 14px', background:'rgba(239,68,68,0.12)', color:'var(--danger-text)',
            border:'none', borderRadius:6, cursor:'pointer', fontSize:12, fontWeight:700,
          }}>⏹ Stop</button>
        )}

        <div style={{ flex:1, minWidth:160 }}>
          <div style={{ background:'var(--surface-1)', borderRadius:8, height:8, overflow:'hidden' }}>
            <div style={{
              width:`${running ? pct : (phase==='done' ? 100 : 0)}%`, height:'100%', borderRadius:8,
              background: phase==='done' && !running ? '#22c55e' : barColor, transition:'width 0.4s ease',
            }}/>
          </div>
        </div>

        <span style={{ fontSize:12, color:barColor, fontWeight:700, whiteSpace:'nowrap' }}>
          {phase==='idle'     && 'Ready'}
          {phase==='planning' && 'Planning…'}
          {phase==='fetching' && `${current}/${total} — ${pct}%`}
          {phase==='done'     && !running && `Done — ${added} new`}
        </span>
      </div>
      {(skipped>0 || errors>0) && phase!=='idle' && (
        <div style={{ marginTop:6, fontSize:11, color:'var(--text-4)' }}>
          {skipped>0 && <span>{skipped} skipped</span>}
          {skipped>0 && errors>0 && <span> · </span>}
          {errors>0 && <span style={{color:'#ef4444'}}>{errors} errors</span>}
        </div>
      )}
    </div>
  );
}
