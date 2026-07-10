import React from 'react';

const BAR_COLOR = {
  idle: 'var(--text-5)', planning: 'var(--accent-2)', discovering: 'var(--accent-2)',
  fetching: 'var(--viz-1)', done: 'var(--viz-up)', error: 'var(--viz-down)',
};

// Quick-glance header: just a button + thin progress bar. Pairs with
// useSmartUpdate() — pass its return value straight through as props.
// While the pre-flight SE check runs (no total yet) the bar animates
// indeterminately and echoes the latest console line so it never looks stuck.
export default function SmartUpdateBar({ running, phase, pct, current, total, added, skipped, errors, start, stop, log }) {
  const barColor = BAR_COLOR[phase] || 'var(--text-5)';
  const indeterminate = running && total === 0;
  const lastLog = log && log.length ? log[log.length - 1] : null;

  return (
    <div className="card" style={{ marginBottom:16, padding:'14px 18px' }}>
      <style>{`@keyframes suSlide { from { background-position: 0 0; } to { background-position: 44px 0; } }`}</style>
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
            {indeterminate ? (
              <div style={{
                width:'100%', height:'100%', borderRadius:8, opacity:0.85,
                background:`repeating-linear-gradient(45deg, ${barColor} 0 12px, transparent 12px 22px)`,
                backgroundSize:'44px 100%', animation:'suSlide 0.9s linear infinite',
              }}/>
            ) : (
              <div style={{
                width:`${running ? pct : (phase==='done' ? 100 : 0)}%`, height:'100%', borderRadius:8,
                background: phase==='done' && !running ? 'var(--viz-up)' : barColor, transition:'width 0.4s ease',
              }}/>
            )}
          </div>
        </div>

        <span style={{ fontSize:12, color:barColor, fontWeight:700, whiteSpace:'nowrap' }}>
          {phase==='idle'     && 'Ready'}
          {phase==='planning' && 'Checking SportsEngine…'}
          {phase==='discovering' && 'Planning…'}
          {phase==='fetching' && `${current}/${total} — ${pct}%`}
          {phase==='done'     && !running && `Done — ${added} new`}
        </span>
      </div>
      {running && lastLog && (
        <div style={{ marginTop:7, fontSize:11.5, color:'var(--text-3)', fontFamily:'ui-monospace, monospace',
          whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
          <span style={{ color:'var(--text-4)' }}>{lastLog.ts} </span>{lastLog.msg}
        </div>
      )}
      {(skipped>0 || errors>0) && phase!=='idle' && (
        <div style={{ marginTop:6, fontSize:11, color:'var(--text-4)' }}>
          {skipped>0 && <span>{skipped} skipped</span>}
          {skipped>0 && errors>0 && <span> · </span>}
          {errors>0 && <span style={{color:'var(--viz-down)'}}>{errors} errors</span>}
        </div>
      )}
    </div>
  );
}
