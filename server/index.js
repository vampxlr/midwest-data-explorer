require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const axios      = require('axios');
const fs         = require('fs');
const path       = require('path');
const NodeCache  = require('node-cache');
const rateLimit  = require('express-rate-limit');
const store        = require('./store');
const contactStore = require('./contactStore');
const blobStorage  = require('./blobStorage');

// Aggregator only used for local SSE-based flow; on Vercel we use client-driven endpoints
let aggregator = null;
try { aggregator = require('./aggregator'); } catch {}

// ── Export history metadata (now async via blobStorage) ───────────────────────
async function loadExportsMeta() {
  return blobStorage.readJSON('exports-meta.json', []);
}
async function saveExportsMeta(list) {
  return blobStorage.writeJSON('exports-meta.json', list);
}

const app = express();
const cache = new NodeCache({ stdTTL: 300 });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(rateLimit({ windowMs: 60000, max: 200 }));

const SE_TOKEN_URL = 'https://user.sportsengine.com/oauth/token';
const SE_GRAPHQL_URL = 'https://api.sportsengine.com/graphql';

let tokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 30000) {
    return tokenCache.token;
  }
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('client_id', process.env.CLIENT_ID);
  params.append('client_secret', process.env.CLIENT_SECRET);
  const res = await axios.post(SE_TOKEN_URL, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  tokenCache.token = res.data.access_token;
  tokenCache.expiresAt = Date.now() + (res.data.expires_in || 3600) * 1000;
  return tokenCache.token;
}

async function graphql(query, variables = {}) {
  const token = await getAccessToken();
  const res = await axios.post(
    SE_GRAPHQL_URL,
    { query, variables },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return res.data;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Returns the UTC timestamp for N days ago. */
function daysAgo(n) { return Date.now() - n * 86400000; }

/**
 * An event is "in window" if:
 *  - It is currently OPEN (status === 1), OR
 *  - Its close date is within the last `days` days, OR
 *  - Its open date is within the last `days` days.
 * This gives us a rolling 90-day window regardless of year.
 */
function inWindow(reg, days = 90) {
  const cutoff = daysAgo(days);
  if (reg.status === 1) return true;                                          // currently open
  if (reg.close && new Date(reg.close).getTime() >= cutoff) return true;     // closed within window
  if (reg.open  && new Date(reg.open).getTime()  >= cutoff) return true;     // opened within window
  return false;
}

const ANSWERS_QUERY = `query($regId: ID!, $orgId: Int!, $page: Int, $perPage: Int!) {
  registration(id: $regId, organizationId: $orgId) {
    id name resultsCompleted
    registrationResults(page: $page, perPage: $perPage) {
      id profileId completed status created
      answers {
        name
        ... on StringRegistrationResultAnswer { strValue: value }
        ... on NumberRegistrationResultAnswer { numValue: value }
        ... on ArrayRegistrationResultAnswer  { arrValue: value }
      }
    }
  }
}`;

/**
 * Fetch ALL registrationResults for one event, paginating automatically.
 * registrationResults defaults to 25/page — this loops until exhausted.
 * Returns a registration-shaped object with the full flat results array.
 */
// SportsEngine GraphQL complexity limit: 101.
// registrationResults with answers inline fragments hits 202 at perPage:100.
// perPage:25 is the proven safe value (their own default page size).
async function fetchAllRegistrationResults(regId, orgId, logFn) {
  const PER_PAGE = 25;
  let allResults = [];
  let regMeta    = null;
  let page       = 1;

  do {
    const data = await graphql(ANSWERS_QUERY, {
      regId:   String(regId),
      orgId:   parseInt(orgId),
      page,
      perPage: PER_PAGE,
    });
    const reg = data?.data?.registration;
    if (!reg) break;
    regMeta = reg;
    const batch = reg.registrationResults || [];
    allResults = allResults.concat(batch);

    if (logFn) {
      const total = reg.resultsCompleted || '?';
      logFn(`  ← page ${page}: +${batch.length} results (${allResults.length}/${total} total)`, 'response');
    }

    if (batch.length < PER_PAGE) break; // last page
    page++;
    // Small delay between pages to stay within rate limits
    await new Promise(r => setTimeout(r, 300));
  } while (true);

  return { ...regMeta, registrationResults: allResults };
}

function resolveAnswerVal(a) {
  if (a.strValue !== undefined && a.strValue !== null) return String(a.strValue);
  if (a.numValue !== undefined && a.numValue !== null) return String(a.numValue);
  if (a.arrValue !== undefined && a.arrValue !== null)
    return Array.isArray(a.arrValue) ? a.arrValue[0] : String(a.arrValue);
  return null;
}

function pickAnswer(answers, ...keys) {
  const lower = keys.map(k => k.toLowerCase());
  for (const a of answers) {
    if (lower.some(k => (a.name || '').toLowerCase().includes(k)))
      return resolveAnswerVal(a);
  }
  return null;
}

function pickAnswerAll(answers, ...keys) {
  const lower = keys.map(k => k.toLowerCase());
  return answers
    .filter(a => lower.some(k => (a.name || '').toLowerCase().includes(k)))
    .map(resolveAnswerVal)
    .filter(Boolean);
}

// Used by the client-driven fetch-event endpoint to parse form answers into
// the same shape that the aggregator stores: { gradYears, gender, city, state, zip }
function extractAnswers(answers) {
  const ans = answers || [];
  const gradYears = pickAnswerAll(ans, 'graduation year', 'grad year')
    .filter(v => /^\d{4}$/.test(String(v).trim()))
    .map(v => String(v).trim());

  if (!gradYears.length) {
    const div = pickAnswer(ans, 'desired division', 'division of play');
    if (div) { const y = String(div).replace(/\D/g, ''); if (y.length === 4) gradYears.push(y); }
  }

  const city  = pickAnswer(ans, 'city');
  const state = pickAnswer(ans, 'state/province', 'state');
  const zipRaw = pickAnswer(ans, 'zip', 'postal');

  return {
    gradYears,
    gender: pickAnswer(ans, 'gender of team', 'gender') || null,
    city:   city  ? city.trim()  : null,
    state:  state ? state.trim() : null,
    zip:    zipRaw ? String(zipRaw).trim().slice(0, 5) : null,
  };
}

function aggregateAnswers(results) {
  const gradYearMap = {}, genderMap = {}, stateMap = {}, cityMap = {}, zipMap = {}, divisionMap = {};
  let teams = 0;

  for (const r of results) {
    if (!r.completed) continue;
    teams++;
    const ans = r.answers || [];

    // Graduation years — can appear multiple times (Player 1, 2, 3…)
    const gradYears = pickAnswerAll(ans, 'graduation year', 'grad year');
    if (gradYears.length > 0) {
      for (const gy of gradYears) {
        const y = String(gy).replace(/[^0-9]/g, '');
        if (y.length === 4) gradYearMap[y] = (gradYearMap[y] || 0) + 1;
      }
    } else {
      // Fallback: desired division of play often encodes grad year
      const div = pickAnswer(ans, 'desired division', 'division of play');
      if (div) {
        const y = String(div).replace(/[^0-9]/g, '');
        if (y.length === 4) gradYearMap[y] = (gradYearMap[y] || 0) + 1;
      }
    }

    const gender = pickAnswer(ans, 'gender of team', 'gender');
    if (gender) genderMap[gender] = (genderMap[gender] || 0) + 1;

    const division = pickAnswer(ans, 'desired division', 'division of play');
    if (division) {
      const y = String(division).replace(/[^0-9]/g, '');
      const label = y.length === 4 ? y : division;
      divisionMap[label] = (divisionMap[label] || 0) + 1;
    }

    const state = pickAnswer(ans, 'state/province', 'state');
    const city  = pickAnswer(ans, 'city');
    const zip   = pickAnswer(ans, 'zip', 'postal');
    if (state) stateMap[state.trim()] = (stateMap[state.trim()] || 0) + 1;
    if (city)  cityMap[city.trim()]   = (cityMap[city.trim()] || 0) + 1;
    if (zip) {
      const z = String(zip).trim().slice(0, 5);
      zipMap[z] = (zipMap[z] || 0) + 1;
    }
  }

  const toArr = (m) =>
    Object.entries(m).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

  return { teams, gradYearMap, genderMap, stateMap, cityMap, zipMap, divisionMap,
    graduationYear: toArr(gradYearMap),
    gender:         toArr(genderMap),
    division:       toArr(divisionMap),
    state:          toArr(stateMap),
    city:           toArr(cityMap).slice(0, 50),
    zip:            toArr(zipMap).slice(0, 100) };
}

// ── Boot SSE — streams step-by-step startup info ──────────────────────────────
// The client connects here during app load to see a live terminal instead of a spinner.

app.get('/api/boot/stream', async (req, res) => {
  const { orgId = '8008' } = req.query;

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const log  = (msg, level = 'info') => send('log', { ts: new Date().toLocaleTimeString('en-US', {hour12:false}), msg, level });

  try {
    log(`════════════════════════════════════════`, 'info');
    log(` MIDWEST 3ON3 DATA EXPLORER`, 'ok');
    log(`════════════════════════════════════════`, 'info');

    // Step 1: Auth
    log(`Step 1/4 — Authenticating with SportsEngine…`, 'info');
    const t0 = Date.now();
    let me;
    try {
      const token = await getAccessToken();
      log(`  → POST https://user.sportsengine.com/oauth/token`, 'call');
      me = await axios.get('https://user.sportsengine.com/oauth/me', {
        headers: { Authorization: `Bearer ${token}` },
      });
      log(`  ← 200 OK (${Date.now()-t0}ms) — client: ${me.data?.result?.client?.name || 'unknown'}`, 'response');
      log(`  ✓ Authenticated as org ${orgId}`, 'ok');
    } catch (err) {
      log(`  ✗ Auth FAILED: ${err.message}`, 'error');
      send('error', { message: err.message });
      return res.end();
    }

    // Step 2: Store status
    log(`────────────────────────────────────────`, 'info');
    log(`Step 2/4 — Checking local data store…`, 'info');
    const db = await store.load();
    const eventsSaved  = Object.values(db.events).length;
    const closedSaved  = Object.values(db.events).filter(e => e.status === 2 && e.fetchedAt).length;
    const openSaved    = Object.values(db.events).filter(e => e.status !== 2 && e.fetchedAt).length;
    log(`  Results in store        : ${db.results.length}`, 'info');
    log(`  Events tracked          : ${eventsSaved}`, 'info');
    log(`  Closed events cached    : ${closedSaved}  (will not be re-fetched)`, 'info');
    log(`  Open events cached      : ${openSaved}`, 'info');
    log(`  Last aggregation run    : ${db.meta.lastRunAt ? new Date(db.meta.lastRunAt).toLocaleString() : 'never'}`, 'info');
    log(`  ✓ Store loaded`, 'ok');

    // Step 3: Fetch all events (all pages), sort newest first
    log(`────────────────────────────────────────`, 'info');
    log(`Step 3/4 — Loading all registrations from SportsEngine…`, 'info');

    const firstPage = await graphql(`query($orgId: Int!, $page: Int, $perPage: Int!) {
      registrations(organizationId: $orgId, page: $page, perPage: $perPage) {
        pageInformation { pages count }
      }
    }`, { orgId: parseInt(orgId), page: 1, perPage: 100 });
    const totalPages = firstPage?.data?.registrations?.pageInformation?.pages || 1;
    const totalCount = firstPage?.data?.registrations?.pageInformation?.count || 0;
    log(`  Total in SportsEngine: ${totalCount} registrations across ${totalPages} pages`, 'info');

    let allEvents = [];
    for (let pg = 1; pg <= totalPages; pg++) {
      log(`  → GraphQL: registrations(page:${pg}/${totalPages})`, 'call');
      const tP = Date.now();
      const d = await graphql(`query($orgId: Int!, $page: Int, $perPage: Int!) {
        registrations(organizationId: $orgId, page: $page, perPage: $perPage) {
          results { id name open close status sport resultsCompleted }
        }
      }`, { orgId: parseInt(orgId), page: pg, perPage: 100 });
      const results = d?.data?.registrations?.results || [];
      allEvents = allEvents.concat(results);
      log(`  ← page ${pg}/${totalPages}: ${results.length} events (${Date.now()-tP}ms) — ${allEvents.length} total so far`, 'response');
      if (pg < totalPages) await new Promise(r => setTimeout(r, 200));
    }

    // Sort newest first (by close date, fallback to open)
    allEvents.sort((a, b) => new Date(b.close || b.open || 0) - new Date(a.close || a.open || 0));

    const toFetch   = store.pendingEvents(db, allEvents);
    const skipCount = allEvents.length - toFetch.length;
    log(`  Total events loaded     : ${allEvents.length}`, 'ok');
    log(`  Already cached (closed) : ${skipCount} — zero API calls needed`, 'skip');
    log(`  Need to fetch           : ${toFetch.length} events`, 'info');
    log(`  ✓ Event list ready`, 'ok');

    // Step 4: Summary
    log(`────────────────────────────────────────`, 'info');
    log(`Step 4/4 — Ready`, 'ok');
    log(`  ${allEvents.length} total events available`, 'info');
    log(`  Go to Reports → Start Aggregation to pull all registration results`, 'info');
    log(`════════════════════════════════════════`, 'info');

    send('ready', {
      orgName:       me.data?.result?.client?.name || 'Midwest 3 on 3',
      orgId,
      storeResults:  db.results.length,
      recentEvents:  allEvents.map(e => ({ id: e.id, name: e.name, status: e.status, resultsCompleted: e.resultsCompleted, open: e.open, close: e.close })),
    });

  } catch (err) {
    send('error', { message: err.message });
  } finally {
    res.end();
  }
});

// ── Health ─────────────────────────────────────────────────────────────────────

app.get('/api/health', async (req, res) => {
  try {
    const token = await getAccessToken();
    const me = await axios.get('https://user.sportsengine.com/oauth/me', {
      headers: { Authorization: `Bearer ${token}` },
    });
    res.json({ status: 'ok', identity: me.data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message, detail: err.response?.data });
  }
});

// ── Schema ─────────────────────────────────────────────────────────────────────

app.get('/api/schema', async (req, res) => {
  const cacheKey = 'schema';
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);
  try {
    const data = await graphql(`{
      __schema {
        queryType { name }
        types {
          name kind description
          fields {
            name description
            type { name kind ofType { name kind ofType { name kind } } }
            args { name type { name kind ofType { name kind } } }
          }
        }
      }
    }`);
    cache.set(cacheKey, data, 3600);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message, detail: err.response?.data });
  }
});

// ── Raw GraphQL proxy ──────────────────────────────────────────────────────────

app.post('/api/graphql', async (req, res) => {
  try {
    const { query, variables } = req.body;
    if (!query) return res.status(400).json({ error: 'query is required' });
    const data = await graphql(query, variables || {});
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message, detail: err.response?.data });
  }
});

// ── Organizations ──────────────────────────────────────────────────────────────

app.get('/api/organizations', async (req, res) => {
  const cacheKey = 'orgs';
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);
  try {
    const data = await graphql(`query {
      organizations(perPage: 100, page: 1) {
        pageInformation { count pages page perPage }
        results { id name }
      }
    }`);
    cache.set(cacheKey, data, 600);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message, detail: err.response?.data });
  }
});

// ── Registrations (paginated) ──────────────────────────────────────────────────

app.get('/api/registrations', async (req, res) => {
  const { orgId, page = 1, perPage = 100 } = req.query;
  if (!orgId) return res.status(400).json({ error: 'orgId required' });
  const cacheKey = `regs_${orgId}_${page}_${perPage}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);
  try {
    const data = await graphql(`query($orgId: Int!, $page: Int, $perPage: Int!) {
      registrations(organizationId: $orgId, page: $page, perPage: $perPage) {
        pageInformation { count pages page perPage }
        results { id name open close status sport resultsCompleted monetary }
      }
    }`, { orgId: parseInt(orgId), page: parseInt(page), perPage: parseInt(perPage) });
    cache.set(cacheKey, data, 300);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message, detail: err.response?.data });
  }
});

// ── All registrations — all pages, sorted newest-first ────────────────────────

app.get('/api/registrations/recent', async (req, res) => {
  const { orgId } = req.query;
  if (!orgId) return res.status(400).json({ error: 'orgId required' });
  const cacheKey = `regs_all_${orgId}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);
  try {
    let allRegs = [], page = 1, totalPages = 1;
    do {
      const data = await graphql(`query($orgId: Int!, $page: Int, $perPage: Int!) {
        registrations(organizationId: $orgId, page: $page, perPage: $perPage) {
          pageInformation { pages }
          results { id name open close status sport resultsCompleted monetary }
        }
      }`, { orgId: parseInt(orgId), page, perPage: 100 });
      const r = data?.data?.registrations;
      if (!r) break;
      allRegs = allRegs.concat(r.results || []);
      totalPages = r.pageInformation?.pages || 1;
      page++;
      if (page <= totalPages) await new Promise(r => setTimeout(r, 200));
    } while (page <= totalPages);

    // Sort newest first (by close date, fallback open)
    allRegs.sort((a, b) => new Date(b.close || b.open || 0) - new Date(a.close || a.open || 0));

    const result = { total: allRegs.length, registrations: allRegs };
    cache.set(cacheKey, result, 600);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message, detail: err.response?.data });
  }
});

// ── Single registration analytics ─────────────────────────────────────────────

app.get('/api/analytics/registration', async (req, res) => {
  const { registrationId, orgId } = req.query;
  if (!orgId || !registrationId) return res.status(400).json({ error: 'orgId and registrationId required' });

  // Prefer locally-stored data — fall back to live API if not yet aggregated
  const db = await store.load();
  const stored = db.results.filter(r => String(r.eventId) === String(registrationId));
  if (stored.length > 0) {
    const gradYearMap = {}, genderMap = {}, stateMap = {}, cityMap = {}, zipMap = {};
    let teams = 0;
    for (const r of stored) {
      if (!r.completed) continue;
      teams++;
      for (const gy of (r.gradYears || [])) {
        if (/^\d{4}$/.test(gy)) gradYearMap[gy] = (gradYearMap[gy] || 0) + 1;
      }
      if (r.gender) genderMap[r.gender] = (genderMap[r.gender] || 0) + 1;
      const st = r.state?.trim(); if (st) stateMap[st] = (stateMap[st] || 0) + 1;
      const ci = r.city?.trim();  if (ci) cityMap[ci]  = (cityMap[ci]  || 0) + 1;
      if (r.zip) { const z = String(r.zip).slice(0,5); zipMap[z] = (zipMap[z] || 0) + 1; }
    }
    const toArr = m => Object.entries(m).map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count);
    const ev = db.events[registrationId];
    return res.json({
      registrationId, registrationName: ev?.name || stored[0]?.eventName,
      resultsCompleted: stored.length, totalFetched: stored.length,
      graduationYear: toArr(gradYearMap), gender: toArr(genderMap),
      state: toArr(stateMap), city: toArr(cityMap).slice(0,50),
      zip: toArr(zipMap).slice(0,100), division: [],
      teams, total: teams,
    });
  }

  // Not in store — fall back to live GraphQL
  const cacheKey = `analytics_reg_${registrationId}_${orgId}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);
  try {
    const reg = await fetchAllRegistrationResults(registrationId, orgId);
    if (!reg) return res.status(404).json({ error: 'Registration not found' });
    const agg = aggregateAnswers(reg.registrationResults || []);
    const result = {
      registrationId, registrationName: reg.name,
      resultsCompleted: reg.resultsCompleted, totalFetched: reg.registrationResults?.length || 0,
      ...agg, total: agg.teams,
    };
    cache.set(cacheKey, result, 300);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message, detail: err.response?.data });
  }
});

// Keep old route working too
app.get('/api/analytics/graduation-year', async (req, res) => {
  req.url = '/api/analytics/registration';
  res.redirect(307, `/api/analytics/registration?${new URLSearchParams(req.query)}`);
});

// ── Cross-registration aggregate — all events ──────────────────────────────────

// Reads directly from the local store — instant, no API calls needed.
// The store is populated by the aggregator; this replaces the old live-API version.
app.get('/api/analytics/aggregate', async (req, res) => {
  const { orgId, gradYearFilter } = req.query;
  if (!orgId) return res.status(400).json({ error: 'orgId required' });

  try {
    const db = await store.load();
    const gradYearMap = {}, genderMap = {}, stateMap = {}, cityMap = {}, zipMap = {};
    const eventCountMap = {};
    let totalTeams = 0;

    for (const r of db.results) {
      if (!r.completed) continue;
      totalTeams++;

      // Per-event team count
      if (!eventCountMap[r.eventId]) {
        eventCountMap[r.eventId] = { id: String(r.eventId), name: r.eventName, teams: 0 };
      }
      eventCountMap[r.eventId].teams++;

      for (const gy of (r.gradYears || [])) {
        if (/^\d{4}$/.test(gy)) gradYearMap[gy] = (gradYearMap[gy] || 0) + 1;
      }
      if (r.gender) genderMap[r.gender] = (genderMap[r.gender] || 0) + 1;
      const st = r.state?.trim(); if (st) stateMap[st] = (stateMap[st] || 0) + 1;
      const ci = r.city?.trim();  if (ci) cityMap[ci]  = (cityMap[ci]  || 0) + 1;
      if (r.zip) { const z = String(r.zip).slice(0,5); zipMap[z] = (zipMap[z] || 0) + 1; }
    }

    const toArr = m =>
      Object.entries(m).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

    let gradYearData = toArr(gradYearMap);
    if (gradYearFilter) {
      const years = gradYearFilter.split(',').map(s => s.trim());
      gradYearData = gradYearData.filter(d => years.includes(d.name));
    }

    const registrationSummary = Object.values(eventCountMap).sort((a, b) => b.teams - a.teams);

    res.json({
      registrationsAnalyzed: registrationSummary.length,
      registrationSummary,
      total: totalTeams,
      graduationYear: gradYearData,
      gender:   toArr(genderMap),
      state:    toArr(stateMap),
      city:     toArr(cityMap).slice(0, 50),
      zip:      toArr(zipMap).slice(0, 100),
      division: [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Raw registration answers ───────────────────────────────────────────────────

app.get('/api/registration-answers', async (req, res) => {
  const { registrationId, orgId } = req.query;
  if (!orgId || !registrationId) return res.status(400).json({ error: 'orgId and registrationId required' });
  const cacheKey = `reganswers_${registrationId}_${orgId}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);
  try {
    const reg = await fetchAllRegistrationResults(registrationId, orgId);
    const result = { data: { registration: reg } };
    cache.set(cacheKey, result, 300);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message, detail: err.response?.data });
  }
});

// ── Profiles ───────────────────────────────────────────────────────────────────

app.get('/api/profiles', async (req, res) => {
  const { orgId, page = 1, perPage = 200 } = req.query;
  if (!orgId) return res.status(400).json({ error: 'orgId required' });
  const cacheKey = `profiles_${orgId}_${page}_${perPage}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json(cached);
  try {
    const data = await graphql(`query($orgId: Int!, $page: Int, $perPage: Int!) {
      profiles(organizationId: $orgId, page: $page, perPage: $perPage) {
        pageInformation { count pages page perPage }
        results {
          id firstName lastName email phone
          dateOfBirth graduationYear gender
          address { city state postalCode country address1 }
        }
      }
    }`, { orgId: parseInt(orgId), page: parseInt(page), perPage: parseInt(perPage) });
    cache.set(cacheKey, data, 300);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message, detail: err.response?.data });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// PERSISTENT STORE + REPORTS ENDPOINTS
// ══════════════════════════════════════════════════════════════════════════════

// ── Store status ───────────────────────────────────────────────────────────────

app.get('/api/store/status', async (req, res) => {
  const db = await store.load();
  const eventList = Object.values(db.events);
  const closed  = eventList.filter(e => e.status === 2 && e.fetchedAt).length;
  const open    = eventList.filter(e => e.status !== 2 && e.fetchedAt).length;
  const pending = eventList.filter(e => !e.fetchedAt).length;
  res.json({
    meta:         db.meta,
    totalResults: db.results.length,
    totalEvents:  eventList.length,
    closedFetched: closed,
    openFetched:  open,
    pending,
    aggregator:   aggregator.getState(),
  });
});

// ── Purge + reload a single event — SSE stream ────────────────────────────────
// Client connects via EventSource; server streams live log lines then fires
// a 'complete' or 'error' event when done.

app.get('/api/store/purge-reload-stream', async (req, res) => {
  const { eventId, orgId = '8008' } = req.query;
  if (!eventId) { res.status(400).end(); return; }

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {}
  };
  const log = (msg, level = 'info') =>
    send('log', { ts: new Date().toLocaleTimeString('en-US', { hour12: false }), msg, level });

  try {
    const db = await store.load();
    const eventMeta = db.events[eventId] || {};
    const eventName = eventMeta.name || eventId;

    log(`════════════════════════════════════════`, 'info');
    log(` PURGE & RELOAD`, 'ok');
    log(`════════════════════════════════════════`, 'info');
    log(`Event   : ${eventName}`, 'info');
    log(`ID      : ${eventId}`, 'info');
    log(`Org     : ${orgId}`, 'info');
    log(`────────────────────────────────────────`, 'info');

    // ── Step 1: Purge ──────────────────────────────────────────────────────────
    log(`STEP 1 — Purging local store…`, 'ok');
    const existingCount = db.results.filter(r => r.eventId === eventId).length;
    log(`  Results currently saved  : ${existingCount}`, 'info');
    const deletedCount = store.purgeEvent(db, eventId);
    await store.save(db);

    // Clear in-memory caches
    cache.del(`analytics_reg_${eventId}_${orgId}`);
    cache.del(`reganswers_${eventId}_${orgId}`);
    cache.keys()
      .filter(k => k.startsWith('analytics_agg_') || k.startsWith('regs_all_'))
      .forEach(k => cache.del(k));

    log(`  ✓ Deleted ${deletedCount} results from local store`, 'ok');
    log(`  ✓ In-memory cache cleared`, 'ok');
    log(`────────────────────────────────────────`, 'info');

    // ── Step 2: Fetch — paginate through ALL registrationResults ─────────────
    log(`STEP 2 — Fetching fresh data from SportsEngine (paginated)…`, 'ok');
    log(`  → registration(id:"${eventId}", organizationId:${orgId})`, 'call');
    log(`  → registrationResults(perPage:100) — will page through all`, 'call');

    const t0  = Date.now();
    const reg = await fetchAllRegistrationResults(eventId, orgId, log);
    const elapsed = Date.now() - t0;

    if (!reg) {
      log(`  ✗ SportsEngine returned no registration — check event ID`, 'error');
      send('error', { message: 'Registration not found' });
      return res.end();
    }

    const rawResults = reg.registrationResults || [];
    log(`  ← Done (${elapsed}ms)`, 'response');
    log(`  ← Registration name     : ${reg.name}`, 'response');
    log(`  ← resultsCompleted      : ${reg.resultsCompleted}`, 'response');
    log(`  ← Total rows fetched    : ${rawResults.length}  (was capped at 25 before this fix)`, 'response');
    log(`────────────────────────────────────────`, 'info');

    // ── Step 3: Parse ──────────────────────────────────────────────────────────
    log(`STEP 3 — Parsing ${rawResults.length} results…`, 'ok');

    const lower = keys => { const k = keys.map(x => x.toLowerCase()); return a => k.some(kk => (a.name || '').toLowerCase().includes(kk)); };
    const val   = a => a.strValue ?? (a.numValue != null ? String(a.numValue) : null) ?? null;
    const pick  = (ans, ...keys) => { const m = ans.find(lower(keys)); return m ? val(m) : null; };

    const compact = rawResults.map(r => {
      const ans = r.answers || [];
      const gradYears = ans.filter(lower(['graduation year','grad year']))
        .map(val).filter(v => v && /^\d{4}$/.test(v.trim())).map(v => v.trim());
      if (!gradYears.length) {
        const div = pick(ans, 'desired division', 'division of play');
        if (div) { const y = div.replace(/\D/g,''); if (y.length===4) gradYears.push(y); }
      }
      return {
        id: r.id, eventId: String(eventId), eventName: reg.name,
        created: r.created || null, completed: r.completed,
        gradYears,
        gender: pick(ans,'gender of team','gender'),
        city:   pick(ans,'city')?.trim() || null,
        state:  pick(ans,'state/province','state')?.trim() || null,
        zip:    pick(ans,'zip','postal') ? String(pick(ans,'zip','postal')).trim().slice(0,5) : null,
      };
    });

    // Sample a few for the log
    const sample = compact.slice(0, 3);
    for (const s of sample) {
      log(`  • result ${s.id}: completed=${s.completed} gradYears=[${s.gradYears.join(',')||'—'}] state=${s.state||'—'} city=${s.city||'—'}`, 'info');
    }
    if (compact.length > 3) log(`  … and ${compact.length - 3} more`, 'info');
    log(`────────────────────────────────────────`, 'info');

    // ── Step 4: Save ───────────────────────────────────────────────────────────
    log(`STEP 4 — Saving to local store…`, 'ok');
    const added = store.upsertResults(db, String(eventId), reg.name, compact);
    store.upsertEventMeta(db,
      { id: String(eventId), name: reg.name, status: eventMeta.status, open: eventMeta.open, close: eventMeta.close },
      { fetchedAt: new Date().toISOString(), resultCount: rawResults.length, purgedAndReloaded: new Date().toISOString() }
    );
    db.meta.totalResults = db.results.length;
    await store.save(db);

    log(`  ✓ Saved ${added} new results`, 'ok');
    log(`  ✓ Total results in store  : ${db.results.length}`, 'ok');
    log(`════════════════════════════════════════`, 'info');
    log(` COMPLETE`, 'ok');
    log(`════════════════════════════════════════`, 'info');

    send('complete', {
      eventId, eventName: reg.name,
      deleted: deletedCount, fetched: rawResults.length,
      added, totalInStore: db.results.length,
    });

  } catch (err) {
    log(`✗ FATAL: ${err.message}`, 'error');
    send('error', { message: err.message });
  } finally {
    res.end();
  }
});

// ── Purge a single event (no reload) ──────────────────────────────────────────

app.post('/api/store/purge', async (req, res) => {
  const { eventId } = req.body || {};
  if (!eventId) return res.status(400).json({ error: 'eventId required' });
  const db = await store.load();
  const eventName    = db.events[eventId]?.name || eventId;
  const deletedCount = store.purgeEvent(db, eventId);
  await store.save(db);
  cache.keys().filter(k =>
    k.includes(eventId) || k.startsWith('analytics_agg_') || k.startsWith('regs_all_')
  ).forEach(k => cache.del(k));
  res.json({ eventId, eventName, deleted: deletedCount, totalInStore: db.results.length });
});

// ── List events currently in store (for the data-management UI) ───────────────

app.get('/api/store/events', async (req, res) => {
  const db = await store.load();
  const byEvent = {};
  for (const r of db.results) {
    if (!byEvent[r.eventId]) byEvent[r.eventId] = { id: r.eventId, name: r.eventName, count: 0 };
    byEvent[r.eventId].count++;
  }
  const events = Object.values(byEvent).map(ev => {
    const meta = db.events[ev.id] || {};
    return {
      ...ev,
      meta,
      // Expose resultsCompleted at top level for easy client cross-reference
      // with the live recentRegs list (which also has resultsCompleted from the API).
      resultsCompleted: meta.resultsCompleted ?? null,
      fetchedAt:        meta.fetchedAt        ?? null,
    };
  }).sort((a, b) => (b.fetchedAt || '').localeCompare(a.fetchedAt || ''));
  res.json({ events, totalResults: db.results.length });
});

// ── SSE — aggregation progress stream ─────────────────────────────────────────

// ── Legacy SSE stream (local dev only — Vercel uses client-driven fetch-event) ─

app.get('/api/aggregate/stream', async (req, res) => {
  if (process.env.VERCEL === '1' || !aggregator) {
    // On Vercel: no persistent SSE — client-driven mode, no stream needed
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    res.write(`event: state\ndata: ${JSON.stringify({ running:false, phase:'idle', current:0, total:0, skipped:0, newResults:0, errors:0 })}\n\n`);
    return;
  }
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  aggregator.addClient(res);
  res.write(`event: state\ndata: ${JSON.stringify(aggregator.getState())}\n\n`);
  req.on('close', () => aggregator.removeClient(res));
});

// ── Legacy SSE start (local dev only) ─────────────────────────────────────────

app.post('/api/aggregate/start', async (req, res) => {
  if (process.env.VERCEL === '1' || !aggregator) {
    return res.json({ started: false, message: 'Use /api/aggregate/plan + /api/aggregate/fetch-event on Vercel' });
  }
  const { orgId = '8008', delayMs = 1200, events = [], purgeFirst = false } = req.body || {};
  if (aggregator.getState().running) return res.json({ started: false, message: 'Already running' });
  cache.del('analytics_agg');
  aggregator.run(graphql, orgId, parseInt(delayMs), events, purgeFirst);
  res.json({ started: true, message: `Aggregation started` });
});

// ── Client-driven aggregation (works on Vercel — one event per request) ────────
//
// AggregatePanel calls these sequentially:
//   1. GET /api/aggregate/plan   → list of events that need work
//   2. POST /api/aggregate/fetch-event → process ONE event, return result

app.get('/api/aggregate/plan', async (req, res) => {
  const { orgId = '8008', year } = req.query;
  try {
    // Discover current events from SE
    let allEvents = [], page = 1, totalPages = 1;
    do {
      const d = await graphql(`query($orgId:Int!,$page:Int,$perPage:Int!){
        registrations(organizationId:$orgId,page:$page,perPage:$perPage){
          pageInformation{pages}
          results{id name status open close sport resultsCompleted}
        }
      }`, { orgId: parseInt(orgId), page, perPage: 100 });
      const r = d?.data?.registrations;
      if (!r) break;
      allEvents  = allEvents.concat(r.results || []);
      totalPages = r.pageInformation?.pages || 1;
      page++;
      if (page <= totalPages) await new Promise(r => setTimeout(r, 200));
    } while (page <= totalPages);

    // Apply optional year filter
    let events = allEvents;
    if (year) events = events.filter(ev => (ev.close||ev.open||'').slice(0,4) === year);

    const db = await store.load();
    const needs = [], upToDate = [];

    for (const ev of events) {
      const saved            = db.events[String(ev.id)];
      const storedCompleted  = saved?.resultsCompleted ?? null;
      const currentCompleted = ev.resultsCompleted ?? 0;

      if (!saved || (storedCompleted !== null && currentCompleted > storedCompleted) || storedCompleted === null) {
        needs.push({ ...ev, storedCompleted, reason: !saved ? 'never_fetched' : 'count_increased' });
      } else {
        upToDate.push({ id: ev.id, name: ev.name, storedCompleted });
      }
    }

    res.json({ needs, upToDate, total: events.length, allEventsCount: allEvents.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/aggregate/fetch-event', async (req, res) => {
  const { orgId = '8008', eventId, eventName, eventStatus, resultsCompleted: currentCompleted = 0, purgeFirst = false } = req.body || {};
  if (!eventId) return res.status(400).json({ error: 'eventId required' });

  try {
    const db = await store.load();

    if (purgeFirst) store.purgeEvent(db, String(eventId));

    const storedEvent     = db.events[String(eventId)];
    const storedCompleted = storedEvent?.resultsCompleted ?? null;
    const storedCount     = storedEvent?.resultCount     || 0;

    // Skip if count unchanged (and not forcing a purge)
    if (!purgeFirst && storedCompleted !== null && currentCompleted === storedCompleted) {
      return res.json({ added: 0, skipped: true, reason: 'count_unchanged', eventId });
    }

    // Incremental: start from the page where new records appear
    const PER_PAGE  = 25;
    const startPage = (!purgeFirst && storedCompleted !== null && currentCompleted > storedCompleted && storedCount > 0)
      ? Math.max(1, Math.floor(storedCount / PER_PAGE))
      : 1;

    // Fetch registration results (paginated)
    const ANSWERS_Q = `query($regId:ID!,$orgId:Int!,$page:Int,$perPage:Int!){
      registration(id:$regId,organizationId:$orgId){
        id name resultsCompleted
        registrationResults(page:$page,perPage:$perPage){
          id profileId completed status created
          answers{
            name
            ...on StringRegistrationResultAnswer{strValue:value}
            ...on NumberRegistrationResultAnswer{numValue:value}
            ...on ArrayRegistrationResultAnswer{arrValue:value}
          }
        }
      }
    }`;

    let allResults = [], regMeta = null, page = startPage;
    do {
      const d = await graphql(ANSWERS_Q, { regId: String(eventId), orgId: parseInt(orgId), page, perPage: PER_PAGE });
      const r = d?.data?.registration;
      if (!r) break;
      regMeta = r;
      const batch = r.registrationResults || [];
      allResults = allResults.concat(batch);
      if (batch.length < PER_PAGE) break;
      page++;
      await new Promise(r => setTimeout(r, 300));
    } while (true);

    const evObj = { id: String(eventId), name: eventName || regMeta?.name || String(eventId), status: eventStatus ?? 2 };
    const compact = allResults.map(r => {
      const parsed = extractAnswers(r.answers || []);
      return { id: r.id, eventId: String(eventId), eventName: evObj.name, created: r.created || null, completed: r.completed, ...parsed };
    });

    const added = store.upsertResults(db, String(eventId), evObj.name, compact);
    store.upsertEventMeta(db, evObj, {
      fetchedAt:        new Date().toISOString(),
      resultCount:      storedCount + added,
      resultsCompleted: regMeta?.resultsCompleted ?? currentCompleted,
    });
    await store.save(db);
    cache.del('analytics_agg');

    res.json({ added, fetched: allResults.length, skipped: false, eventId, eventName: evObj.name });
  } catch (err) {
    res.status(500).json({ error: err.message, eventId });
  }
});

// ── Reports: daily stats ───────────────────────────────────────────────────────

app.get('/api/reports/daily', async (req, res) => {
  const { fromDate, toDate, eventId } = req.query;
  const db = await store.load();
  const daily = store.dailyStats(db, { fromDate, toDate, eventId });

  // Enrich with event names
  const eventMap = {};
  for (const e of Object.values(db.events)) eventMap[e.id] = e.name;

  res.json({ daily, eventMap, totalResults: db.results.length, meta: db.meta });
});

// ── Reports: grad-year stats (from store) ─────────────────────────────────────

app.get('/api/reports/grad-years', async (req, res) => {
  const { fromDate, toDate, eventId } = req.query;
  const db = await store.load();
  const gradYears = store.gradYearStats(db, { fromDate, toDate, eventId });
  res.json({ gradYears, totalResults: db.results.length });
});

// ── Reports: per-event summary ────────────────────────────────────────────────

app.get('/api/reports/events', async (req, res) => {
  const { fromDate, toDate } = req.query;
  const db = await store.load();

  const byEvent = {};
  for (const r of db.results) {
    if (!r.eventId) continue;
    const day = r.created?.slice(0, 10) || '';
    if (fromDate && day < fromDate) continue;
    if (toDate   && day > toDate)   continue;
    if (!byEvent[r.eventId]) byEvent[r.eventId] = { id: r.eventId, name: r.eventName, count: 0, gradYears: {} };
    byEvent[r.eventId].count++;
    for (const gy of (r.gradYears || [])) {
      if (/^\d{4}$/.test(gy)) byEvent[r.eventId].gradYears[gy] = (byEvent[r.eventId].gradYears[gy] || 0) + 1;
    }
  }

  const list = Object.values(byEvent)
    .map(e => ({
      ...e,
      status: db.events[e.id]?.status ?? null,
      gradYears: Object.entries(e.gradYears)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.count - a.count);

  res.json({ events: list, totalResults: db.results.length, meta: db.meta });
});

// ── Reports: today / yesterday quick stats ────────────────────────────────────

app.get('/api/reports/recent', async (req, res) => {
  const db = await store.load();
  // All comparisons use CDT (UTC-5) so day boundaries match SportsEngine's display.
  const today     = store.todayCDT();
  const yest      = store.toCDTDate(new Date(Date.now() - 86400000).toISOString());
  const thisMonth = today.slice(0, 7);
  const lastMonth = store.toCDTDate(new Date(new Date().getFullYear(), new Date().getMonth() - 1, 15).toISOString()).slice(0, 7);

  let todayCount = 0, yesterdayCount = 0, thisMonthCount = 0, lastMonthCount = 0, allTimeCount = 0;

  for (const r of db.results) {
    if (!r.created) continue;
    const day   = store.toCDTDate(r.created);
    const month = day.slice(0, 7);
    allTimeCount++;
    if (day === today)       todayCount++;
    if (day === yest)        yesterdayCount++;
    if (month === thisMonth) thisMonthCount++;
    if (month === lastMonth) lastMonthCount++;
  }

  // Last 30 days
  const last30start = store.toCDTDate(new Date(Date.now() - 30*86400000).toISOString());
  const daily30 = store.dailyStats(db, { fromDate: last30start });

  res.json({ today: todayCount, yesterday: yesterdayCount, thisMonth: thisMonthCount,
    lastMonth: lastMonthCount, allTime: allTimeCount, daily30, meta: db.meta });
});

// ── Raw results slice (for table view) ────────────────────────────────────────

app.get('/api/reports/results', async (req, res) => {
  const { fromDate, toDate, eventId, page = 1, perPage = 200 } = req.query;
  const db = await store.load();
  let filtered = db.results;
  if (fromDate) filtered = filtered.filter(r => (r.created||'').slice(0,10) >= fromDate);
  if (toDate)   filtered = filtered.filter(r => (r.created||'').slice(0,10) <= toDate);
  if (eventId)  filtered = filtered.filter(r => r.eventId === eventId);
  const start = (parseInt(page)-1) * parseInt(perPage);
  res.json({ total: filtered.length, results: filtered.slice(start, start+parseInt(perPage)) });
});

// ── Daily League Activity — which leagues had registrations on a given day ─────

app.get('/api/reports/daily-activity', async (req, res) => {
  const date = req.query.date || store.todayCDT();
  const db   = store.load();

  // Build a day→count map and a per-league breakdown for the requested date
  const dayTotals  = {};   // YYYY-MM-DD → total registrations (all events)
  const leagueMap  = {};   // eventId    → { id, name, count, gradYears:{} }

  for (const r of db.results) {
    if (!r.created) continue;
    const day = store.toCDTDate(r.created);
    dayTotals[day] = (dayTotals[day] || 0) + 1;

    if (day !== date) continue;

    if (!leagueMap[r.eventId]) {
      leagueMap[r.eventId] = { id: r.eventId, name: r.eventName, count: 0, gradYears: {} };
    }
    leagueMap[r.eventId].count++;
    for (const gy of (r.gradYears || [])) {
      if (/^\d{4}$/.test(gy))
        leagueMap[r.eventId].gradYears[gy] = (leagueMap[r.eventId].gradYears[gy] || 0) + 1;
    }
  }

  const leagues = Object.values(leagueMap)
    .map(l => ({
      ...l,
      gradYears: Object.entries(l.gradYears)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.count - a.count);

  const total = leagues.reduce((s, l) => s + l.count, 0);

  // Week containing the date (Mon→Sun ISO week)
  const dateMs  = new Date(date + 'T12:00:00Z').getTime();
  const dow     = new Date(date + 'T12:00:00Z').getUTCDay(); // 0=Sun
  const monOff  = (dow === 0 ? -6 : 1 - dow) * 86400000;
  const monMs   = dateMs + monOff;

  let weekTotal = 0, prevWeekTotal = 0;
  const weekDays = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monMs + i * 86400000).toISOString().slice(0, 10);
    const t = dayTotals[d] || 0;
    weekTotal += t;
    weekDays.push({ date: d, total: t });
  }
  for (let i = 0; i < 7; i++) {
    const d = new Date(monMs - 7 * 86400000 + i * 86400000).toISOString().slice(0, 10);
    prevWeekTotal += dayTotals[d] || 0;
  }

  res.json({ date, leagues, total, weekTotal, prevWeekTotal, weekDays });
});

// ── Year-over-Year league comparison ──────────────────────────────────────────

app.get('/api/reports/yoy', async (req, res) => {
  const db = await store.load();

  // Normalize a league name: strip trailing year token, collapse whitespace
  function normalizeName(name) {
    return (name || '')
      .replace(/\s+(20\d{2})\s*$/, '')   // strip trailing year
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  // Determine season year for an event: prefer close-date year, then name year
  function seasonYear(eventId, eventName) {
    const ev = db.events[eventId];
    const closeYear = (ev?.close || ev?.open || '').slice(0, 4);
    if (closeYear && /^20\d{2}$/.test(closeYear)) return closeYear;
    const m = (eventName || '').match(/\b(20\d{2})\b/);
    return m ? m[1] : 'unknown';
  }

  // Group results: normalizedName → { baseName, eventsByYear: { year: { id, name, count } } }
  const groups = {};

  for (const r of db.results) {
    if (!r.completed) continue;
    const norm  = normalizeName(r.eventName);
    const year  = seasonYear(r.eventId, r.eventName);

    if (!groups[norm]) {
      // Use the shortest/cleanest version of the name as display name
      const base = (r.eventName || '')
        .replace(/\s+(20\d{2})\s*$/, '').trim();
      groups[norm] = { baseName: base, years: {} };
    }

    if (!groups[norm].years[year]) {
      groups[norm].years[year] = { id: r.eventId, name: r.eventName, count: 0 };
    }
    groups[norm].years[year].count++;
  }

  // Only include groups that appear in at least 2 different years (true YoY)
  // but also include single-year groups if they have >0 results (for context)
  const allYears = [...new Set(
    Object.values(groups).flatMap(g => Object.keys(g.years))
  )].sort();

  const result = Object.values(groups)
    .map(g => {
      const total = Object.values(g.years).reduce((s, y) => s + y.count, 0);
      // YoY delta: latest two years
      const sortedYears = Object.keys(g.years).sort();
      const latest = sortedYears[sortedYears.length - 1];
      const prev   = sortedYears[sortedYears.length - 2];
      const delta  = prev
        ? (g.years[latest]?.count || 0) - (g.years[prev]?.count || 0)
        : null;
      return { baseName: g.baseName, years: g.years, total, delta, latestYear: latest };
    })
    .filter(g => g.total > 0)
    .sort((a, b) => b.total - a.total);

  res.json({ groups: result, allYears });
});

// ── Facebook Custom Audience CSV export ───────────────────────────────────────

app.get('/api/reports/facebook-csv', async (req, res) => {
  const { eventId, eventIds } = req.query;
  const db = await store.load();

  let results = db.results.filter(r => r.completed);

  if (eventId) {
    results = results.filter(r => String(r.eventId) === String(eventId));
  } else if (eventIds) {
    const ids = new Set(eventIds.split(',').map(s => s.trim()));
    results = results.filter(r => ids.has(String(r.eventId)));
  }

  const evName = eventId
    ? (db.events[eventId]?.name || `event_${eventId}`)
    : 'all_leagues';
  const slug = evName.replace(/[^a-z0-9]/gi, '_').replace(/_+/g, '_').slice(0, 40);
  const date = store.todayCDT();

  // Facebook Custom Audience format: one row per grad-year within each registration
  // (zip + location is useful for location-based audiences)
  function mapGender(g) {
    if (!g) return '';
    const lc = g.toLowerCase();
    if (lc.includes('boy') || lc.includes('male') || lc === 'm') return 'M';
    if (lc.includes('girl') || lc.includes('female') || lc === 'f') return 'F';
    return '';
  }

  const header = 'zip,city,state,country,gender,grad_year,league';
  const rows = [];

  for (const r of results) {
    const zip    = (r.zip   || '').slice(0, 5);
    const city   = (r.city  || '').replace(/,/g, ' ');
    const state  = r.state  || '';
    const gender = mapGender(r.gender);
    const league = (r.eventName || '').replace(/,/g, ' ');

    const gyears = (r.gradYears || []).filter(y => /^\d{4}$/.test(y));
    if (gyears.length === 0) {
      rows.push([zip, city, state, 'US', gender, '', league].join(','));
    } else {
      for (const gy of gyears) {
        rows.push([zip, city, state, 'US', gender, gy, league].join(','));
      }
    }
  }

  const csv = [header, ...rows].join('\r\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="fb_audience_${slug}_${date}.csv"`);
  res.send(csv);
});

// ── Per-league detail analytics (from store — no API call) ────────────────────

app.get('/api/reports/league-detail', async (req, res) => {
  const { eventId } = req.query;
  if (!eventId) return res.status(400).json({ error: 'eventId required' });

  const db  = await store.load();
  const all = db.results.filter(r => String(r.eventId) === String(eventId));
  // Count all registrations; use completed ones for deeper stats
  const completed = all.filter(r => r.completed);
  const curYear   = new Date().getFullYear();

  const gradYearMap = {}, genderMap = {}, gradeMap = {}, cityMap = {}, stateMap = {};

  function gradeLabel(gy) {
    const g = 12 - (parseInt(gy) - curYear);
    if (g <= 0)  return 'K or below';
    if (g > 12)  return '12+ (alumni)';
    if (g === 0) return 'Kindergarten';
    return `Grade ${g}`;
  }
  function gradeBucket(gy) {
    const g = 12 - (parseInt(gy) - curYear);
    if (g <= 2)  return 'K–2  (ages 5–8)';
    if (g <= 5)  return '3–5  (ages 8–11)';
    if (g <= 8)  return '6–8  (ages 11–14)';
    return '9–12 (ages 14–18)';
  }

  // Cross-tabulation: gradYear × gender (for accurate estimates in export config)
  const crossTabMap = {}; // `${year}|${gender}` → count

  for (const r of completed) {
    const g  = r.gender?.trim() || '';
    const ci = r.city?.trim();  if (ci) cityMap[ci]  = (cityMap[ci]  || 0) + 1;
    const st = r.state?.trim(); if (st) stateMap[st] = (stateMap[st] || 0) + 1;
    if (g) genderMap[g] = (genderMap[g] || 0) + 1;

    for (const gy of (r.gradYears || [])) {
      if (!/^\d{4}$/.test(gy)) continue;
      gradYearMap[gy] = (gradYearMap[gy] || 0) + 1;
      gradeMap[gradeLabel(gy)] = (gradeMap[gradeLabel(gy)] || 0) + 1;
      const key = `${gy}|${g}`;
      crossTabMap[key] = (crossTabMap[key] || 0) + 1;
    }
  }

  const toArr = m => Object.entries(m).map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count);
  const gradYearArr = Object.entries(gradYearMap)
    .map(([name,count])=>({name,count,bucket:gradeBucket(name),grade:gradeLabel(name)}))
    .sort((a,b)=>a.name.localeCompare(b.name));

  // Grade bucket rollup
  const bucketMap = {};
  for (const { bucket, count } of gradYearArr) bucketMap[bucket] = (bucketMap[bucket] || 0) + count;
  const buckets = Object.entries(bucketMap).map(([name,count])=>({name,count})).sort((a,b)=>a.name.localeCompare(b.name));

  // Cross-tab as flat array: [{year, gender, count}]
  const crossTab = Object.entries(crossTabMap).map(([key, count]) => {
    const [year, gender] = key.split('|');
    return { year, gender: gender || '(unknown)', count };
  });

  const ev = db.events[eventId];
  res.json({
    eventId,
    eventName:    ev?.name || all[0]?.eventName || '',
    totalStored:  all.length,
    totalComplete:completed.length,
    graduationYear: gradYearArr,
    gradeBuckets:   buckets,
    gender:         toArr(genderMap),
    crossTab,
    city:           toArr(cityMap).slice(0, 15),
    state:          toArr(stateMap),
  });
});

// ── Export history — list / create / delete ───────────────────────────────────

app.get('/api/exports', async (req, res) => {
  const { eventId } = req.query;
  let list = await loadExportsMeta();
  if (eventId) list = list.filter(e => String(e.eventId) === String(eventId));
  res.json(list.sort((a,b) => b.createdAt.localeCompare(a.createdAt)));
});

app.post('/api/exports', async (req, res) => {
  const meta = req.body;
  if (!meta?.eventId) return res.status(400).json({ error: 'eventId required' });
  const list = await loadExportsMeta();
  const id   = Math.random().toString(36).slice(2) + Date.now().toString(36);
  list.unshift({ id, createdAt: new Date().toISOString(), ...meta });
  // Keep at most 200 records total
  await saveExportsMeta(list.slice(0, 200));
  res.json({ id });
});

app.delete('/api/exports/:id', async (req, res) => {
  const list = loadExportsMeta().filter(e => e.id !== req.params.id);
  await saveExportsMeta(list);
  res.json({ ok: true });
});

// ── On-demand FB Audience CSV — fetches emails live from SportsEngine API ─────
// This makes real API calls (may take 15–60s for large events).

app.get('/api/export/league-csv', async (req, res) => {
  const { eventId, orgId: qOrgId = '8008', year, gender } = req.query;
  if (!eventId) return res.status(400).json({ error: 'eventId required' });

  try {
    // Fetch all registration results with full answer data
    const reg = await fetchAllRegistrationResults(eventId, qOrgId);
    const rawResults = reg?.registrationResults || [];

    // Extract contact details from form answers
    function extractContact(answers) {
      const ans = answers || [];
      const pick = (...keys) => pickAnswer(ans, ...keys);
      const pickAll = (...keys) => pickAnswerAll(ans, ...keys);

      // Email: try common field name patterns
      const email = pick('email', 'contact email', 'guardian email', 'parent email',
                         'account email', 'e-mail', 'family email');
      const phone = pick('phone', 'mobile', 'cell', 'telephone', 'contact phone');
      const firstName = pick('first name', 'contact first', 'parent first', 'guardian first', 'fname');
      const lastName  = pick('last name',  'contact last',  'parent last',  'guardian last',  'lname');
      const zip    = pick('zip', 'postal');
      const city   = pick('city');
      const state  = pick('state/province', 'state');
      const gender = pick('gender of team', 'gender');
      const gradYears = pickAll('graduation year', 'grad year');

      return { email, phone, firstName, lastName, zip, city, state, gender, gradYears };
    }

    function mapGender(g) {
      if (!g) return '';
      const lc = g.toLowerCase();
      if (lc.includes('girl') || lc.includes('female') || lc === 'f') return 'F';
      if (lc.includes('boy')  || lc.includes('male')   || lc === 'm') return 'M';
      return '';
    }

    let rows = rawResults
      .filter(r => r.completed)
      .map(r => ({ ...extractContact(r.answers), id: r.id }));

    // Apply optional filters
    if (year)   rows = rows.filter(r => r.gradYears.includes(year));
    if (gender) rows = rows.filter(r => r.gender && r.gender.toLowerCase().includes(gender.toLowerCase()));

    const evName  = reg?.name || `event_${eventId}`;
    const slug    = evName.replace(/[^a-z0-9]/gi, '_').replace(/_+/g,'_').slice(0, 36);
    const suffix  = [year, gender ? gender.toLowerCase() : ''].filter(Boolean).join('_');
    const date    = store.todayCDT();
    const fname   = `fb_${slug}${suffix ? '_'+suffix : ''}_${date}.csv`;

    const header  = 'email,fn,ln,phone,zip,city,state,country,gender,grad_years,league';
    const csvRows = rows.map(r => [
      r.email || '',
      (r.firstName || '').replace(/,/g, ' '),
      (r.lastName  || '').replace(/,/g, ' '),
      r.phone || '',
      (r.zip   || '').slice(0, 5),
      (r.city  || '').replace(/,/g, ' '),
      r.state  || '',
      'US',
      mapGender(r.gender),
      (r.gradYears || []).join(';'),
      evName.replace(/,/g, ' '),
    ].join(','));

    const csv = [header, ...csvRows].join('\r\n');
    res.setHeader('Content-Type',        'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── FB Audience CSV stream — SSE progress + permanent disk-based download ─────
// Streams fetch progress so the UI can show a live terminal.
// On completion the CSV is written to server/data/exports/<token>.csv (permanent).
// The in-memory cache is kept as a fast-path for the immediate download but the
// disk file is the authoritative copy — always available until manually deleted.

const EXPORTS_CSV_DIR = path.join(__dirname, 'data', 'exports');
const exportCache     = new Map(); // token → { filename, expireAt } (fast-path only)

app.get('/api/export/league-csv-stream', async (req, res) => {
  // years = comma-separated list of grad years to include
  // genders = comma-separated list of gender strings to include
  const { eventId, orgId: qOrgId = '8008', years, genders } = req.query;
  if (!eventId) { res.status(400).end(); return; }

  res.setHeader('Content-Type',       'text/event-stream');
  res.setHeader('Cache-Control',      'no-cache');
  res.setHeader('Connection',         'keep-alive');
  res.setHeader('X-Accel-Buffering',  'no');
  res.flushHeaders();

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const log  = (msg, level='info') => send('log', { ts: new Date().toLocaleTimeString('en-US',{hour12:false}), msg, level });

  // Optional filters
  const yearSet    = years   ? new Set(years.split(',').map(s=>s.trim()).filter(Boolean))   : null;
  const genderSet  = genders ? new Set(genders.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean)) : null;

  function mapGender(g) {
    if (!g) return '';
    const lc = g.toLowerCase();
    if (lc.includes('girl') || lc.includes('female') || lc==='f') return 'F';
    if (lc.includes('boy')  || lc.includes('male')   || lc==='m') return 'M';
    return '';
  }

  try {
    log(`Connecting to SportsEngine — event ${eventId}…`, 'info');

    // Paginate registration results
    const PER_PAGE = 25;
    let allResults = [], regMeta = null, page = 1;

    do {
      const data = await graphql(ANSWERS_QUERY, {
        regId: String(eventId), orgId: parseInt(qOrgId), page, perPage: PER_PAGE,
      });
      const reg = data?.data?.registration;
      if (!reg) { log('  ✗ Empty response from API', 'error'); break; }
      regMeta = reg;
      const batch = reg.registrationResults || [];
      allResults = allResults.concat(batch);
      const pct = reg.resultsCompleted > 0 ? Math.round(allResults.length / reg.resultsCompleted * 100) : '?';
      log(`  ← page ${page}: +${batch.length} results (${allResults.length}/${reg.resultsCompleted} — ${pct}%)`, 'response');
      if (batch.length < PER_PAGE) break;
      page++;
      await new Promise(r => setTimeout(r, 300));
    } while (true);

    log(`Fetched ${allResults.length} total results`, 'ok');
    log('Extracting contact info and applying filters…', 'info');

    function extractContact(answers) {
      const ans = answers || [];
      const pick    = (...keys) => pickAnswer(ans,    ...keys);
      const pickAll = (...keys) => pickAnswerAll(ans, ...keys);
      return {
        email:      pick('email','contact email','guardian email','parent email','account email','e-mail','family email'),
        phone:      pick('phone','mobile','cell','telephone','contact phone'),
        firstName:  pick('first name','contact first','parent first','guardian first','fname'),
        lastName:   pick('last name', 'contact last', 'parent last', 'guardian last', 'lname'),
        zip:        pick('zip','postal'),
        city:       pick('city'),
        state:      pick('state/province','state'),
        gender:     pick('gender of team','gender'),
        gradYears:  pickAll('graduation year','grad year'),
      };
    }

    let rows = allResults
      .filter(r => r.completed)
      .map(r => ({ ...extractContact(r.answers), id: r.id }));

    // Apply grad year filter
    if (yearSet) rows = rows.filter(r => r.gradYears.some(y => yearSet.has(y)));

    // Apply gender filter (match any of the selected genders)
    if (genderSet) {
      rows = rows.filter(r => {
        const lc = (r.gender || '').toLowerCase();
        return [...genderSet].some(g => lc.includes(g));
      });
    }

    log(`${rows.length} rows after filters — building CSV…`, 'info');

    // Compute distributions for saving to export history
    const gyDistMap = {}, geDistMap = {};
    for (const r of rows) {
      const geLc = mapGender(r.gender);
      const geLabel = geLc === 'F' ? 'Girls' : geLc === 'M' ? 'Boys' : r.gender || '(unknown)';
      if (geLabel) geDistMap[geLabel] = (geDistMap[geLabel]||0)+1;
      for (const gy of (r.gradYears||[])) {
        if (/^\d{4}$/.test(gy) && (!yearSet || yearSet.has(gy))) {
          gyDistMap[gy] = (gyDistMap[gy]||0)+1;
        }
      }
    }
    const gyDist = Object.entries(gyDistMap).map(([name,count])=>({name,count})).sort((a,b)=>a.name.localeCompare(b.name));
    const geDist = Object.entries(geDistMap).map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count);

    const evName  = regMeta?.name || `event_${eventId}`;
    const dateStr = store.todayCDT();
    const slug    = evName.replace(/[^a-z0-9]/gi,'_').replace(/_+/g,'_').slice(0,30);
    const yrLabel = yearSet ? [...yearSet].sort().join('-') : 'all-years';
    const geLabel = genderSet ? [...genderSet].join('-') : 'all-genders';
    const filename = `fb_${slug}_${yrLabel}_${geLabel}_${dateStr}.csv`;

    const header  = 'email,fn,ln,phone,zip,city,state,country,gender,grad_years,league';
    const csvRows = rows.map(r => [
      r.email      || '',
      (r.firstName || '').replace(/,/g,' '),
      (r.lastName  || '').replace(/,/g,' '),
      r.phone      || '',
      (r.zip       || '').slice(0,5),
      (r.city      || '').replace(/,/g,' '),
      r.state      || '',
      'US',
      mapGender(r.gender),
      (r.gradYears || []).filter(y=>!yearSet||yearSet.has(y)).join(';'),
      evName.replace(/,/g,' '),
    ].join(','));

    const csv = [header, ...csvRows].join('\r\n');

    // Write permanently via blobStorage (fs locally, Vercel Blob in prod)
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    await blobStorage.writeFile(`exports/${token}.csv`, csv, 'text/csv; charset=utf-8');
    exportCache.set(token, { filename, expireAt: Date.now() + 300000 });

    // Save to export history
    const exportMeta = {
      id: token,
      createdAt:    new Date().toISOString(),
      eventId:      String(eventId),
      eventName:    evName,
      gradYears:    yearSet ? [...yearSet].sort() : [],
      genders:      genderSet ? [...genderSet] : [],
      rowCount:     rows.length,
      filename,
      gradYearDist: gyDist,
      genderDist:   geDist,
    };
    const allExports = await loadExportsMeta();
    allExports.unshift(exportMeta);
    await saveExportsMeta(allExports.slice(0, 200));

    log(`✓ CSV ready — ${rows.length} rows · saved to export history`, 'ok');
    send('complete', { token, filename, rowCount: rows.length, exportId: token });
    res.end();
  } catch (err) {
    log(`✗ Error: ${err.message}`, 'error');
    send('error', { message: err.message });
    res.end();
  }
});

app.get('/api/export/league-csv-download', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'token required' });

  const csvFilename = `exports/${token}.csv`;

  // Try blobStorage (works on both local disk and Vercel Blob)
  const downloadUrl = await blobStorage.getDownloadUrl(csvFilename);
  if (downloadUrl) {
    const meta     = (await loadExportsMeta()).find(e => e.id === token);
    const filename = meta?.filename || `fb_export_${token}.csv`;

    if (process.env.VERCEL === '1') {
      // On Vercel: redirect to the signed Blob URL
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.redirect(302, downloadUrl);
    } else {
      // Locally: serve the file directly
      res.setHeader('Content-Type',        'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.sendFile(downloadUrl);
    }
  }

  res.status(404).json({ error: 'Export not found. Re-export from History to regenerate.' });
});

// Delete an export file + metadata
app.delete('/api/export/league-csv/:token', async (req, res) => {
  const { token } = req.params;
  await blobStorage.deleteFile(`exports/${token}.csv`);
  exportCache.delete(token);
  const list = (await loadExportsMeta()).filter(e => e.id !== token);
  await saveExportsMeta(list);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// CONTACT STORE — persistent registrant contact details
// ══════════════════════════════════════════════════════════════════════════════

// ── Status ────────────────────────────────────────────────────────────────────
app.get('/api/contacts/status', async (req, res) => {
  const db   = await contactStore.load();
  const evts = Object.values(db.events);
  res.json({
    totalContacts:   db.meta.totalContacts || 0,
    lastUpdatedAt:   db.meta.lastUpdatedAt,
    totalEvents:     evts.length,
    closedFetched:   evts.filter(e => e.status !== 1).length,
    openFetched:     evts.filter(e => e.status === 1).length,
    events:          evts.sort((a,b)=>b.contactCount-a.contactCount),
  });
});

// ── Preview — estimate audience size from stored contacts ─────────────────────
app.get('/api/contacts/preview', async (req, res) => {
  const { eventIds, gradYearFrom, gradYearTo, genders } = req.query;
  const db = await contactStore.load();
  const filtered = contactStore.filterContacts(db, {
    eventIds:    eventIds   ? eventIds.split(',').map(s=>s.trim())    : null,
    gradYearFrom: gradYearFrom || null,
    gradYearTo:   gradYearTo   || null,
    genders:     genders    ? genders.split(',').map(s=>s.trim())     : null,
  });
  res.json(contactStore.summarise(filtered));
});

// ── SSE stream — fetch contacts from SportsEngine for selected events ─────────
//
// Streams progress per event. Saves fetched contacts to contactStore.
// Respects the closed-once / open-incremental strategy.

const contactFetchState = { running: false, phase: 'idle', current: 0, total: 0, currentName: '' };
const contactClients    = new Set();

function contactBroadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of contactClients) {
    try { c.write(payload); } catch { contactClients.delete(c); }
  }
}

app.get('/api/contacts/stream', async (req, res) => {
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  contactClients.add(res);
  // Send current state immediately
  res.write(`event: state\ndata: ${JSON.stringify(contactFetchState)}\n\n`);
  req.on('close', () => contactClients.delete(res));
});

app.post('/api/contacts/fetch', async (req, res) => {
  const { orgId = '8008', eventIds, purgeFirst = false } = req.body || {};
  if (contactFetchState.running) {
    return res.json({ started: false, message: 'Fetch already in progress' });
  }
  res.json({ started: true });

  // Run async in background
  (async () => {
    const db = await contactStore.load();

    const clog = (msg, level='info') => {
      const entry = { ts: new Date().toLocaleTimeString('en-US',{hour12:false}), msg, level };
      contactBroadcast('log', entry);
    };

    // Determine which events to process
    let eventsToFetch;
    if (eventIds?.length) {
      // Specific events provided by client (already full objects)
      eventsToFetch = purgeFirst
        ? eventIds
        : contactStore.pendingEvents(db, eventIds);
    } else {
      // Fetch ALL events — first discover them
      clog('Discovering all events from SportsEngine…', 'info');
      let allEvents = [], page = 1, totalPages = 1;
      do {
        const d = await graphql(`query($orgId:Int!,$page:Int,$perPage:Int!){
          registrations(organizationId:$orgId,page:$page,perPage:$perPage){
            pageInformation{pages}
            results{id name status open close sport resultsCompleted}
          }
        }`, { orgId: parseInt(orgId), page, perPage: 100 });
        const r = d?.data?.registrations;
        if (!r) break;
        allEvents  = allEvents.concat(r.results||[]);
        totalPages = r.pageInformation?.pages||1;
        page++;
        if (page <= totalPages) await new Promise(r=>setTimeout(r,200));
      } while (page <= totalPages);
      clog(`Discovered ${allEvents.length} events`, 'ok');
      eventsToFetch = purgeFirst ? allEvents : contactStore.pendingEvents(db, allEvents);
    }

    if (purgeFirst) {
      for (const ev of eventsToFetch) {
        const n = contactStore.purgeEvent(db, ev.id);
        if (n>0) clog(`  Purged ${n} contacts from "${ev.name}"`, 'warn');
      }
      await contactStore.save(db);
    }

    Object.assign(contactFetchState, {
      running: true, phase: 'fetching',
      current: 0, total: eventsToFetch.length, currentName: '',
    });
    contactBroadcast('state', contactFetchState);

    clog(`Need to fetch ${eventsToFetch.length} events`, 'info');

    function extractContact(answers) {
      const ans = answers || [];
      const pick    = (...keys) => pickAnswer(ans,    ...keys);
      const pickAll = (...keys) => pickAnswerAll(ans, ...keys);
      return {
        email:      pick('email','contact email','guardian email','parent email','account email','e-mail','family email'),
        phone:      pick('phone','mobile','cell','telephone','contact phone'),
        firstName:  pick('first name','contact first','parent first','guardian first','fname'),
        lastName:   pick('last name', 'contact last', 'parent last', 'guardian last', 'lname'),
        zip:        pick('zip','postal'),
        city:       pick('city'),
        state:      pick('state/province','state'),
        gender:     pick('gender of team','gender'),
        gradYears:  pickAll('graduation year','grad year'),
      };
    }

    for (let i=0; i<eventsToFetch.length; i++) {
      const ev = eventsToFetch[i];
      contactFetchState.currentName = ev.name;
      contactBroadcast('state', contactFetchState);
      clog(`[${i+1}/${eventsToFetch.length}] "${ev.name}"`, 'info');

      const PER_PAGE         = 25;
      const currentCompleted = ev.resultsCompleted || 0;
      const storedEvt        = db.events[String(ev.id)];
      const storedCompleted  = storedEvt?.resultsCompleted ?? null;
      const storedCount      = storedEvt?.contactCount     || 0;

      if (currentCompleted === 0) {
        clog(`  ↷ SKIP — 0 completions`, 'skip');
        contactStore.upsertContacts(db, ev, []);
        await contactStore.save(db);
        contactFetchState.current++;
        contactBroadcast('state', contactFetchState);
        continue;
      }

      // Count unchanged — no new contacts to fetch
      if (storedCompleted !== null && currentCompleted === storedCompleted) {
        clog(`  ↷ SKIP — count unchanged (${currentCompleted} completions, already stored)`, 'skip');
        contactFetchState.current++;
        contactBroadcast('state', contactFetchState);
        continue;
      }

      // Incremental: start from the page where new records appear
      const startPage = (storedCompleted !== null && currentCompleted > storedCompleted && storedCount > 0)
        ? Math.max(1, Math.floor(storedCount / PER_PAGE))
        : 1;

      if (startPage > 1) {
        clog(`  ↑ Incremental: ${storedCompleted} → ${currentCompleted} — fetching from page ${startPage}`, 'info');
      }

      try {
        let allResults = [], regMeta = null, page = startPage;
        do {
          const data = await graphql(ANSWERS_QUERY, {
            regId: String(ev.id), orgId: parseInt(orgId), page, perPage: PER_PAGE,
          });
          const reg = data?.data?.registration;
          if (!reg) break;
          regMeta = reg;
          const batch = reg.registrationResults||[];
          allResults = allResults.concat(batch);
          const pct = reg.resultsCompleted>0?Math.round((storedCount+allResults.length)/reg.resultsCompleted*100):'?';
          clog(`  ← page ${page}: +${batch.length} (${storedCount+allResults.length}/${reg.resultsCompleted} — ${pct}%)`, 'response');
          if (batch.length < PER_PAGE) break;
          page++;
          await new Promise(r=>setTimeout(r,300));
        } while (true);

        const contacts = allResults
          .filter(r=>r.completed)
          .map(r=>({ resultId:r.id, ...extractContact(r.answers) }));

        const saved = contactStore.upsertContacts(db, ev, contacts);
        // Update resultsCompleted so next run can do count comparison
        if (db.events[String(ev.id)]) {
          db.events[String(ev.id)].resultsCompleted = regMeta?.resultsCompleted ?? currentCompleted;
        }
        await contactStore.save(db);
        clog(`  ✓ Saved ${saved} new contact(s)`, 'ok');
      } catch (err) {
        clog(`  ✗ Failed: ${err.message}`, 'error');
      }

      contactFetchState.current++;
      contactBroadcast('state', contactFetchState);
      if (i < eventsToFetch.length-1) await new Promise(r=>setTimeout(r,1200));
    }

    Object.assign(contactFetchState, { running:false, phase:'done' });
    contactBroadcast('state', contactFetchState);
    const final = contactStore.load();
    contactBroadcast('complete', {
      totalContacts: final.meta.totalContacts,
      eventsFetched: eventsToFetch.length,
    });
    clog(`✓ Done — ${final.meta.totalContacts} contacts stored`, 'ok');
  })().catch(err => {
    Object.assign(contactFetchState, { running:false, phase:'idle' });
    contactBroadcast('error', { message: err.message });
  });
});

// ── Purge contacts for specific events ────────────────────────────────────────
app.post('/api/contacts/purge', async (req, res) => {
  const { eventIds = [] } = req.body;
  const db = await contactStore.load();
  let total = 0;
  for (const id of eventIds) total += contactStore.purgeEvent(db, id);
  await contactStore.save(db);
  res.json({ deleted: total });
});

// ── Audience export — instant from stored contacts (no API call) ──────────────
app.get('/api/contacts/export', async (req, res) => {
  const { eventIds, gradYearFrom, gradYearTo, genders, label = 'audience' } = req.query;
  const db = await contactStore.load();

  const filtered = contactStore.filterContacts(db, {
    eventIds:     eventIds     ? eventIds.split(',').map(s=>s.trim())     : null,
    gradYearFrom: gradYearFrom || null,
    gradYearTo:   gradYearTo   || null,
    genders:      genders      ? genders.split(',').map(s=>s.trim())      : null,
  });

  function mapGender(g) {
    if (!g) return '';
    const lc = g.toLowerCase();
    if (lc.includes('girl')||lc.includes('female')||lc==='f') return 'F';
    if (lc.includes('boy') ||lc.includes('male')  ||lc==='m') return 'M';
    return '';
  }

  const slug = label.replace(/[^a-z0-9]/gi,'_').replace(/_+/g,'_').slice(0,40);
  const date = store.todayCDT();

  const header = 'email,phone,fn,ln,zip,city,state,country,gender,grad_years,league';
  const rows   = filtered.map(c => [
    c.email     || '',
    c.phone     || '',
    (c.firstName||'').replace(/,/g,' '),
    (c.lastName ||'').replace(/,/g,' '),
    (c.zip      ||'').slice(0,5),
    (c.city     ||'').replace(/,/g,' '),
    c.state     || '',
    'US',
    mapGender(c.gender),
    (c.gradYears||[]).filter(y=>(!gradYearFrom||y>=gradYearFrom)&&(!gradYearTo||y<=gradYearTo)).join(';'),
    (c.eventName||'').replace(/,/g,' '),
  ].join(','));

  const csv = [header, ...rows].join('\r\n');
  res.setHeader('Content-Type',        'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="fb_audience_${slug}_${date}.csv"`);
  res.send(csv);
});

// ── Clear cache ────────────────────────────────────────────────────────────────

app.post('/api/cache/clear', async (req, res) => {
  cache.flushAll();
  tokenCache = { token: null, expiresAt: 0 };
  res.json({ message: 'Cache cleared' });
});

// Export for Vercel (api/index.js imports this)
// Also start the server when run directly (local dev)
// ── Runtime info — lets the client know if it's talking to Vercel ────────────
app.get('/api/runtime', (req, res) => {
  res.json({ vercel: process.env.VERCEL === '1' });
});

module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}
