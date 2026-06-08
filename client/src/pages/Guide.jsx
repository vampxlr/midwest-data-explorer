import React from 'react';

const Section = ({ title, children }) => (
  <div className="card" style={{marginBottom:20}}>
    <h2 style={{marginBottom:12}}>{title}</h2>
    {children}
  </div>
);

const Step = ({ n, title, text }) => (
  <div style={{display:'flex',gap:14,marginBottom:14}}>
    <div style={{width:30,height:30,borderRadius:'50%',background:'var(--chip-bg)',color:'var(--accent-light)',
      display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700,fontSize:14,flexShrink:0}}>{n}</div>
    <div>
      <div style={{color:'var(--text-1)',fontWeight:600,marginBottom:3}}>{title}</div>
      <div style={{color:'var(--text-3)',fontSize:13,lineHeight:1.6}}>{text}</div>
    </div>
  </div>
);

const Tip = ({ children }) => (
  <div style={{background:'var(--chip-bg)',border:'1px solid var(--info-border)',borderRadius:8,padding:'10px 14px',marginBottom:10,fontSize:13,color:'var(--info-text)'}}>
    {children}
  </div>
);

export default function Guide() {
  return (
    <div>
      <div className="page-header">
        <h1>Guide</h1>
        <p>How to use the Midwest 3on3 Data Explorer — focused on 2025/2026 graduation year analysis</p>
      </div>

      <Section title="What This Tool Does">
        <p style={{color:'var(--text-2)',lineHeight:1.7,marginBottom:10}}>
          This explorer connects read-only to the SportsEngine API for the Midwest 3 on 3 organization (ID 8008).
          It automatically loads all registrations from 2025 onwards and lets you analyze:
        </p>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(200px,1fr))',gap:10}}>
          {[
            ['🎓','Graduation Year','Which class years have the most players'],
            ['👥','Gender Split','Boys vs Girls across events'],
            ['📍','Geography','What states and cities players come from'],
            ['🏆','Division','What divisions/age groups are most popular'],
            ['📊','Event Rank','Which events have the most registrations'],
          ].map(([icon,title,desc])=>(
            <div key={title} style={{background:'var(--surface-1)',borderRadius:8,padding:'12px 14px'}}>
              <div style={{fontSize:20,marginBottom:4}}>{icon}</div>
              <div style={{color:'var(--text-1)',fontWeight:600,fontSize:14}}>{title}</div>
              <div style={{color:'var(--text-4)',fontSize:12,marginTop:4}}>{desc}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Quick Start — Graduation Year 2025/2026 Analysis">
        <Step n={1} title="App auto-loads on startup"
          text="When you open the app, it automatically fetches all 2025+ registrations and selects the most recent one. No setup needed." />
        <Step n={2} title="Use Quick Scenarios on the Dashboard"
          text='Go to Dashboard → click "Grad Year 2025" or "Grad Year 2026" to instantly see how many players from those graduating classes registered across ALL 2025+ events.' />
        <Step n={3} title="Switch to Aggregate mode in Analytics"
          text='Go to Analytics → click "All 2025+ Events (Aggregate)" → then click "2025 Only" or "2026 Only" scenario to see the full breakdown with bar charts, pie charts, and area charts.' />
        <Step n={4} title="Drill into a single event"
          text="Change the event in the sidebar dropdown → Analytics auto-reloads for that specific event so you can compare individual leagues." />
        <Tip>The first aggregate load (all events) takes ~30-60 seconds because it fetches data from every event. After that it is cached for 10 minutes and instant.</Tip>
      </Section>

      <Section title="Pages Explained">
        <table className="data-table">
          <thead><tr><th>Page</th><th>What It Shows</th><th>Best For</th></tr></thead>
          <tbody>
            {[
              ['📊 Dashboard','Overview: scenario buttons, aggregate stats, event leaderboard','Quick look + choosing scenarios'],
              ['📈 Analytics','Deep charts: bar, pie, area, horizontal bars — single or aggregate','Grad year analysis with filters'],
              ['📝 Registrations','Browse all 705 events with search and CSV export','Find specific events, export list'],
              ['🔍 Query Explorer','Run REST or GraphQL queries, see JSON or table, export CSV','Custom data pulls'],
              ['📋 Schema','Browse all GraphQL types and fields','Understand what data is available'],
            ].map(([p,w,b])=>(
              <tr key={p}>
                <td style={{color:'var(--accent-light)',fontWeight:600,whiteSpace:'nowrap'}}>{p}</td>
                <td style={{color:'var(--text-2)'}}>{w}</td>
                <td style={{color:'var(--text-3)',fontSize:12}}>{b}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="Pre-built Query Scenarios (Query Explorer)">
        <p style={{color:'var(--text-3)',fontSize:13,marginBottom:12}}>
          The Query Explorer has ready-to-run scenarios. Click any item in the left panel and hit Run.
        </p>
        <table className="data-table">
          <thead><tr><th>Scenario</th><th>Type</th><th>What It Returns</th></tr></thead>
          <tbody>
            {[
              ['All 2025+ Grad Year Breakdown','REST','Total player counts by grad year across every 2025+ event'],
              ['2025 Grad Players Only','REST','How many players graduating in 2025 signed up total'],
              ['2026 Grad Players Only','REST','Same for graduating class of 2026'],
              ['2025 + 2026 Combined','REST','Both classes combined in one response'],
              ['Recent Registrations List','REST','All 2025+ events sorted newest first'],
              ['Analyze Specific Event','GraphQL','Full raw answers for one event — change the ID'],
              ['Profiles Page 1','GraphQL','50 registrant profiles with demographics'],
            ].map(([s,t,w])=>(
              <tr key={s}>
                <td style={{color:'var(--text-1)',fontWeight:600}}>{s}</td>
                <td><span className={`badge ${t==='REST'?'badge-green':'badge-blue'}`}>{t}</span></td>
                <td style={{color:'var(--text-3)',fontSize:13}}>{w}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="How Graduation Year Data Works">
        <p style={{color:'var(--text-2)',lineHeight:1.7,marginBottom:10}}>
          SportsEngine does not store graduation year as a profile field for most registrants.
          Instead, each team registration form has questions like <em style={{color:'var(--accent-light)'}}>"Player 1 Graduation Year"</em>,
          <em style={{color:'var(--accent-light)'}}> "Player 2 Graduation Year"</em>, etc.
        </p>
        <p style={{color:'var(--text-2)',lineHeight:1.7,marginBottom:10}}>
          This app reads those form answers and aggregates them. A single team registration may contribute
          multiple graduation year counts (one per player on the roster, typically 3-5 players per team).
        </p>
        <Tip>The "Desired Division of Play" answer also encodes grad year (e.g. "2026") and is used as a fallback when player-level answers are missing.</Tip>
      </Section>

      <Section title="Year Filter">
        <p style={{color:'var(--text-2)',lineHeight:1.7}}>
          Use the <strong style={{color:'var(--accent-light)'}}>2025+</strong> and <strong style={{color:'var(--accent-light)'}}>2026+</strong> buttons
          in the sidebar to change which events are included. "2025+" includes all events named or dated from 2025 onwards.
          "2026+" is narrower — only 2026 events. Switch and the sidebar dropdown and all analytics update automatically.
        </p>
      </Section>

      <Section title="Important Notes">
        <div style={{color:'var(--text-2)',fontSize:13,lineHeight:1.8}}>
          <div style={{marginBottom:6}}>🔒 <strong style={{color:'var(--text-1)'}}>Read-only:</strong> This tool never writes or modifies any data on SportsEngine.</div>
          <div style={{marginBottom:6}}>⚡ <strong style={{color:'var(--text-1)'}}>Caching:</strong> Data is cached for 5-10 minutes. Click "Refresh Data" in the sidebar to force a reload.</div>
          <div style={{marginBottom:6}}>⏱️ <strong style={{color:'var(--text-1)'}}>Aggregate speed:</strong> First-time aggregate queries fetch all events sequentially and take 30-60s. Cached thereafter.</div>
          <div>🔑 <strong style={{color:'var(--text-1)'}}>API:</strong> Uses SportsEngine OAuth2 client_credentials flow. Token auto-refreshes every 24 hours.</div>
        </div>
      </Section>
    </div>
  );
}
