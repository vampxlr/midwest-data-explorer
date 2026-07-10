import React, { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';
import { api } from '../api.jsx';
import { useAuth } from '../AuthContext.jsx';

/**
 * 📣 Meta Ads — a phone-friendly Ads Manager.
 * Drill down campaigns → ad sets → ads (with creative thumbnails), a few metric
 * columns at a time so nothing needs horizontal scrolling on a phone. Metrics
 * and date range switch from chips at the top. Only campaigns actually
 * spending money (last 21 days) are synced.
 */

const FRIENDLY = {
  link_click: 'Link Clicks',
  landing_page_view: 'Landing Views',
  video_view: 'Video Views',
  'offsite_conversion.fb_pixel_custom': 'Custom Events',
  'offsite_conversion.fb_pixel_lead': 'Leads',
  'offsite_conversion.fb_pixel_complete_registration': 'Complete Reg.',
  'offsite_conversion.fb_pixel_initiate_checkout': 'Init. Checkout',
};
const STALE_MS = 6 * 3600 * 1000;                 // auto re-sync after 6h
const DEFAULT_VIEW = { metrics: ['spend', 'a:offsite_conversion.fb_pixel_custom', 'clicks'], cols: 3, range: '30d' };

const fmtUsd = (n) => '$' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: n >= 100 ? 0 : 2 });
const fmtNum = (n) => Number(n || 0).toLocaleString();
const agoLabel = (iso) => {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};
const adsManagerUrl = (acct, adId) =>
  `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${acct}${adId ? `&selected_ad_ids=${adId}` : ''}`;
const isoShift = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

const RANGES = [
  { key: 'today', label: 'Today',      calc: () => [isoShift(0), isoShift(0)] },
  { key: 'yday',  label: 'Yesterday',  calc: () => [isoShift(-1), isoShift(-1)] },
  { key: '7d',    label: '7D',         calc: () => [isoShift(-6), isoShift(0)] },
  { key: '14d',   label: '14D',        calc: () => [isoShift(-13), isoShift(0)] },
  { key: '30d',   label: '30D',        calc: () => [isoShift(-29), isoShift(0)] },
  { key: 'month', label: 'This month', calc: () => [isoShift(0).slice(0, 8) + '01', isoShift(0)] },
  { key: 'all',   label: 'All year',   calc: () => [isoShift(0).slice(0, 4) + '-01-01', isoShift(0)] },
];

/* ── Settings / setup card (in-app token config, write-only) ────────────── */
function SettingsCard({ settings, onSaved, firstRun }) {
  const [acct, setAcct]   = useState(settings?.adAccountId || '');
  const [token, setToken] = useState('');
  const [busy, setBusy]   = useState(false);
  async function save() {
    setBusy(true);
    try {
      const body = { adAccountId: acct.trim().replace(/^act_/, '') };
      if (token.trim()) body.token = token.trim();
      const r = await api.adsSaveSettings(body);
      toast.success(`Connected: ${r.data.accountName || 'account verified'}`);
      setToken('');
      onSaved();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not verify — check token & account id');
    } finally { setBusy(false); }
  }
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <h3 style={{ margin: '0 0 4px', fontSize: 14 }}>⚙️ Meta connection</h3>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-4)' }}>
        {firstRun
          ? 'Set up from scratch: paste a Marketing API access token (ads_read) and your ad account id. The token is encrypted at rest and never shown again.'
          : 'Change the token or ad account here. Leave the token blank to keep the current one.'}
        {settings?.tokenSource === 'env' && ' Currently using the server environment token.'}
      </p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ fontSize: 11, color: 'var(--text-4)' }}>Ad account id
          <input value={acct} onChange={e => setAcct(e.target.value)} placeholder="303679918069029"
            style={{ display: 'block', marginTop: 4, width: 180 }} />
        </label>
        <label style={{ fontSize: 11, color: 'var(--text-4)', flex: 1, minWidth: 260 }}>Access token {settings?.hasToken && '(saved — paste to replace)'}
          <input value={token} onChange={e => setToken(e.target.value)} type="password"
            placeholder={settings?.hasToken || settings?.tokenSource === 'env' ? '••••••••••••  (unchanged)' : 'EAAB...'}
            style={{ display: 'block', marginTop: 4, width: '100%' }} />
        </label>
        <button className="btn btn-primary" onClick={save} disabled={busy || !acct.trim()}>
          {busy ? 'Verifying…' : 'Save & verify'}
        </button>
      </div>
    </div>
  );
}

/* ── Page ───────────────────────────────────────────────────────────────── */
export default function AdsReport() {
  const { user, isSuperAdmin } = useAuth();
  const canSync = isSuperAdmin || ['admin', 'editor'].includes(user?.role);
  const isAdmin = isSuperAdmin || user?.role === 'admin';

  const [payload, setPayload]   = useState(null);
  const [settings, setSettings] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [syncing, setSyncing]   = useState(false);
  const [view, setView]         = useState(DEFAULT_VIEW);   // {metrics, cols, range, from?, to?}
  const [drill, setDrill]       = useState({ campaignId: null, adsetId: null });
  const autoSynced = useRef(false);
  const viewLoaded = useRef(false);

  async function load() {
    const r = await api.adsData();
    setPayload(r.data);
    if (isAdmin) api.adsSettings().then(s => setSettings(s.data)).catch(() => {});
    return r.data;
  }
  async function sync() {
    setSyncing(true);
    try {
      const r = await api.adsSync();
      toast.success(`Synced ${r.data.campaigns} campaigns · ${r.data.ads} ads`);
      await load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Sync failed');
    } finally { setSyncing(false); }
  }

  useEffect(() => {
    api.getPref('ads-view').then(r => {
      const v = r.data?.value && JSON.parse(r.data.value);
      if (v?.metrics) setView({ ...DEFAULT_VIEW, ...v });
    }).catch(() => {}).finally(() => { viewLoaded.current = true; });
    load().then(p => {
      const stale = !p?.data?.syncedAt || (Date.now() - new Date(p.data.syncedAt).getTime()) > STALE_MS;
      if (stale && p?.configured && canSync && !autoSynced.current) { autoSynced.current = true; sync(); }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function saveView(patch) {
    setView(prev => {
      const next = { ...prev, ...patch };
      if (viewLoaded.current) api.setPref('ads-view', next).catch(() => {});
      return next;
    });
  }

  const data = payload?.data;
  const acct = payload?.adAccountId || data?.adAccountId;

  // Metric catalog: spend/impressions/clicks + every discovered action type
  const metricDefs = useMemo(() => {
    const defs = [
      { key: 'spend',  label: 'Amount Spent', short: 'Spent', money: true },
      { key: 'imp',    label: 'Impressions',  short: 'Impr.' },
      { key: 'clicks', label: 'Clicks',       short: 'Clicks' },
    ];
    for (const m of (data?.discoveredMetrics || [])) {
      const label = data?.ccNames?.[m] || FRIENDLY[m] || m.replace(/^offsite_conversion\./, '');
      defs.push({ key: `a:${m}`, label, short: label.length > 16 ? label.slice(0, 15) + '…' : label });
    }
    return defs;
  }, [data]);
  const defByKey = useMemo(() => Object.fromEntries(metricDefs.map(d => [d.key, d])), [metricDefs]);
  const activeMetrics = view.metrics.filter(k => defByKey[k]).slice(0, view.cols);

  // Date window
  const [from, to] = useMemo(() => {
    if (view.range === 'custom' && view.from && view.to) return [view.from, view.to];
    return (RANGES.find(r => r.key === view.range) || RANGES[4]).calc();
  }, [view.range, view.from, view.to]);

  // Aggregate the raw ad-day rows for the current drill level + date window
  const { rows, totals } = useMemo(() => {
    if (!data) return { rows: [], totals: null };
    const level = drill.adsetId ? 'ad' : drill.campaignId ? 'adset' : 'campaign';
    const keyOf = (i) => level === 'campaign' ? i.c : level === 'adset' ? i.as : i.ad;
    const byKey = {}; const tot = { spend: 0, imp: 0, clicks: 0, actions: {} };
    for (const i of (data.insights || [])) {
      if (i.d < from || i.d > to) continue;
      if (drill.campaignId && i.c !== drill.campaignId) continue;
      if (drill.adsetId && i.as !== drill.adsetId) continue;
      const k = keyOf(i);
      const t = byKey[k] || (byKey[k] = { spend: 0, imp: 0, clicks: 0, actions: {} });
      t.spend += i.spend; t.imp += i.imp; t.clicks += i.clicks;
      tot.spend += i.spend; tot.imp += i.imp; tot.clicks += i.clicks;
      for (const [a, v] of Object.entries(i.actions || {})) {
        t.actions[a] = (t.actions[a] || 0) + v;
        tot.actions[a] = (tot.actions[a] || 0) + v;
      }
    }
    // entity metadata for names/thumbnails; include zero-spend entities of the level
    const meta = level === 'campaign' ? (data.campaigns || [])
      : level === 'adset' ? (data.adsets || []).filter(s => s.campaignId === drill.campaignId)
      : (data.ads || []).filter(a => a.adsetId === drill.adsetId);
    const out = meta.map(m => ({ meta: m, t: byKey[m.id] || { spend: 0, imp: 0, clicks: 0, actions: {} } }))
      .sort((a, b) => b.t.spend - a.t.spend);
    return { rows: out, totals: tot };
  }, [data, drill, from, to]);

  const valueOf = (t, key) => key === 'spend' ? t.spend : key === 'imp' ? t.imp : key === 'clicks' ? t.clicks : (t.actions[key.slice(2)] || 0);
  const renderVal = (t, key) => {
    const def = defByKey[key];
    const v = valueOf(t, key);
    return (
      <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>{def?.money ? fmtUsd(v) : fmtNum(v)}</div>
        {/* cost-per-result under action counts whenever there was spend */}
        {key.startsWith('a:') && v > 0 && t.spend > 0 &&
          <div style={{ fontSize: 9, color: 'var(--text-4)' }}>${(t.spend / v).toFixed(2)}/ea</div>}
      </div>
    );
  };

  function toggleMetric(key) {
    const cur = view.metrics.filter(k => defByKey[k]);
    let next;
    if (cur.includes(key)) next = cur.filter(k => k !== key);
    else next = [...cur, key].slice(-view.cols);      // slots are limited — oldest falls out
    if (!next.length) return;
    saveView({ metrics: next });
  }

  if (!payload) return <div style={{ padding: 24, color: 'var(--text-4)' }}>Loading ads data…</div>;

  const level = drill.adsetId ? 'ad' : drill.campaignId ? 'adset' : 'campaign';
  const campaign = drill.campaignId ? (data?.campaigns || []).find(c => c.id === drill.campaignId) : null;
  const adset = drill.adsetId ? (data?.adsets || []).find(s => s.id === drill.adsetId) : null;
  const gridCols = `minmax(0,1fr) repeat(${activeMetrics.length}, minmax(64px, 88px))`;

  return (
    <div style={{ maxWidth: 860, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <div>
          <h2 style={{ margin: 0 }}>📣 Ads</h2>
          <div style={{ fontSize: 12, color: 'var(--text-4)' }}>
            {data ? <>Synced {agoLabel(data.syncedAt)} · spending campaigns only
              {data.zombieActiveCount > 0 && <> ({data.zombieActiveCount} idle hidden)</>}</> : 'No data synced yet'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {canSync && payload.configured &&
            <button className="btn" onClick={sync} disabled={syncing}>{syncing ? '⏳' : '🔄'}</button>}
          {isAdmin && <button className="btn" onClick={() => setShowSettings(s => !s)}>⚙️</button>}
        </div>
      </div>

      {(!payload.configured || showSettings) && isAdmin &&
        <SettingsCard settings={settings} firstRun={!payload.configured}
          onSaved={() => { setShowSettings(false); load(); }} />}
      {!payload.configured && !isAdmin &&
        <div className="card">Ads reporting isn't configured yet — ask an admin to add the Meta access token.</div>}
      {payload.configured && !data &&
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <p style={{ color: 'var(--text-3)' }}>Connected — run the first sync to pull campaigns and insights.</p>
          {canSync && <button className="btn btn-primary" onClick={sync} disabled={syncing}>{syncing ? '⏳ Syncing…' : '🔄 Sync now'}</button>}
        </div>}

      {data && <>
        {/* date range chips */}
        <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 6, marginBottom: 4 }}>
          {RANGES.map(r => (
            <Chip key={r.key} on={view.range === r.key} onClick={() => saveView({ range: r.key })}>{r.label}</Chip>
          ))}
          <Chip on={view.range === 'custom'} onClick={() => saveView({ range: 'custom', from: view.from || from, to: view.to || to })}>Custom</Chip>
        </div>
        {view.range === 'custom' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, fontSize: 12 }}>
            <input type="date" value={view.from || from} onChange={e => saveView({ from: e.target.value })} />
            →
            <input type="date" value={view.to || to} onChange={e => saveView({ to: e.target.value })} />
          </div>
        )}

        {/* metric chips — tap to fill one of the N metric slots */}
        <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 6, alignItems: 'center' }}>
          <select value={view.cols} onChange={e => saveView({ cols: Number(e.target.value) })}
            title="How many metric columns to show"
            style={{ fontSize: 11, flexShrink: 0, borderRadius: 999, padding: '3px 6px' }}>
            {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n} col{n > 1 ? 's' : ''}</option>)}
          </select>
          {metricDefs.map(d => (
            <Chip key={d.key} on={activeMetrics.includes(d.key)} onClick={() => toggleMetric(d.key)}>{d.label}</Chip>
          ))}
        </div>

        {/* breadcrumb */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '8px 0', minHeight: 28 }}>
          {level !== 'campaign' && (
            <button className="btn" style={{ padding: '2px 10px', fontSize: 13 }}
              onClick={() => setDrill(drill.adsetId ? { campaignId: drill.campaignId, adsetId: null } : { campaignId: null, adsetId: null })}>
              ‹ Back
            </button>
          )}
          <div style={{ fontSize: 12, color: 'var(--text-3)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <span style={{ cursor: 'pointer', color: level === 'campaign' ? 'var(--text-1)' : 'var(--accent-light)', fontWeight: level === 'campaign' ? 700 : 400 }}
              onClick={() => setDrill({ campaignId: null, adsetId: null })}>Campaigns</span>
            {campaign && <> / <span style={{ cursor: 'pointer', color: level === 'adset' ? 'var(--text-1)' : 'var(--accent-light)', fontWeight: level === 'adset' ? 700 : 400 }}
              onClick={() => setDrill({ campaignId: drill.campaignId, adsetId: null })}>{campaign.name}</span></>}
            {adset && <> / <span style={{ fontWeight: 700 }}>{adset.name}</span></>}
          </div>
        </div>

        {/* table */}
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {/* header */}
          <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--line)', position: 'sticky', top: 0, background: 'var(--surface-1)', zIndex: 1 }}>
            <div style={{ fontSize: 10, color: 'var(--text-4)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
              {level === 'campaign' ? 'Campaign' : level === 'adset' ? 'Ad set' : 'Ad'}
            </div>
            {activeMetrics.map(k => (
              <div key={k} style={{ fontSize: 10, color: 'var(--text-4)', textAlign: 'right', textTransform: 'uppercase', letterSpacing: 0.3 }}>
                {defByKey[k]?.short}
              </div>
            ))}
          </div>
          {/* totals */}
          {totals && (
            <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: 8, padding: '9px 12px', borderBottom: '1px solid var(--line)', background: 'var(--bg-hover)' }}>
              <div style={{ fontSize: 12, fontWeight: 800 }}>Total</div>
              {activeMetrics.map(k => <div key={k}>{renderVal(totals, k)}</div>)}
            </div>
          )}
          {/* entity rows */}
          {rows.map(({ meta, t }) => (
            <div key={meta.id}
              onClick={() => {
                if (level === 'campaign') setDrill({ campaignId: meta.id, adsetId: null });
                else if (level === 'adset') setDrill({ campaignId: drill.campaignId, adsetId: meta.id });
              }}
              style={{
                display: 'grid', gridTemplateColumns: gridCols, gap: 8, padding: '10px 12px',
                borderBottom: '1px solid var(--line)', alignItems: 'center',
                cursor: level !== 'ad' ? 'pointer' : 'default',
              }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                {level === 'ad' && (
                  <span style={{ position: 'relative', flexShrink: 0, width: 40, height: 40, borderRadius: 6, overflow: 'hidden', background: 'var(--bg-hover)', border: '1px solid var(--line)' }}>
                    {meta.thumbnailUrl
                      ? <img src={meta.thumbnailUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                      : <span style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>🖼️</span>}
                    {meta.videoId && <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, textShadow: '0 1px 4px rgba(0,0,0,0.7)' }}>▶</span>}
                  </span>
                )}
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                    {level !== 'ad' && <span style={{ marginRight: 5, fontSize: 9, verticalAlign: 2, color: 'var(--viz-2)' }}>●</span>}
                    {meta.name}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {level === 'campaign' && (meta.dailyBudget != null ? `${fmtUsd(meta.dailyBudget)}/day` : meta.objective?.toLowerCase().replace(/_/g, ' '))}
                    {level === 'adset' && (meta.goalEvent || meta.optimizationGoal || '')}
                    {level === 'ad' && (
                      <a href={adsManagerUrl(acct, meta.id)} target="_blank" rel="noreferrer"
                        onClick={e => e.stopPropagation()} style={{ color: 'var(--accent-light)' }}>
                        ↗ open in Ads Manager
                      </a>
                    )}
                  </div>
                </div>
              </div>
              {activeMetrics.map(k => <div key={k}>{renderVal(t, k)}</div>)}
            </div>
          ))}
          {rows.length === 0 && <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: 'var(--text-4)' }}>Nothing delivered in this date range.</div>}
        </div>
      </>}
    </div>
  );
}

function Chip({ on, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      flexShrink: 0, padding: '4px 12px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer',
      border: on ? '1px solid rgba(25,158,112,0.5)' : '1px solid var(--border)',
      background: on ? 'rgba(25,158,112,0.12)' : 'var(--bg-hover)',
      color: on ? 'var(--viz-2)' : 'var(--text-3)',
      whiteSpace: 'nowrap',
    }}>{children}</button>
  );
}
