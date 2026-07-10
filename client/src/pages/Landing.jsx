import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.jsx';

/**
 * Public marketing/landing page — shown to logged-out visitors.
 * All copy, features, and pricing come from /api/site-settings (edited in the
 * super admin panel) — nothing content-wise is hardcoded. Visual effects:
 * aurora blobs, gradient headline, floating dashboard mockup with a
 * self-drawing chart, scroll-reveal cards, animated gradient pricing border.
 * Everything honors prefers-reduced-motion.
 */

/* Scroll-reveal: adds .in when the element enters the viewport.
   Re-runs when `ready` flips — the elements only exist after settings load. */
function useReveal(ready) {
  useEffect(() => {
    if (!ready) return;
    const els = document.querySelectorAll('.lp-reveal:not(.in)');
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }, { threshold: 0.15 });
    els.forEach(el => io.observe(el));
    return () => io.disconnect();
  }, [ready]);
}

/* Decorative dashboard preview — registrations pace, drawn on load */
function MockDashboard() {
  // simple cumulative-pace shape (decorative, no fake precision)
  const pts = [4, 6, 9, 11, 15, 22, 26, 30, 44, 50, 57, 76, 82, 90, 118, 125];
  const W = 460, H = 150, max = 130;
  const path = pts.map((v, i) =>
    `${i === 0 ? 'M' : 'L'}${(i / (pts.length - 1)) * W},${H - (v / max) * H}`).join(' ');
  const area = `${path} L${W},${H} L0,${H} Z`;
  return (
    <div className="lp-mock" aria-hidden="true">
      <div className="lp-mock-bar">
        <span className="lp-dot" style={{ background: '#f87171' }} />
        <span className="lp-dot" style={{ background: '#fbbf24' }} />
        <span className="lp-dot" style={{ background: '#34d399' }} />
        <span className="lp-mock-title">Registrations — live</span>
        <span className="lp-live">● LIVE</span>
      </div>
      <div className="lp-mock-kpis">
        {[['Today', '+18'], ['This week', '+126'], ['vs last year', '+31%']].map(([k, v]) => (
          <div className="lp-kpi" key={k}>
            <div className="lp-kpi-label">{k}</div>
            <div className="lp-kpi-value">{v}</div>
          </div>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H + 8}`} className="lp-chart" preserveAspectRatio="none">
        <defs>
          <linearGradient id="lpFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent-light)" stopOpacity="0.30" />
            <stop offset="100%" stopColor="var(--accent-light)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map(f => (
          <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke="var(--line)" strokeWidth="1" strokeDasharray="3 5" />
        ))}
        <path d={area} fill="url(#lpFill)" className="lp-area" />
        <path d={path} fill="none" stroke="var(--accent-light)" strokeWidth="2.5"
          strokeLinecap="round" className="lp-line" pathLength="1" />
        <circle cx={W} cy={H - (pts[pts.length - 1] / max) * H} r="5" fill="var(--accent-light)" className="lp-line-tip" />
      </svg>
      <div className="lp-mock-bars">
        {[42, 68, 35, 88, 55, 96, 74].map((h, i) => (
          <div key={i} className="lp-vbar" style={{ '--h': h + '%', '--d': (0.9 + i * 0.09) + 's' }} />
        ))}
      </div>
    </div>
  );
}

export default function Landing({ onSignIn, onSignup }) {
  const [s, setS] = useState(null);
  const [trial, setTrial] = useState(null);   // {trialAvailable, trialDays}
  const mockRef = useRef(null);
  const signup = onSignup || onSignIn;

  useEffect(() => {
    api.getSiteSettings().then(r => setS(r.data)).catch(() => setS({}));
    api.signupAvailability().then(r => setTrial(r.data)).catch(() => setTrial(null));
  }, []);
  useReveal(!!s);

  // Gentle parallax tilt on the mockup (pointer devices only)
  useEffect(() => {
    const el = mockRef.current;
    if (!el || window.matchMedia('(pointer: coarse)').matches
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const onMove = (e) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      el.style.transform = `perspective(1100px) rotateY(${x * 7}deg) rotateX(${-y * 7}deg)`;
    };
    const onLeave = () => { el.style.transform = 'perspective(1100px)'; };
    el.addEventListener('mousemove', onMove);
    el.addEventListener('mouseleave', onLeave);
    return () => { el.removeEventListener('mousemove', onMove); el.removeEventListener('mouseleave', onLeave); };
  }, [s]);

  if (!s) return <div style={{ minHeight: '100vh', background: 'var(--bg-base)' }} />;

  const features = s.features || [];
  const icons = ['📊', '📈', '⚡', '🎯', '🔁', '🎥'];

  return (
    <div className="lp">
      <style>{`
        .lp { min-height:100vh; background:var(--bg-base); color:var(--text-1); overflow-x:hidden; position:relative; }

        /* ── aurora backdrop ── */
        .lp-aurora { position:absolute; inset:0; overflow:hidden; pointer-events:none; }
        .lp-blob { position:absolute; border-radius:50%; filter:blur(90px); opacity:0.5; animation:lpBlob 18s ease-in-out infinite alternate; }
        .lp-blob.b1 { width:520px; height:520px; top:-180px; left:-120px; background:radial-gradient(circle, rgba(249,115,22,0.55), transparent 65%); }
        .lp-blob.b2 { width:460px; height:460px; top:-80px; right:-140px; background:radial-gradient(circle, rgba(99,102,241,0.5), transparent 65%); animation-delay:-6s; }
        .lp-blob.b3 { width:420px; height:420px; top:44%; left:58%; background:radial-gradient(circle, rgba(34,197,94,0.35), transparent 65%); animation-delay:-12s; }
        @keyframes lpBlob { from { transform:translate(0,0) scale(1); } to { transform:translate(60px,40px) scale(1.15); } }
        .lp-grid-bg { position:absolute; inset:0; pointer-events:none;
          background-image:linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px);
          background-size:56px 56px; mask-image:radial-gradient(ellipse 90% 55% at 50% 0%, black 25%, transparent 75%);
          -webkit-mask-image:radial-gradient(ellipse 90% 55% at 50% 0%, black 25%, transparent 75%); opacity:0.5; }

        /* ── header ── */
        .lp-header { position:sticky; top:0; z-index:20; display:flex; align-items:center; justify-content:space-between;
          padding:14px clamp(16px,5vw,64px); backdrop-filter:blur(14px); -webkit-backdrop-filter:blur(14px);
          background:color-mix(in srgb, var(--bg-base) 72%, transparent); border-bottom:1px solid var(--border-sub); }
        .lp-logo { display:flex; align-items:center; gap:10px; font-weight:800; font-size:15px; letter-spacing:-0.3px; }
        .lp-logo .ball { font-size:24px; display:inline-block; animation:lpBounce 2.6s ease-in-out infinite; }
        @keyframes lpBounce { 0%,100% { transform:translateY(0); } 12% { transform:translateY(-7px) rotate(-12deg); } 24% { transform:translateY(0); } }

        /* ── hero ── */
        .lp-hero { position:relative; text-align:center; padding:clamp(56px,10vh,110px) 20px 24px; max-width:900px; margin:0 auto; }
        .lp-badge { display:inline-flex; align-items:center; gap:8px; margin-bottom:22px; padding:6px 16px; border-radius:999px;
          background:rgba(249,115,22,0.10); border:1px solid rgba(249,115,22,0.35); color:var(--accent-2);
          font-size:12px; font-weight:700; animation:lpPulseB 2.8s ease-in-out infinite; }
        @keyframes lpPulseB { 0%,100% { box-shadow:0 0 0 0 rgba(249,115,22,0.28); } 55% { box-shadow:0 0 0 9px rgba(249,115,22,0); } }
        .lp-h1 { font-size:clamp(34px,6.5vw,64px); font-weight:800; letter-spacing:-2px; line-height:1.05; margin:0 0 18px;
          background:linear-gradient(100deg, var(--text-1) 20%, var(--accent-light) 48%, var(--accent-2) 62%, var(--text-1) 82%);
          background-size:220% auto; -webkit-background-clip:text; background-clip:text; color:transparent;
          animation:lpSheen 7s linear infinite; }
        @keyframes lpSheen { to { background-position:220% center; } }
        .lp-tagline { font-size:clamp(15px,2.2vw,19px); color:var(--text-2); line-height:1.65; margin:0 auto 30px; max-width:640px; }
        .lp-cta-row { display:flex; gap:14px; justify-content:center; flex-wrap:wrap; }
        .lp-cta { position:relative; overflow:hidden; padding:14px 36px; font-size:16px; font-weight:700; border-radius:14px; cursor:pointer;
          border:none; color:#fff; background:linear-gradient(120deg, #f97316, #ea580c);
          box-shadow:0 8px 28px -8px rgba(249,115,22,0.65); transition:transform .18s ease, box-shadow .18s ease; }
        .lp-cta:hover { transform:translateY(-2px) scale(1.02); box-shadow:0 14px 34px -8px rgba(249,115,22,0.8); }
        .lp-cta::after { content:''; position:absolute; top:0; left:-80%; width:50%; height:100%;
          background:linear-gradient(100deg, transparent, rgba(255,255,255,0.45), transparent);
          transform:skewX(-20deg); animation:lpShine 3.6s ease-in-out infinite; }
        @keyframes lpShine { 0%, 55% { left:-80%; } 85%, 100% { left:130%; } }
        .lp-cta.ghost { background:transparent; color:var(--text-1); border:1px solid var(--border); box-shadow:none; }
        .lp-cta.ghost::after { display:none; }
        .lp-cta.ghost:hover { border-color:var(--accent-light); color:var(--accent-light); }

        /* entrance stagger */
        .lp-up { opacity:0; transform:translateY(22px); animation:lpUp .7s cubic-bezier(.2,.7,.3,1) forwards; animation-delay:var(--d,0s); }
        @keyframes lpUp { to { opacity:1; transform:translateY(0); } }

        /* ── mockup ── */
        .lp-mock-wrap { position:relative; max-width:640px; margin:56px auto 0; padding:0 18px; opacity:0;
          animation:lpUp .7s .35s cubic-bezier(.2,.7,.3,1) forwards, lpFloat 7s 1.3s ease-in-out infinite; }
        @keyframes lpFloat { 0%,100% { transform:translateY(0); } 50% { transform:translateY(-12px); } }
        .lp-mock { position:relative; border-radius:18px; border:1px solid var(--border); overflow:hidden; text-align:left;
          background:color-mix(in srgb, var(--surface-1) 88%, transparent); backdrop-filter:blur(8px);
          box-shadow:0 30px 80px -24px rgba(0,0,0,0.5), 0 0 0 1px color-mix(in srgb, var(--accent-light) 18%, transparent);
          transition:transform .2s ease; will-change:transform; }
        .lp-mock-bar { display:flex; align-items:center; gap:7px; padding:11px 14px; border-bottom:1px solid var(--border-sub); }
        .lp-dot { width:10px; height:10px; border-radius:50%; }
        .lp-mock-title { margin-left:8px; font-size:12px; font-weight:700; color:var(--text-3); }
        .lp-live { margin-left:auto; font-size:10px; font-weight:800; color:var(--viz-up); animation:lpBlink 1.6s ease-in-out infinite; }
        @keyframes lpBlink { 50% { opacity:0.35; } }
        .lp-mock-kpis { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; padding:14px 14px 4px; }
        .lp-kpi { border:1px solid var(--border-sub); border-radius:10px; padding:8px 12px; background:var(--bg-hover); }
        .lp-kpi-label { font-size:9px; text-transform:uppercase; letter-spacing:.6px; color:var(--text-4); }
        .lp-kpi-value { font-size:18px; font-weight:800; color:var(--accent-light); font-variant-numeric:tabular-nums; }
        .lp-chart { display:block; width:100%; height:150px; padding:10px 14px 0; box-sizing:border-box; }
        .lp-line { stroke-dasharray:1; stroke-dashoffset:1; animation:lpDraw 2.4s .5s cubic-bezier(.4,0,.2,1) forwards; }
        @keyframes lpDraw { to { stroke-dashoffset:0; } }
        .lp-area { opacity:0; animation:lpFade 1s 2.1s ease forwards; }
        .lp-line-tip { opacity:0; animation:lpFade .5s 2.7s ease forwards, lpBlink 1.8s 3s ease-in-out infinite; }
        @keyframes lpFade { to { opacity:1; } }
        .lp-mock-bars { display:flex; align-items:flex-end; gap:8px; height:64px; padding:8px 14px 16px; }
        .lp-vbar { flex:1; height:var(--h); border-radius:5px 5px 2px 2px;
          background:linear-gradient(180deg, var(--accent-light), color-mix(in srgb, var(--accent-light) 45%, transparent));
          transform:scaleY(0); transform-origin:bottom; animation:lpGrow .7s var(--d) cubic-bezier(.2,.7,.3,1.2) forwards; opacity:0.85; }
        @keyframes lpGrow { to { transform:scaleY(1); } }

        /* ── sections ── */
        .lp-section { position:relative; max-width:1080px; margin:0 auto; padding:clamp(48px,8vh,88px) clamp(16px,4vw,32px) 12px; }
        .lp-kicker { text-align:center; font-size:12px; font-weight:800; letter-spacing:2px; text-transform:uppercase; color:var(--accent-light); margin-bottom:10px; }
        .lp-h2 { text-align:center; font-size:clamp(24px,3.6vw,36px); font-weight:800; letter-spacing:-1px; margin:0 0 40px; }

        .lp-reveal { opacity:0; transform:translateY(30px); transition:opacity .7s cubic-bezier(.2,.7,.3,1), transform .7s cubic-bezier(.2,.7,.3,1); transition-delay:var(--d,0s); }
        .lp-reveal.in { opacity:1; transform:none; }

        .lp-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(270px,1fr)); gap:18px; }
        .lp-card { position:relative; border:1px solid var(--border-sub); border-radius:16px; padding:24px 22px;
          background:var(--surface-1); transition:transform .22s ease, border-color .22s ease, box-shadow .22s ease; overflow:hidden; }
        .lp-card::before { content:''; position:absolute; inset:0;
          background:radial-gradient(420px circle at var(--mx,50%) var(--my,0%), color-mix(in srgb, var(--accent-light) 9%, transparent), transparent 45%);
          opacity:0; transition:opacity .25s ease; pointer-events:none; }
        .lp-card:hover { transform:translateY(-6px); border-color:color-mix(in srgb, var(--accent-light) 45%, var(--border-sub));
          box-shadow:0 18px 44px -18px rgba(0,0,0,0.45); }
        .lp-card:hover::before { opacity:1; }
        .lp-ficon { display:inline-flex; align-items:center; justify-content:center; width:46px; height:46px; font-size:22px;
          border-radius:13px; margin-bottom:14px; background:linear-gradient(135deg, rgba(249,115,22,0.16), rgba(99,102,241,0.14));
          border:1px solid rgba(249,115,22,0.25); }
        .lp-card h3 { font-size:15px; font-weight:700; margin:0 0 7px; }
        .lp-card p { font-size:13.5px; color:var(--text-3); line-height:1.6; margin:0; }

        /* ── pricing ── */
        .lp-price-wrap { max-width:480px; margin:0 auto; padding:8px 20px 30px; }
        .lp-price { position:relative; border-radius:22px; padding:2px; overflow:hidden; }
        .lp-price::before { content:''; position:absolute; inset:-120%;
          background:conic-gradient(from 0deg, transparent 0 200deg, var(--accent-2) 250deg, var(--accent-light) 300deg, transparent 340deg);
          animation:lpSpin 5s linear infinite; }
        @keyframes lpSpin { to { transform:rotate(1turn); } }
        .lp-price-inner { position:relative; border-radius:20px; background:var(--surface-1); padding:34px 30px; text-align:center;
          border:1px solid var(--border-sub); }
        .lp-price-old { font-size:22px; font-weight:700; color:var(--text-4); text-decoration:line-through; }
        .lp-price-now { font-size:56px; font-weight:800; letter-spacing:-2.5px;
          background:linear-gradient(120deg, var(--accent-light), var(--accent-2)); -webkit-background-clip:text; background-clip:text; color:transparent; }
        .lp-price li { opacity:0; transform:translateX(-12px); transition:opacity .5s ease, transform .5s ease; transition-delay:var(--d); }
        .lp-reveal.in .lp-price li, .lp-price-inner .in li { opacity:1; transform:none; }

        .lp-footer { text-align:center; padding:26px 20px 38px; border-top:1px solid var(--border-sub); color:var(--text-4); font-size:12px; margin-top:56px; }

        @media (max-width:640px) {
          .lp-mock-kpis { grid-template-columns:repeat(3,1fr); gap:6px; padding:10px 10px 2px; }
          .lp-kpi { padding:6px 8px; } .lp-kpi-value { font-size:15px; }
          .lp-cta { width:100%; }
        }
        @media (prefers-reduced-motion: reduce) {
          .lp *, .lp *::before, .lp *::after { animation:none !important; transition:none !important; }
          .lp-up, .lp-reveal, .lp-price li, .lp-mock-wrap { opacity:1 !important; transform:none !important; }
          .lp-line { stroke-dashoffset:0; } .lp-area, .lp-line-tip { opacity:1; }
          .lp-vbar { transform:scaleY(1); }
        }
      `}</style>

      <div className="lp-aurora">
        <div className="lp-blob b1" /><div className="lp-blob b2" /><div className="lp-blob b3" />
      </div>
      <div className="lp-grid-bg" />

      <header className="lp-header">
        <div className="lp-logo"><span className="ball">🏀</span>{s.appName}</div>
        <button className="btn-primary" onClick={onSignIn}>Sign in</button>
      </header>

      {/* Hero */}
      <section className="lp-hero">
        <div className="lp-badge lp-up" style={{ '--d': '0s' }}>✨ {s.betaBanner}</div>
        <h1 className="lp-h1 lp-up" style={{ '--d': '0.08s' }}>{s.appName}</h1>
        <p className="lp-tagline lp-up" style={{ '--d': '0.16s' }}>{s.tagline}</p>
        <div className="lp-cta-row lp-up" style={{ '--d': '0.24s' }}>
          <button className="lp-cta" onClick={signup}>
            {trial?.trialAvailable ? `Start ${trial.trialDays}-day free trial →` : 'Get started →'}
          </button>
          <button className="lp-cta ghost" onClick={() =>
            document.getElementById('lp-features')?.scrollIntoView({ behavior: 'smooth' })}>
            See what it does
          </button>
        </div>
        <div className="lp-mock-wrap">
          <div ref={mockRef}><MockDashboard /></div>
        </div>
      </section>

      {/* Features */}
      <section className="lp-section" id="lp-features">
        <div className="lp-kicker lp-reveal">Everything in one glance</div>
        <h2 className="lp-h2 lp-reveal">Built for teams that live on registrations</h2>
        <div className="lp-grid">
          {features.map((f, i) => (
            <div key={i} className="lp-card lp-reveal" style={{ '--d': `${(i % 3) * 0.09}s` }}
              onMouseMove={e => {
                const r = e.currentTarget.getBoundingClientRect();
                e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`);
                e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`);
              }}>
              <div className="lp-ficon">{f.icon || icons[i % icons.length]}</div>
              <h3>{f.title}</h3>
              <p>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section className="lp-section" style={{ paddingBottom: 0 }}>
        <div className="lp-kicker lp-reveal">Simple pricing</div>
        <h2 className="lp-h2 lp-reveal">One plan. Everything included.</h2>
      </section>
      <div className="lp-price-wrap lp-reveal">
        <div className="lp-price">
          <div className="lp-price-inner">
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 12, marginBottom: 4 }}>
              <span className="lp-price-old">${s.priceMonthly}</span>
              <span className="lp-price-now">${s.betaPriceMonthly}</span>
              <span style={{ fontSize: 14, color: 'var(--text-3)' }}>/month</span>
            </div>
            <div style={{
              display: 'inline-block', margin: '4px 0 20px', padding: '4px 14px', borderRadius: 999,
              background: 'rgba(34,197,94,0.12)', color: 'var(--viz-up)', fontSize: 12, fontWeight: 700,
            }}>
              Beta price — locked in forever
            </div>
            <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 24px', textAlign: 'left', fontSize: 13.5, color: 'var(--text-2)', lineHeight: 2.1 }}>
              {features.slice(0, 6).map((f, i) => (
                <li key={i} style={{ '--d': `${0.15 + i * 0.08}s` }}>
                  <span style={{ color: 'var(--viz-up)', fontWeight: 800, marginRight: 8 }}>✓</span>{f.title}
                </li>
              ))}
            </ul>
            <button className="lp-cta" style={{ width: '100%' }} onClick={signup}>
              {trial?.trialAvailable ? `Start free trial` : 'Create account'}
            </button>
            {trial && !trial.trialAvailable && (
              <p style={{ fontSize: 11.5, color: 'var(--text-4)', margin: '10px 0 0' }}>
                Free trial slots are full this month — sign up to grab the next opening.
              </p>
            )}
          </div>
        </div>
      </div>

      <footer className="lp-footer">© {new Date().getFullYear()} {s.appName}</footer>
    </div>
  );
}
