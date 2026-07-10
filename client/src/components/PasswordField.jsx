import React, { useState } from 'react';
import { toast } from 'react-hot-toast';

/**
 * Password input with "suggest strong password" + copy-to-clipboard.
 * Suggesting reveals the value (you must be able to read what you're about
 * to hand to the new user); the eye toggles visibility manually too.
 */

const LOWER = 'abcdefghjkmnpqrstuvwxyz';       // no l/o/i ambiguity
const UPPER = 'ABCDEFGHJKMNPQRSTUVWXYZ';
const DIGIT = '23456789';
const SYMBOL = '!@#$%^&*-_=+?';

export function suggestPassword(len = 16) {
  const all = LOWER + UPPER + DIGIT + SYMBOL;
  const rand = (n) => {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] % n;
  };
  // guarantee one of each class, fill the rest, then shuffle
  const chars = [
    LOWER[rand(LOWER.length)], UPPER[rand(UPPER.length)],
    DIGIT[rand(DIGIT.length)], SYMBOL[rand(SYMBOL.length)],
  ];
  while (chars.length < len) chars.push(all[rand(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // http / older browsers fallback
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  }
}

const iconBtn = {
  border: '1px solid var(--border)', background: 'var(--bg-hover)', color: 'var(--text-3)',
  borderRadius: 8, padding: '0 8px', cursor: 'pointer', fontSize: 13, lineHeight: '26px',
  flexShrink: 0,
};

export default function PasswordField({ value, onChange, id, placeholder, required, minLength = 8, autoFocus, inputStyle, style }) {
  const [visible, setVisible] = useState(false);

  function suggest() {
    const pw = suggestPassword();
    onChange(pw);
    setVisible(true);
  }
  async function copy() {
    if (!value) { toast.error('Nothing to copy yet'); return; }
    (await copyText(value)) ? toast.success('Password copied') : toast.error('Copy failed — select it manually');
  }

  return (
    <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center', ...style }}>
      <input id={id} className="field-input" type={visible ? 'text' : 'password'}
        value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder} required={required} minLength={minLength} autoFocus={autoFocus}
        autoComplete="new-password" spellCheck={false}
        style={{ width: 160, fontFamily: visible && value ? 'ui-monospace, monospace' : undefined, ...inputStyle }} />
      <button type="button" style={iconBtn} title="Suggest a strong password" onClick={suggest}>🎲</button>
      <button type="button" style={iconBtn} title="Copy password" onClick={copy}>📋</button>
      <button type="button" style={iconBtn} title={visible ? 'Hide' : 'Show'} onClick={() => setVisible(v => !v)}>
        {visible ? '🙈' : '👁️'}
      </button>
    </span>
  );
}
