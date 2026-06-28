import React, { useState } from 'react';

// Generic collapsed-by-default section used to tuck advanced/console-style
// panels out of the way at the bottom of a page.
export default function Collapsible({ title, subtitle, defaultOpen = false, badge, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card" style={{ marginTop:20 }}>
      <button onClick={() => setOpen(o => !o)} style={{
        width:'100%', display:'flex', alignItems:'center', justifyContent:'space-between',
        background:'none', border:'none', cursor:'pointer', padding:0, textAlign:'left',
      }}>
        <div>
          <h3 style={{ margin:0, fontSize:14, color:'var(--text-2)' }}>
            {title}{badge != null && <span style={{
              marginLeft:8, fontSize:11, fontWeight:700, color:'var(--accent-light)',
              background:'var(--chip-bg)', borderRadius:10, padding:'1px 8px',
            }}>{badge}</span>}
          </h3>
          {subtitle && <p style={{ margin:'2px 0 0', fontSize:12, color:'var(--text-4)' }}>{subtitle}</p>}
        </div>
        <span style={{ fontSize:13, color:'var(--text-4)', flexShrink:0, marginLeft:12 }}>
          {open ? '▲ Collapse' : '▼ Expand'}
        </span>
      </button>
      {open && <div style={{ marginTop:14 }}>{children}</div>}
    </div>
  );
}
