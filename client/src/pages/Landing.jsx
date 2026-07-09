import React, { useEffect, useState } from 'react';
import { api } from '../api.jsx';

/**
 * Public marketing/landing page — shown to logged-out visitors.
 * All copy, features, and pricing come from /api/site-settings, which the
 * super admin panel edits — nothing here is hardcoded.
 */
export default function Landing({ onSignIn }) {
  const [s, setS] = useState(null);

  useEffect(() => {
    api.getSiteSettings().then(r => setS(r.data)).catch(() => setS({}));
  }, []);

  if (!s) {
    return <div style={{ minHeight:'100vh', background:'var(--bg-base)' }} />;
  }

  const features = s.features || [];

  return (
    <div style={{ minHeight:'100vh', background:'var(--bg-base)', color:'var(--text-1)' }}>
      {/* Top bar */}
      <header style={{
        display:'flex', alignItems:'center', justifyContent:'space-between',
        padding:'18px clamp(16px, 5vw, 64px)', borderBottom:'1px solid var(--border-sub)',
      }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <span style={{ fontSize:26 }}>🏀</span>
          <span style={{ fontWeight:800, fontSize:15, letterSpacing:'-0.3px' }}>{s.appName}</span>
        </div>
        <button className="btn-primary" onClick={onSignIn}>Sign in</button>
      </header>

      {/* Hero */}
      <section style={{ textAlign:'center', padding:'clamp(48px,9vh,96px) 20px 40px', maxWidth:820, margin:'0 auto' }}>
        <div style={{
          display:'inline-block', marginBottom:18, padding:'5px 14px', borderRadius:999,
          background:'rgba(249,115,22,0.12)', border:'1px solid rgba(249,115,22,0.35)',
          color:'var(--accent-2)', fontSize:12, fontWeight:700,
        }}>
          {s.betaBanner}
        </div>
        <h1 style={{ fontSize:'clamp(30px, 5vw, 48px)', fontWeight:800, letterSpacing:'-1.5px', margin:'0 0 16px', lineHeight:1.1 }}>
          {s.appName}
        </h1>
        <p style={{ fontSize:'clamp(14px, 2vw, 17px)', color:'var(--text-2)', lineHeight:1.6, margin:'0 auto 28px', maxWidth:640 }}>
          {s.tagline}
        </p>
        <button className="btn-primary" style={{ padding:'12px 32px', fontSize:15 }} onClick={onSignIn}>
          Get started →
        </button>
      </section>

      {/* Features */}
      <section style={{ maxWidth:1060, margin:'0 auto', padding:'20px clamp(16px,4vw,32px) 40px' }}>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(280px, 1fr))', gap:16 }}>
          {features.map((f, i) => (
            <div key={i} className="card" style={{ margin:0 }}>
              <div style={{ fontSize:22, marginBottom:10 }}>{f.icon || ['📊','📈','⚡','🎯','🔁','🎥'][i % 6]}</div>
              <h3 style={{ fontSize:14, fontWeight:700, color:'var(--text-1)', margin:'0 0 6px' }}>{f.title}</h3>
              <p style={{ fontSize:13, color:'var(--text-3)', lineHeight:1.55, margin:0 }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section style={{ maxWidth:460, margin:'0 auto', padding:'8px 20px 72px', textAlign:'center' }}>
        <div className="card" style={{ padding:'32px 28px', margin:0, border:'1px solid var(--chip-border)' }}>
          <div style={{ fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'1px', color:'var(--accent-light)', marginBottom:14 }}>
            Simple pricing
          </div>
          <div style={{ display:'flex', alignItems:'baseline', justifyContent:'center', gap:12, marginBottom:6 }}>
            <span style={{ fontSize:22, fontWeight:700, color:'var(--text-4)', textDecoration:'line-through' }}>
              ${s.priceMonthly}
            </span>
            <span style={{ fontSize:46, fontWeight:800, letterSpacing:'-2px', color:'var(--text-1)' }}>
              ${s.betaPriceMonthly}
            </span>
            <span style={{ fontSize:14, color:'var(--text-3)' }}>/month</span>
          </div>
          <div style={{
            display:'inline-block', margin:'6px 0 18px', padding:'3px 12px', borderRadius:999,
            background:'rgba(34,197,94,0.12)', color:'var(--viz-up)', fontSize:12, fontWeight:700,
          }}>
            Beta price — everything included
          </div>
          <ul style={{ listStyle:'none', padding:0, margin:'0 0 22px', textAlign:'left', fontSize:13, color:'var(--text-2)', lineHeight:2 }}>
            {features.slice(0, 6).map((f, i) => (
              <li key={i}>✓ {f.title}</li>
            ))}
          </ul>
          <button className="btn-primary" style={{ width:'100%', padding:'12px' }} onClick={onSignIn}>
            Start now
          </button>
        </div>
      </section>

      <footer style={{ textAlign:'center', padding:'22px 20px 34px', borderTop:'1px solid var(--border-sub)', color:'var(--text-4)', fontSize:12 }}>
        © {new Date().getFullYear()} {s.appName}
      </footer>
    </div>
  );
}
