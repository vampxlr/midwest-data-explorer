import axios from 'axios';

// On Vercel: API is on the same origin, so '/api' works.
// For local dev: vite.config.js proxies '/api' to localhost:3001.
const BASE = import.meta.env.VITE_API_BASE || '/api';

export const api = {
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
    `${BASE}/store/purge-reload-stream?eventId=${encodeURIComponent(eventId)}&orgId=${encodeURIComponent(orgId)}`,

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
    return `${BASE}/export/league-csv-stream?${p}`;
  },
  leagueCsvDownloadUrl:  (token) => `${BASE}/export/league-csv-download?token=${encodeURIComponent(token)}`,
  leagueCsvDeleteUrl:    (token) => `${BASE}/export/league-csv/${encodeURIComponent(token)}`,
  deleteLeagueCsvExport: (token) => axios.delete(`${BASE}/export/league-csv/${encodeURIComponent(token)}`),
  listExports:   (eventId) => axios.get(`${BASE}/exports`, { params: { eventId } }),
  saveExport:    (meta)    => axios.post(`${BASE}/exports`, meta),
  deleteExport:  (id)      => axios.delete(`${BASE}/exports/${id}`),

  // ── Contact store (FB Audiences page) ─────────────────────────────────────
  contactsStatus:  ()       => axios.get(`${BASE}/contacts/status`),
  contactsPreview: (params) => axios.get(`${BASE}/contacts/preview`, { params }),
  contactsFetch:   (body)   => axios.post(`${BASE}/contacts/fetch`, body),
  contactsPurge:   (body)   => axios.post(`${BASE}/contacts/purge`, body),
  contactsExportUrl: (params) => {
    const p = new URLSearchParams();
    if (params.eventIds)     p.set('eventIds',     params.eventIds.join(','));
    if (params.gradYearFrom) p.set('gradYearFrom', params.gradYearFrom);
    if (params.gradYearTo)   p.set('gradYearTo',   params.gradYearTo);
    if (params.genders)      p.set('genders',      params.genders.join(','));
    if (params.label)        p.set('label',        params.label);
    return `${BASE}/contacts/export?${p}`;
  },
};
