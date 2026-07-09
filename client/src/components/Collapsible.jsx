import React, { useState } from 'react';

// Generic collapsed-by-default section used to tuck advanced/console-style
// panels out of the way at the bottom of a page.
// `right` renders extra controls (toggles etc.) in the header without
// triggering collapse when clicked. `style` overrides the card style.
export default function Collapsible({ title, subtitle, defaultOpen = false, badge, right, style, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card" style={{ marginTop:20, ...style }}>
      <div onClick={() => setOpen(o => !o)} role="button" tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setOpen(o => !o); }}
        style={{
          width:'100%', display:'flex', alignItems:'center', justifyContent:'space-between',
          gap:10, cursor:'pointer', textAlign:'left',
        }}>
        <div style={{ minWidth:0 }}>
          <h3 style={{ margin:0, fontSize:14, color:'var(--text-2)' }}>
            {title}{badge != null && <span style={{
              marginLeft:8, fontSize:11, fontWeight:700, color:'var(--accent-light)',
              background:'var(--chip-bg)', borderRadius:10, padding:'1px 8px',
            }}>{badge}</span>}
          </h3>
          {subtitle && <p style={{ margin:'2px 0 0', fontSize:12, color:'var(--text-4)' }}>{subtitle}</p>}
        </div>
        <span style={{ display:'inline-flex', alignItems:'center', gap:10, flexShrink:0, marginLeft:12 }}>
          {right && <span onClick={e => e.stopPropagation()} style={{ display:'inline-flex', gap:8, alignItems:'center' }}>{right}</span>}
          <span style={{ display:'inline-flex', alignItems:'center', gap:6, fontSize:12, color:'var(--text-4)' }}>
            {open ? 'Collapse' : 'Expand'}
            <span style={{ display:'inline-block', transition:'transform 0.18s ease', transform: open ? 'rotate(180deg)' : 'none', fontSize:10 }}>▼</span>
          </span>
        </span>
      </div>
      {open && <div style={{ marginTop:14 }}>{children}</div>}
    </div>
  );
}
