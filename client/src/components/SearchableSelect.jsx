import React, { useEffect, useRef, useState } from 'react';

/**
 * props:
 *   value      – currently selected value string
 *   onChange   – fn(value) called on selection
 *   options    – [{ value, label }]
 *   placeholder – string shown when nothing selected
 *   style      – optional wrapper style overrides
 *   disabled   – bool
 */
export default function SearchableSelect({ value, onChange, options = [], placeholder = 'Select…', style, disabled }) {
  const [open,   setOpen]   = useState(false);
  const [query,  setQuery]  = useState('');
  const [cursor, setCursor] = useState(-1);
  const wrapRef  = useRef(null);
  const inputRef = useRef(null);
  const listRef  = useRef(null);

  const selected = options.find(o => String(o.value) === String(value));

  const filtered = query.trim()
    ? options.filter(o => o.label.toLowerCase().includes(query.toLowerCase()))
    : options;

  function openMenu() {
    if (disabled) return;
    setOpen(true);
    setQuery('');
    setCursor(-1);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  function closeMenu() {
    setOpen(false);
    setQuery('');
    setCursor(-1);
  }

  function pick(opt) {
    onChange(opt.value);
    closeMenu();
  }

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handler(e) {
      if (!wrapRef.current?.contains(e.target)) closeMenu();
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Keyboard navigation
  function onKeyDown(e) {
    if (e.key === 'Escape') { closeMenu(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor(c => Math.min(c + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor(c => Math.max(c - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (cursor >= 0 && filtered[cursor]) pick(filtered[cursor]);
    }
  }

  // Scroll active item into view
  useEffect(() => {
    if (cursor < 0 || !listRef.current) return;
    const item = listRef.current.children[cursor];
    item?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  return (
    <div ref={wrapRef} style={{ position: 'relative', ...style }}>
      {/* Trigger */}
      <div
        onClick={openMenu}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          background: 'var(--surface-1)', border: `1px solid ${open ? '#3b82f6' : 'var(--line)'}`,
          borderRadius: 6, padding: '6px 10px', fontSize: 13, cursor: disabled ? 'not-allowed' : 'pointer',
          color: selected ? 'var(--text-1)' : 'var(--text-3)', userSelect: 'none',
          opacity: disabled ? 0.5 : 1, minHeight: 34,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
          {selected ? selected.label : placeholder}
        </span>
        <span style={{ color: 'var(--text-4)', fontSize: 10, marginLeft: 8, flexShrink: 0 }}>
          {open ? '▲' : '▼'}
        </span>
      </div>

      {/* Dropdown */}
      {open && (
        <div style={{
          position: 'absolute', zIndex: 9999, top: 'calc(100% + 4px)', left: 0, right: 0,
          background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 8,
          boxShadow: '0 8px 32px rgba(0,0,0,0.5)', overflow: 'hidden',
          minWidth: 220,
        }}>
          {/* Search input */}
          <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--surface-1)' }}>
            <input
              ref={inputRef}
              value={query}
              onChange={e => { setQuery(e.target.value); setCursor(-1); }}
              onKeyDown={onKeyDown}
              placeholder="Type to search…"
              style={{
                width: '100%', background: 'var(--surface-3)', border: '1px solid var(--line)',
                color: 'var(--text-1)', borderRadius: 6, padding: '5px 8px', fontSize: 13,
                outline: 'none', boxSizing: 'border-box',
              }}
            />
          </div>

          {/* Options list */}
          <div
            ref={listRef}
            style={{ maxHeight: 260, overflowY: 'auto' }}
          >
            {filtered.length === 0 && (
              <div style={{ padding: '12px 14px', color: 'var(--text-4)', fontSize: 13 }}>No matches</div>
            )}
            {filtered.map((opt, i) => (
              <div
                key={opt.value}
                onMouseDown={() => pick(opt)}
                onMouseEnter={() => setCursor(i)}
                style={{
                  padding: '8px 14px', fontSize: 13, cursor: 'pointer',
                  background: i === cursor
                    ? 'var(--surface-1)'
                    : String(opt.value) === String(value) ? '#0d1a2e' : 'transparent',
                  color: String(opt.value) === String(value) ? 'var(--accent-light)' : '#cbd5e1',
                  borderLeft: String(opt.value) === String(value) ? '2px solid #3b82f6' : '2px solid transparent',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}
              >
                {opt.label}
              </div>
            ))}
          </div>

          {/* Count hint */}
          <div style={{
            padding: '5px 14px', borderTop: '1px solid var(--surface-1)',
            color: 'var(--text-5)', fontSize: 11,
          }}>
            {filtered.length} of {options.length}
          </div>
        </div>
      )}
    </div>
  );
}
