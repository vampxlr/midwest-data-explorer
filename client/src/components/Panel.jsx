import React, { useState } from 'react';

const PREFIX = 'mw3-panel-open:';

function usePanelOpen(key, defaultOpen) {
  const [open, setOpen] = useState(() => {
    if (!key) return defaultOpen;
    try {
      const v = localStorage.getItem(key);
      return v === null ? defaultOpen : v === '1';
    } catch { return defaultOpen; }
  });
  function toggle() {
    setOpen(o => {
      const next = !o;
      if (key) { try { localStorage.setItem(key, next ? '1' : '0'); } catch {} }
      return next;
    });
  }
  return [open, toggle];
}

/**
 * Collapsible card panel — the standard wrapper for every major content
 * section app-wide. State persists per `id` across reloads, default OPEN.
 *
 * Two modes:
 *  - Structured (pass `title`): renders a header row with title/subtitle/
 *    right-side extras and a chevron button, body below.
 *  - Wrap-as-is (no `title`): keeps existing card markup completely
 *    untouched and adds a small round toggle tab on the top-right corner of
 *    the card border — the fast retrofit for cards with their own bespoke
 *    headers (stat rows, buttons, etc.) where restructuring isn't worth it.
 */
export default function Panel({ id, title, subtitle, right, defaultOpen = true, badge, className = 'card', style, bodyStyle, children, ...rest }) {
  const key = id ? PREFIX + id : null;
  const [open, toggle] = usePanelOpen(key, defaultOpen);

  if (!title) {
    return (
      <div className={className} style={{ position:'relative', ...(open ? style : { ...style, paddingBottom:10, paddingTop:10 }) }} {...rest}>
        <button onClick={toggle} aria-label={open ? 'Collapse' : 'Expand'} title={open ? 'Collapse' : 'Expand'}
          style={{
            position:'absolute', top:0, right:20, transform:'translateY(-50%)', zIndex:2,
            background:'var(--bg-card)', border:'1px solid var(--border)', borderRadius:999,
            width:24, height:24, display:'flex', alignItems:'center', justifyContent:'center',
            cursor:'pointer', color:'var(--text-3)', padding:0, boxShadow:'var(--shadow-sm)',
          }}>
          <span style={{ display:'inline-block', fontSize:9, transition:'transform 0.18s ease', transform: open ? 'rotate(180deg)' : 'none' }}>▼</span>
        </button>
        {open && children}
      </div>
    );
  }

  return (
    <div className={className} style={style} {...rest}>
      <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:10, marginBottom: open ? 16 : 0 }}>
        <div style={{ minWidth:0, flex:1, cursor:'pointer' }} onClick={toggle}>
          {typeof title === 'string' ? (
            <h2 style={{ margin:0, display:'flex', alignItems:'center', gap:8 }}>
              {title}
              {badge != null && (
                <span style={{
                  fontSize:11, fontWeight:700, color:'var(--accent-light)',
                  background:'var(--chip-bg)', borderRadius:10, padding:'1px 8px',
                }}>{badge}</span>
              )}
            </h2>
          ) : title}
          {subtitle && <p style={{ margin:'4px 0 0', fontSize:12, color:'var(--text-3)', lineHeight:1.5 }}>{subtitle}</p>}
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:8, flexShrink:0 }}>
          {right}
          <button onClick={toggle} aria-label={open ? 'Collapse' : 'Expand'} title={open ? 'Collapse' : 'Expand'}
            style={{
              background:'var(--bg-hover)', border:'1px solid var(--border)', borderRadius:8,
              width:26, height:26, display:'flex', alignItems:'center', justifyContent:'center',
              cursor:'pointer', color:'var(--text-3)', flexShrink:0, padding:0,
            }}>
            <span style={{ display:'inline-block', fontSize:10, transition:'transform 0.18s ease', transform: open ? 'rotate(180deg)' : 'none' }}>▼</span>
          </button>
        </div>
      </div>
      {open && <div style={bodyStyle}>{children}</div>}
    </div>
  );
}
