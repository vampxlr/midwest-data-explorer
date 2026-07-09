import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis,
  Tooltip, CartesianGrid, Legend,
} from 'recharts';
import { toast } from 'react-hot-toast';
import { api } from '../api.jsx';
import { useAuth } from '../AuthContext.jsx';
import { findPriorMatch } from '../components/LeagueYoyCompare.jsx';
import Collapsible from '../components/Collapsible.jsx';

/**
 * 📣 Meta Ads — campaign reporting tied to SportsEngine sales pace.
 *  - Setup card: paste a Marketing API token + ad account id in-app (write-only,
 *    encrypted server-side) or fall back to server env vars.
 *  - Sync pulls ACTIVE campaigns w/ recent spend, their ads/creatives and daily
 *    insights; campaigns auto-classify to leagues via landing URL + name.
 *  - Per campaign: alias, league mapping (auto-suggested, manually overridable),
 *    spend chart + cumulative results vs SE registrations pace w/ prior season.
 */

const FRIENDLY = {
  link_click: 'Link Clicks',
  landing_page_view: 'Landing Page Views',
  video_view: 'Video Views',
  'offsite_conversion.fb_pixel_custom': 'Custom Pixel Events (all)',
  'offsite_conversion.fb_pixel_lead': 'Leads (pixel)',
  'offsite_conversion.fb_pixel_complete_registration': 'Complete Registration',
  'offsite_conversion.fb_pixel_initiate_checkout': 'Initiate Checkout',
};
const DEFAULT_METRICS = ['landing_page_view', 'offsite_conversion.fb_pixel_custom'];
const STALE_MS = 6 * 3600 * 1000;          // auto re-sync when data older than 6h
const METRIC_COLORS = ['var(--viz-3)', 'var(--viz-4)', 'var(--viz-6)', 'var(--viz-7)', 'var(--viz-8)'];

const metricLabel = (m, ccNames = {}) => ccNames[m] || FRIENDLY[m] || m.replace(/^offsite_conversion\./, '');
const fmtUsd = (n) => '$' + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
const agoLabel = (iso) => {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};
const adsManagerUrl = (acct, adId) =>
  `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${acct}${adId ? `&selected_ad_ids=${adId}` : ''}`;

const CLASS_STYLE = {
  league:            { label: '🏀 League',      bg: 'rgba(25,158,112,0.14)', color: 'var(--viz-2)' },
  'general-leagues': { label: '🏀 Leagues (general)', bg: 'rgba(90,120,255,0.14)', color: 'var(--viz-1)' },
  tournaments:       { label: '🏆 Tournaments', bg: 'rgba(240,180,60,0.14)',  color: 'var(--viz-5)' },
  camps:             { label: '⛺ Camps',       bg: 'rgba(200,90,255,0.14)',  color: 'var(--viz-6)' },
  unknown:           { label: '❔ Unmapped',    bg: 'var(--bg-hover)',        color: 'var(--text-4)' },
};

/* ── Settings / setup card ──────────────────────────────────────────────── */
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

/* ── Per-campaign report card ───────────────────────────────────────────── */
function CampaignCard({ c, ads, insights, mapping, ccNames, metrics, eventOptions, eventById, canEdit, adAccountId, onMap }) {
  const alias = mapping?.alias || null;
  const eventId = mapping?.eventId !== undefined && mapping?.eventId !== null
    ? String(mapping.eventId) : (c.suggestedEventId ? String(c.suggestedEventId) : '');
  const mappedEv = eventId ? eventById[eventId] : null;
  const isAutoMapped = !mapping?.eventId && !!c.suggestedEventId;

  const [editingAlias, setEditingAlias] = useState(false);
  const [aliasDraft, setAliasDraft] = useState(alias || '');
  const [series, setSeries] = useState({ cur: [], prior: [], priorName: null });

  // SE registration pace for the mapped league (+ prior season for acceleration)
  useEffect(() => {
    let dead = false;
    if (!mappedEv) { setSeries({ cur: [], prior: [], priorName: null }); return; }
    const prior = findPriorMatch(mappedEv, Object.values(eventById));
    Promise.all([
      api.reportDaily({ eventId: mappedEv.id }),
      prior ? api.reportDaily({ eventId: prior.id }) : Promise.resolve({ data: { daily: [] } }),
    ]).then(([a, b]) => {
      if (!dead) setSeries({ cur: a.data.daily || [], prior: b.data.daily || [], priorName: prior?.name || null });
    }).catch(() => {});
    return () => { dead = true; };
  }, [eventId]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    const mine = insights.filter(i => i.c === c.id).sort((a, b) => a.d.localeCompare(b.d));
    if (!mine.length) return [];
    const byDay = {}; for (const i of mine) byDay[i.d] = i;
    const start = mine[0].d, end = new Date().toISOString().slice(0, 10);
    const regs = {}; for (const r of series.cur) regs[r.date] = (regs[r.date] || 0) + r.total;
    // prior season overlaid by same MM-DD one year earlier
    const priorRegs = {}; for (const r of series.prior) priorRegs[r.date.slice(5)] = (priorRegs[r.date.slice(5)] || 0) + r.total;
    const out = [];
    let cumSpend = 0, cumRegs = 0, cumPrior = 0;
    const cumMetrics = Object.fromEntries(metrics.map(m => [m, 0]));
    for (let d = new Date(start + 'T12:00:00Z'); d.toISOString().slice(0, 10) <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const day = d.toISOString().slice(0, 10);
      const i = byDay[day];
      cumSpend += i?.spend || 0;
      cumRegs  += regs[day] || 0;
      cumPrior += priorRegs[day.slice(5)] || 0;
      const row = {
        day, label: day.slice(5).replace('-', '/'),
        spend: +(i?.spend || 0).toFixed(2), cumSpend: +cumSpend.toFixed(2),
        regs: series.cur.length ? cumRegs : undefined,
        priorRegs: series.prior.length ? cumPrior : undefined,
      };
      for (const m of metrics) { cumMetrics[m] += i?.actions?.[m] || 0; row[m] = cumMetrics[m]; }
      out.push(row);
    }
    return out;
  }, [insights, c.id, metrics, series]);

  const last = rows[rows.length - 1] || {};
  const yesterdaySpend = rows.length > 1 ? rows[rows.length - 2].spend : 0;
  const myAds = ads.filter(a => a.campaignId === c.id);
  const cls = CLASS_STYLE[c.classification] || CLASS_STYLE.unknown;

  function saveAlias() {
    setEditingAlias(false);
    if ((aliasDraft.trim() || null) !== alias) onMap(c.id, { alias: aliasDraft.trim() });
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      {/* header: alias / name / class chip / KPIs */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {editingAlias ? (
              <input autoFocus value={aliasDraft} onChange={e => setAliasDraft(e.target.value)}
                onBlur={saveAlias} onKeyDown={e => { if (e.key === 'Enter') saveAlias(); }}
                placeholder="Friendly name for the client" style={{ fontSize: 15, fontWeight: 700, width: 280 }} />
            ) : (
              <h3 style={{ margin: 0, fontSize: 16 }}>
                {alias || c.name}
                {canEdit && <button onClick={() => { setAliasDraft(alias || ''); setEditingAlias(true); }}
                  title="Set a friendly alias" style={{ marginLeft: 6, border: 'none', background: 'none', cursor: 'pointer', fontSize: 12 }}>✏️</button>}
              </h3>
            )}
            <span style={{ fontSize: 11, fontWeight: 700, borderRadius: 999, padding: '2px 9px', background: cls.bg, color: cls.color }}>{cls.label}</span>
          </div>
          {alias && <div style={{ fontSize: 11, color: 'var(--text-4)', marginTop: 2 }}>{c.name}</div>}
          <div style={{ fontSize: 11, color: 'var(--text-4)', marginTop: 2 }}>
            {c.startTime && <>started {c.startTime.slice(0, 10)} · </>}
            {c.dailyBudget != null && <>{fmtUsd(c.dailyBudget)}/day budget · </>}
            {c.landingUrl && <a href={c.landingUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-light)' }}>{c.landingUrl.replace(/^https?:\/\/(www\.)?/, '')}</a>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <Kpi label="Total spend" value={fmtUsd(last.cumSpend ?? c.totalSpend)} />
          <Kpi label="Yesterday" value={fmtUsd(yesterdaySpend)} />
          {mappedEv && last.regs !== undefined && <Kpi label="Sales (campaign window)" value={last.regs} accent />}
          <a className="btn" href={adsManagerUrl(adAccountId)} target="_blank" rel="noreferrer"
            title="Open this account in Meta Ads Manager">↗ Ads Manager</a>
        </div>
      </div>

      {/* league mapping */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, color: 'var(--text-4)' }}>Mapped league:</span>
        {canEdit ? (
          <select value={eventId} onChange={e => onMap(c.id, { eventId: e.target.value || null })} style={{ maxWidth: 360, fontSize: 12 }}>
            <option value="">— not mapped —</option>
            {eventOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : (
          <span style={{ fontSize: 12 }}>{mappedEv?.name || '— not mapped —'}</span>
        )}
        {isAutoMapped && mappedEv && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--viz-2)' }}>✨ auto</span>}
        {isAutoMapped && !mappedEv && c.suggestedEventName &&
          <span style={{ fontSize: 11, color: 'var(--text-4)' }}>looks like “{c.suggestedEventName}” (no registrations yet)</span>}
        {series.priorName && <span style={{ fontSize: 11, color: 'var(--text-4)' }}>· pace vs {series.priorName}</span>}
      </div>

      {/* stacked aligned charts: $ spend on top, counts below (shared x axis) */}
      {rows.length > 0 && (
        <>
          <div style={{ height: 130, marginTop: 12 }}>
            <ResponsiveContainer>
              <ComposedChart data={rows} syncId={`ads-${c.id}`} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 9, fill: 'var(--text-4)' }} minTickGap={28} />
                <YAxis tick={{ fontSize: 9, fill: 'var(--text-4)' }} width={44} tickFormatter={v => '$' + v} />
                <Tooltip contentStyle={{ background: 'var(--surface-1)', border: '1px solid var(--line)', fontSize: 11 }}
                  formatter={(v, n) => [n === 'Daily spend' || n === 'Cumulative spend' ? fmtUsd(v) : v, n]} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Bar dataKey="spend" name="Daily spend" fill="var(--viz-1)" opacity={0.55} radius={[2, 2, 0, 0]} />
                <Line dataKey="cumSpend" name="Cumulative spend" stroke="var(--viz-5)" strokeWidth={2} dot={false} type="monotone" />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div style={{ height: 170 }}>
            <ResponsiveContainer>
              <ComposedChart data={rows} syncId={`ads-${c.id}`} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--line)" strokeDasharray="2 4" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 9, fill: 'var(--text-4)' }} minTickGap={28} />
                <YAxis tick={{ fontSize: 9, fill: 'var(--text-4)' }} width={44} allowDecimals={false} />
                <Tooltip contentStyle={{ background: 'var(--surface-1)', border: '1px solid var(--line)', fontSize: 11 }} />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                {metrics.map((m, i) => (
                  <Line key={m} dataKey={m} name={metricLabel(m, ccNames)} stroke={METRIC_COLORS[i % METRIC_COLORS.length]}
                    strokeWidth={1.7} dot={false} type="monotone" />
                ))}
                {last.regs !== undefined &&
                  <Line dataKey="regs" name="Registrations (SE)" stroke="var(--viz-2)" strokeWidth={2.4} dot={false} type="monotone" />}
                {last.priorRegs !== undefined &&
                  <Line dataKey="priorRegs" name="Last season pace" stroke="var(--viz-2)" strokeWidth={1.6}
                    strokeDasharray="5 4" opacity={0.6} dot={false} type="monotone" />}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </>
      )}

      {/* creatives strip — click opens the ad in Ads Manager (video plays there) */}
      {myAds.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--text-4)', marginBottom: 6 }}>
            Creatives ({myAds.length}) — click to open in Ads Manager{myAds.some(a => a.videoId) && ' (videos play there)'}
          </div>
          <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
            {myAds.map(a => (
              <a key={a.id} href={adsManagerUrl(adAccountId, a.id)} target="_blank" rel="noreferrer"
                title={(mapping?.adAliases?.[a.id] || a.title || a.name) + ' — open in Ads Manager'}
                style={{ flexShrink: 0, width: 96, textDecoration: 'none', color: 'var(--text-3)' }}>
                <div style={{ position: 'relative', width: 96, height: 96, borderRadius: 8, overflow: 'hidden', background: 'var(--bg-hover)', border: '1px solid var(--line)' }}>
                  {a.thumbnailUrl
                    ? <img src={a.thumbnailUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    : <span style={{ display: 'flex', height: '100%', alignItems: 'center', justifyContent: 'center', fontSize: 24 }}>🖼️</span>}
                  {a.videoId && <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, textShadow: '0 1px 6px rgba(0,0,0,0.7)' }}>▶</span>}
                </div>
                <div style={{ fontSize: 9, lineHeight: 1.25, marginTop: 3, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                  {mapping?.adAliases?.[a.id] || a.title || a.name}
                </div>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Kpi({ label, value, accent }) {
  return (
    <div style={{ textAlign: 'right' }}>
      <div style={{ fontSize: 10, color: 'var(--text-4)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: accent ? 'var(--viz-2)' : 'var(--text-1)' }}>{value}</div>
    </div>
  );
}

/* ── Page ───────────────────────────────────────────────────────────────── */
export default function AdsReport({ ctx }) {
  const { user, isSuperAdmin } = useAuth();
  const canSync = isSuperAdmin || ['admin', 'editor'].includes(user?.role);
  const isAdmin = isSuperAdmin || user?.role === 'admin';

  const [payload, setPayload]   = useState(null);   // {data, mappings, configured, adAccountId}
  const [settings, setSettings] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [syncing, setSyncing]   = useState(false);
  const [metrics, setMetrics]   = useState(DEFAULT_METRICS);
  const autoSynced = useRef(false);

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
    api.getPref('ads-metrics').then(r => {
      const v = r.data?.value && JSON.parse(r.data.value);
      if (Array.isArray(v) && v.length) setMetrics(v);
    }).catch(() => {});
    load().then(p => {
      // keep the report fresh without anyone pressing buttons
      const stale = !p?.data?.syncedAt || (Date.now() - new Date(p.data.syncedAt).getTime()) > STALE_MS;
      if (stale && p?.configured && canSync && !autoSynced.current) { autoSynced.current = true; sync(); }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleMetric(m) {
    setMetrics(prev => {
      const next = prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m];
      api.setPref('ads-metrics', next).catch(() => {});
      return next;
    });
  }

  async function onMap(campaignId, body) {
    try {
      await api.adsMap(campaignId, body);
      setPayload(p => ({
        ...p,
        mappings: { ...p.mappings, [campaignId]: { ...(p.mappings?.[campaignId] || {}), ...body } },
      }));
      toast.success('Saved');
    } catch { toast.error('Could not save'); }
  }

  const eventOptions = useMemo(() => (ctx?.recentRegs || [])
    .slice()
    .sort((a, b) => (b.close || b.open || '').localeCompare(a.close || a.open || ''))
    .map(r => ({ value: String(r.id), label: r.name })), [ctx?.recentRegs]);
  const eventById = useMemo(() => {
    const m = {}; for (const r of (ctx?.recentRegs || [])) m[String(r.id)] = r; return m;
  }, [ctx?.recentRegs]);

  if (!payload) return <div style={{ padding: 24, color: 'var(--text-4)' }}>Loading ads data…</div>;

  const { data, mappings, configured, adAccountId } = payload;
  const campaigns = (data?.campaigns || []).slice().sort((a, b) => b.totalSpend - a.totalSpend);
  const availableMetrics = data?.discoveredMetrics || [];

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0 }}>📣 Meta Ads</h2>
          <div style={{ fontSize: 12, color: 'var(--text-4)' }}>
            {data ? <>Synced {agoLabel(data.syncedAt)} · {campaigns.length} live campaigns
              {data.zombieActiveCount > 0 && <> · {data.zombieActiveCount} inactive hidden</>}</>
              : 'No data synced yet'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {canSync && configured &&
            <button className="btn" onClick={sync} disabled={syncing}>{syncing ? '⏳ Syncing…' : '🔄 Sync now'}</button>}
          {isAdmin &&
            <button className="btn" onClick={() => setShowSettings(s => !s)}>⚙️ Settings</button>}
        </div>
      </div>

      {(!configured || showSettings) && isAdmin &&
        <SettingsCard settings={settings} firstRun={!configured}
          onSaved={() => { setShowSettings(false); load(); }} />}
      {!configured && !isAdmin &&
        <div className="card">Ads reporting isn't configured yet — ask an admin to add the Meta access token.</div>}

      {configured && !data &&
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <p style={{ color: 'var(--text-3)' }}>Connected — run the first sync to pull campaigns, creatives and daily insights.</p>
          {canSync && <button className="btn btn-primary" onClick={sync} disabled={syncing}>{syncing ? '⏳ Syncing…' : '🔄 Sync now'}</button>}
        </div>}

      {data && availableMetrics.length > 0 && (
        <Collapsible title="📐 Report metrics" defaultOpen={false} style={{ marginTop: 0, marginBottom: 16 }}
          subtitle="Pick which custom parameters show as cumulative lines on every campaign chart — saved to your profile">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {availableMetrics.map(m => {
              const on = metrics.includes(m);
              return (
                <button key={m} onClick={() => toggleMetric(m)} style={{
                  padding: '4px 12px', borderRadius: 999, fontSize: 12, cursor: 'pointer', fontWeight: 600,
                  border: on ? '1px solid rgba(25,158,112,0.5)' : '1px solid var(--border)',
                  background: on ? 'rgba(25,158,112,0.12)' : 'var(--bg-hover)',
                  color: on ? 'var(--viz-2)' : 'var(--text-3)',
                }}>
                  {on ? '✓ ' : ''}{metricLabel(m, data.ccNames)}
                </button>
              );
            })}
          </div>
        </Collapsible>
      )}

      {data && campaigns.map(c => (
        <CampaignCard key={c.id} c={c} ads={data.ads || []} insights={data.insights || []}
          mapping={mappings?.[c.id]} ccNames={data.ccNames || {}} metrics={metrics}
          eventOptions={eventOptions} eventById={eventById}
          canEdit={canSync} adAccountId={adAccountId || data.adAccountId} onMap={onMap} />
      ))}
    </div>
  );
}
