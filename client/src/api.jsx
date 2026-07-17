import axios from 'axios';
import { isDemoMode, maskDeep } from './demoMask.js';

// On Vercel: API is on the same origin, so '/api' works.
// For local dev: vite.config.js proxies '/api' to localhost:3001.
const BASE = import.meta.env.VITE_API_BASE || '/api';

const TOKEN_STORAGE_KEY = 'mw3-auth-token';

export function getAuthToken() {
  return localStorage.getItem(TOKEN_STORAGE_KEY) || '';
}

export function setAuthToken(token) {
  if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
  else localStorage.removeItem(TOKEN_STORAGE_KEY);
}

// Attaches the session token to every request; SSE/EventSource connections
// can't set headers, so their URL builders append `?token=` separately (see below).
axios.interceptors.request.use((config) => {
  const token = getAuthToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Demo/stream mode — mask sensitive data in EVERY API response centrally,
// so screen recordings never show real org/league/contact details.
// (Prefs are exempt so the dashboard's own config round-trips unmasked.)
axios.interceptors.response.use((res) => {
  if (isDemoMode() && res.data && !String(res.config?.url || '').includes('/prefs/')) {
    try { res.data = maskDeep(res.data); } catch {}
  }
  return res;
});

// On a 401 (expired/invalid session), clear the stored token and notify
// AuthContext so it can drop back to the login screen.
axios.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401 && getAuthToken()) {
      setAuthToken(null);
      window.dispatchEvent(new Event('mw3-auth-expired'));
    }
    return Promise.reject(err);
  }
);

// Append the auth token as a query param to a streaming (EventSource) URL,
// since native EventSource can't send an Authorization header.
export function withToken(url) {
  const token = getAuthToken();
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

export const api = {
  login: (username, password) => axios.post(`${BASE}/auth/login`, { username, password }),
  me:    () => axios.get(`${BASE}/auth/me`),

  listUsers:  ()       => axios.get(`${BASE}/users`),
  createUser: (body)   => axios.post(`${BASE}/users`, body),
  updateUser: (id, body) => axios.patch(`${BASE}/users/${id}`, body),
  deleteUser: (id)     => axios.delete(`${BASE}/users/${id}`),

  health:        () => axios.get(`${BASE}/health`),
  schema:        () => axios.get(`${BASE}/schema`),
  organizations: () => axios.get(`${BASE}/organizations`),

  registrations: (orgId, page=1, perPage=100) =>
    axios.get(`${BASE}/registrations`, { params: { orgId, page, perPage } }),

  // Rolling 90-day window — no year parameter needed
  recentRegistrations: (orgId) =>
    axios.get(`${BASE}/registrations/recent`, { params: { orgId } }),

  analyticsRegistration: (registrationId, orgId) =>
    axios.get(`${BASE}/analytics/registration`, { params: { registrationId, orgId } }),

  analyticsAggregate: (orgId, gradYearFilter='') =>
    axios.get(`${BASE}/analytics/aggregate`, { params: { orgId, gradYearFilter } }),

  registrationAnswers: (registrationId, orgId) =>
    axios.get(`${BASE}/registration-answers`, { params: { registrationId, orgId } }),

  profiles: (orgId, page=1, perPage=200) =>
    axios.get(`${BASE}/profiles`, { params: { orgId, page, perPage } }),

  graphql:    (query, variables={}) => axios.post(`${BASE}/graphql`, { query, variables }),
  clearCache: ()                    => axios.post(`${BASE}/cache/clear`),

  // ── Store + reports ──────────────────────────────────────────────────────────
  storeStatus:    () => axios.get(`${BASE}/store/status`),
  storeEvents:    () => axios.get(`${BASE}/store/events`),

  startAggregate: (orgId, delayMs=1200, events=[], purgeFirst=false) =>
    axios.post(`${BASE}/aggregate/start`, { orgId, delayMs, events, purgeFirst }),

  // Client-driven aggregation (Vercel)
  aggregatePlan:       (orgId, year)  => axios.get(`${BASE}/aggregate/plan`,        { params: { orgId, year } }),
  aggregateFetchEvent: (body)         => axios.post(`${BASE}/aggregate/fetch-event`, body),

  // SSE stream URL for purge+reload (use with EventSource, not axios)
  purgeReloadStreamUrl: (eventId, orgId) =>
    withToken(`${BASE}/store/purge-reload-stream?eventId=${encodeURIComponent(eventId)}&orgId=${encodeURIComponent(orgId)}`),

  // Purge only (no re-fetch)
  purge: (eventId) =>
    axios.post(`${BASE}/store/purge`, { eventId }),

  reportDaily:        (params={}) => axios.get(`${BASE}/reports/daily`,          { params }),
  reportGradYears:    (params={}) => axios.get(`${BASE}/reports/grad-years`,      { params }),
  reportEvents:       (params={}) => axios.get(`${BASE}/reports/events`,          { params }),
  reportRecent:       ()          => axios.get(`${BASE}/reports/recent`),
  reportResults:      (params={}) => axios.get(`${BASE}/reports/results`,         { params }),
  reportDailyActivity:(date)      => axios.get(`${BASE}/reports/daily-activity`,  { params: { date } }),
  reportYoY:          ()          => axios.get(`${BASE}/reports/yoy`),
  reportYoyDaily:     ()          => axios.get(`${BASE}/reports/yoy-daily`),
  reportYoyRetention: (p)         => axios.get(`${BASE}/reports/yoy-retention`, { params: p }),
  reportLeagueDetail:  (eventId)            => axios.get(`${BASE}/reports/league-detail`,  { params: { eventId } }),
  reportLeagueOverlap: (eventIdA, eventIdB)    => axios.get(`${BASE}/reports/league-overlap`,  { params: { eventIdA, eventIdB } }),
  reportLeagueScatter:      (sourceEventId, year) => axios.get(`${BASE}/reports/league-scatter`,             { params: { sourceEventId, year } }),
  reportLeagueScatterIndiv:  (sourceEventId, year)                  => axios.get(`${BASE}/reports/league-scatter-individuals`, { params: { sourceEventId, year } }),
  reportLapsedIndividuals:   (sourceYear, excludeYear, sourceEventIds, excludeEventIds) => axios.get(`${BASE}/reports/lapsed-individuals`, { params: { sourceYear, excludeYear, sourceEventIds, excludeEventIds } }),
  reportFormFields:    (eventId, orgId)         => axios.get(`${BASE}/reports/form-fields`,    { params: { eventId, orgId } }),
  reportLeagueEmails:  (eventId)               => axios.get(`${BASE}/reports/league-emails`,  { params: { eventId } }),
  facebookCsvUrl:     (eventId)   => `${BASE}/reports/facebook-csv?eventId=${encodeURIComponent(eventId)}`,
  facebookCsvAllUrl:  (eventIds)  => `${BASE}/reports/facebook-csv?eventIds=${eventIds.map(encodeURIComponent).join(',')}`,
  leagueCsvUrl:       (eventId, year, gender) => {
    const p = new URLSearchParams({ eventId });
    if (year)   p.set('year',   year);
    if (gender) p.set('gender', gender);
    return `${BASE}/export/league-csv?${p}`;
  },
  leagueCsvStreamUrl: (eventId, years, genders) => {
    const p = new URLSearchParams({ eventId });
    // years / genders can be Array or comma-string or null
    const toStr = v => Array.isArray(v) ? v.join(',') : (v || '');
    const ys = toStr(years);   if (ys) p.set('years',   ys);
    const gs = toStr(genders); if (gs) p.set('genders', gs);
    return withToken(`${BASE}/export/league-csv-stream?${p}`);
  },
  leagueCsvDownloadUrl:  (token) => `${BASE}/export/league-csv-download?token=${encodeURIComponent(token)}`,
  leagueCsvDeleteUrl:    (token) => `${BASE}/export/league-csv/${encodeURIComponent(token)}`,
  deleteLeagueCsvExport: (token) => axios.delete(`${BASE}/export/league-csv/${encodeURIComponent(token)}`),
  listExports:   (eventId) => axios.get(`${BASE}/exports`, { params: { eventId } }),
  saveExport:    (meta)    => axios.post(`${BASE}/exports`, meta),
  deleteExport:  (id)      => axios.delete(`${BASE}/exports/${id}`),

  recomputeStats: () => axios.post(`${BASE}/admin/recompute-stats`),

  // ── Registration deadlines (scraped from midwest3on3.com) ─────────────────
  scrapeDeadlines: ()            => axios.post(`${BASE}/admin/scrape-deadlines`),
  getDeadlines:    ()            => axios.get(`${BASE}/deadlines`),
  deadlineCoverage:(year)        => axios.get(`${BASE}/deadlines-coverage`, { params: { year } }),
  setDeadline:     (eventId, b)  => axios.put(`${BASE}/deadlines/${encodeURIComponent(eventId)}`, b),
  deadlinesExportUrl: ()         => withToken(`${BASE}/deadlines/export`),
  importDeadlines: (body)        => axios.post(`${BASE}/deadlines/import`, body),

  // ── Super admin: site settings + organizations ─────────────────────────────
  getSiteSettings: ()      => axios.get(`${BASE}/site-settings`),
  setSiteSettings: (body)  => axios.put(`${BASE}/site-settings`, body),
  listAccounts:  ()             => axios.get(`${BASE}/admin/accounts`),
  saveAccount:   (key, body)    => axios.put(`${BASE}/admin/accounts/${encodeURIComponent(key)}`, body),
  deleteAccount: (key, body)    => axios.delete(`${BASE}/admin/accounts/${encodeURIComponent(key)}`, { data: body || {} }),
  listOrgs:  ()            => axios.get(`${BASE}/admin/orgs`),
  saveOrg:   (orgKey, body)=> axios.put(`${BASE}/admin/orgs/${encodeURIComponent(orgKey)}`, body),
  deleteOrg: (orgKey, body)     => axios.delete(`${BASE}/admin/orgs/${encodeURIComponent(orgKey)}`, { data: body || {} }),
  verifyOrg: (orgKey, body)     => axios.post(`${BASE}/admin/orgs/${encodeURIComponent(orgKey)}/verify`, body || {}),
  requestDelete: (body)         => axios.post(`${BASE}/admin/delete-request`, body),
  companyMe:    ()              => axios.get(`${BASE}/company/me`),
  companyUsers: ()              => axios.get(`${BASE}/company/users`),
  companyCreateUser: (body)     => axios.post(`${BASE}/company/users`, body),
  companyCreateOrg:  (body)     => axios.post(`${BASE}/company/orgs`, body),

  // ── Growth: signup, billing, offers, feedback ──────────────────────────────
  signupAvailability: () => axios.get(`${BASE}/signup/availability`),
  signup:          (body) => axios.post(`${BASE}/signup`, body),
  billingMe:       ()     => axios.get(`${BASE}/billing/me`),
  billingCheckout: ()     => axios.post(`${BASE}/billing/checkout`),
  billingPortal:   ()     => axios.post(`${BASE}/billing/portal`),
  getOffers:       ()     => axios.get(`${BASE}/offers`),
  adminOffers:     ()     => axios.get(`${BASE}/admin/offers`),
  saveOffers:      (offers) => axios.put(`${BASE}/admin/offers`, { offers }),
  sendFeedback:    (body) => axios.post(`${BASE}/feedback`, body),
  reportError:     (body) => axios.post(`${BASE}/feedback/error`, body).catch(() => {}),
  getFeedback:     ()     => axios.get(`${BASE}/feedback`),
  setFeedbackStatus: (id, status) => axios.put(`${BASE}/feedback/${encodeURIComponent(id)}`, { status }),
  getCustomers:    ()     => axios.get(`${BASE}/admin/customers`),
  getGrowth:       ()     => axios.get(`${BASE}/admin/growth`),
  getSeWebhooks:   ()     => axios.get(`${BASE}/admin/sewebhooks`),
  getWebhookDeliveries: () => axios.get(`${BASE}/webhooks/deliveries`),
  reprocessWebhooks:    () => axios.post(`${BASE}/webhooks/reprocess`),
  auditWebhooks:    (days) => axios.post(`${BASE}/webhooks/audit7d?days=${days || 7}`),
  getWebhookPage: (offset, sentOnly, view) => axios.get(`${BASE}/webhooks/deliveries?offset=${offset}&limit=50${sentOnly ? '&sent=1' : ''}${view === 'audit' ? '&view=audit' : ''}`),
  getCompanyTracking:  ()     => axios.get(`${BASE}/company/tracking`),
  saveCompanyTracking: (body) => axios.put(`${BASE}/company/tracking`, body),
  saveGrowth:      (body) => axios.put(`${BASE}/admin/growth`, body),

  // ── Meta Ads reporting ─────────────────────────────────────────────────────
  adsSettings:     ()      => axios.get(`${BASE}/ads/settings`),
  adsSaveSettings: (body)  => axios.put(`${BASE}/ads/settings`, body),
  adsSync:         ()      => axios.post(`${BASE}/ads/sync`),
  adsData:         ()      => axios.get(`${BASE}/ads/data`),

  // ── Per-user UI preferences (server-persisted, survives devices) ──────────
  getPref: (key)        => axios.get(`${BASE}/prefs/${encodeURIComponent(key)}`),
  setPref: (key, value) => axios.put(`${BASE}/prefs/${encodeURIComponent(key)}`, { value: JSON.stringify(value) }),

  // ── Audience export (FB Audiences page) — reads straight from main store ──
  contactsPreview: (params) => axios.get(`${BASE}/contacts/preview`, { params }),
  contactsExportUrl: (params) => {
    const p = new URLSearchParams();
    if (params.eventIds)     p.set('eventIds',     params.eventIds.join(','));
    if (params.gradYearFrom) p.set('gradYearFrom', params.gradYearFrom);
    if (params.gradYearTo)   p.set('gradYearTo',   params.gradYearTo);
    if (params.genders)      p.set('genders',      params.genders.join(','));
    if (params.label)        p.set('label',        params.label);
    return withToken(`${BASE}/contacts/export?${p}`);
  },
};
