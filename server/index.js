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

app.set('trust proxy', 1); // Vercel / reverse-proxy environments set X-Forwarded-For
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(rateLimit({
  windowMs: 60000,
  max: 200,
  validate: { xForwardedForHeader: false, forwardedHeader: false },
}));

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

/**
 * Groups raw answers by "Player N" / "Member N" number to produce per-player records.
 * Returns [{name, email, phone, gradYear}, ...] sorted by player number.
 * Returns [] if the form doesn't use numbered player fields.
 */
function extractPlayers(answers) {
  const ans = answers || [];
  const groups = new Map(); // "1","2",... → {firstName, lastName, name, email, phone, gradYear}

  for (const a of ans) {
    const fieldName = a.name || '';
    const val = resolveAnswerVal(a);
    if (!val) continue;
    const lo = fieldName.toLowerCase();

    const m = fieldName.match(/(?:player|member|participant|athlete)\s*#?\s*(\d+)/i);
    if (!m) continue;
    const num = m[1];
    if (!groups.has(num)) groups.set(num, {});
    const g = groups.get(num);

    if (/first[\s_-]?name|fname/i.test(lo) && !/last/i.test(lo))      g.firstName = val;
    else if (/last[\s_-]?name|lname/i.test(lo))                        g.lastName  = val;
    else if (/\bname\b/i.test(lo) && !/first|last|team|league/i.test(lo)) {
      if (!g.firstName) g.name = val;
    } else if (/email|e-mail/i.test(lo) && val.includes('@'))          g.email    = val.toLowerCase().trim();
    else if (/phone|cell|mobile|telephone/i.test(lo)) {
      const d = String(val).replace(/\D/g, '').slice(-10);
      if (d.length >= 10) g.phone = d;
    } else if (/grad(uation)?\s*year/i.test(lo)) {
      const y = String(val).trim();
      if (/^\d{4}$/.test(y)) g.gradYear = y;
    }
  }

  return [...groups.entries()]
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, g]) => ({
      name:     g.name || [g.firstName, g.lastName].filter(Boolean).join(' ') || null,
      email:    g.email    || null,
      phone:    g.phone    || null,
      gradYear: g.gradYear || null,
    }))
    .filter(p => p.email || p.name || p.phone);
}

// Parses GraphQL form answers into the shape stored per result.
function extractAnswers(answers) {
  const ans = answers || [];
  const gradYears = pickAnswerAll(ans, 'graduation year', 'grad year')
    .filter(v => /^\d{4}$/.test(String(v).trim()))
    .map(v => String(v).trim());

  if (!gradYears.length) {
    const div = pickAnswer(ans, 'desired division', 'division of play');
    if (div) { const y = String(div).replace(/\D/g, ''); if (y.length === 4) gradYears.push(y); }
  }

  const city   = pickAnswer(ans, 'city');
  const state  = pickAnswer(ans, 'state/province', 'state');
  const zipRaw = pickAnswer(ans, 'zip', 'postal');

  // Collect ALL emails and phones — league forms have one per player on the team
  const emails = [...new Set(
    pickAnswerAll(ans, 'email', 'e-mail', 'email address')
      .map(v => String(v).trim().toLowerCase())
      .filter(v => v.includes('@'))
  )];
  const phones = [...new Set(
    pickAnswerAll(ans, 'phone', 'cell', 'mobile', 'contact number', 'telephone')
      .map(v => String(v).replace(/\D/g, '').slice(-10))
      .filter(v => v.length >= 10)
  )];

  const players = extractPlayers(ans);

  return {
    gradYears,
    gender:  pickAnswer(ans, 'gender of team', 'gender') || null,
    city:    city   ? city.trim()  : null,
    state:   state  ? state.trim() : null,
    zip:     zipRaw ? String(zipRaw).trim().slice(0, 5) : null,
    email:   emails[0] || null,
    emails,
    phone:   phones[0] || null,
    phones,
    grade:   pickAnswer(ans, 'grade', 'current grade', 'school grade', 'grade level')?.trim() || null,
    players, // per-player [{name, email, phone, gradYear}] — populated when form uses "Player N" fields
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

// Fetches ONE page per call. Client loops until hasMore === false.
// Blob is only written on the FINAL page (hasMore === false) to minimise write operations.
// Intermediate pages return compact results in the response; the client sends them back
// in prevCompact on subsequent calls so the server can commit everything at once.
app.post('/api/aggregate/fetch-event', async (req, res) => {
  const {
    orgId = '8008', eventId, eventName, eventStatus,
    resultsCompleted: currentCompleted = 0,
    purgeFirst = false,
    backfill  = false,     // re-fetch all pages and merge new fields into existing records (no purge)
    page: requestedPage,   // undefined/null = first call; number = continuation
    prevCompact = [],      // compact results from earlier pages (client carries them)
  } = req.body || {};
  if (!eventId) return res.status(400).json({ error: 'eventId required' });

  const isFirstCall = requestedPage == null;

  try {
    const db = await store.load();

    // Purge is disabled on Vercel — only allowed in local dev
    if (isFirstCall && purgeFirst && process.env.VERCEL !== '1') store.purgeEvent(db, String(eventId));

    const storedEvent     = db.events[String(eventId)];
    const storedCompleted = storedEvent?.resultsCompleted ?? null;
    const storedCount     = storedEvent?.resultCount     || 0;

    // Skip when count unchanged — but never skip in backfill or purge mode
    if (isFirstCall && !purgeFirst && !backfill && storedCompleted !== null && currentCompleted === storedCompleted) {
      return res.json({ added: 0, skipped: true, reason: 'count_unchanged', eventId });
    }

    const PER_PAGE = 25;
    const fetchPage = isFirstCall
      ? ((!purgeFirst && !backfill && storedCompleted !== null && currentCompleted > storedCompleted && storedCount > 0)
          ? Math.max(1, Math.floor(storedCount / PER_PAGE))
          : 1)
      : requestedPage;

    const ANSWERS_Q = `query($regId:ID!,$orgId:Int!,$page:Int,$perPage:Int!){
      registration(id:$regId,organizationId:$orgId){
        id name resultsCompleted
        registrationResults(page:$page,perPage:$perPage){
          id profileId completed status created
          totalPaid amountDue itemTotal
          answers{
            name
            ...on StringRegistrationResultAnswer{strValue:value}
            ...on NumberRegistrationResultAnswer{numValue:value}
            ...on ArrayRegistrationResultAnswer{arrValue:value}
          }
        }
      }
    }`;

    const d = await graphql(ANSWERS_Q, { regId: String(eventId), orgId: parseInt(orgId), page: fetchPage, perPage: PER_PAGE });
    const r = d?.data?.registration;
    if (!r) return res.json({ added: 0, fetched: 0, hasMore: false, page: fetchPage, skipped: false, eventId });

    const batch   = r.registrationResults || [];
    const hasMore = batch.length >= PER_PAGE;

    const evObj     = { id: String(eventId), name: eventName || r.name || String(eventId), status: eventStatus ?? 2 };
    const thisPage  = batch.map(row => {
      const parsed = extractAnswers(row.answers || []);
      const revenue = row.totalPaid ?? row.itemTotal ?? row.amountDue ?? null;
      return { id: row.id, profileId: row.profileId || null, eventId: String(eventId), eventName: evObj.name, created: row.created || null, completed: row.completed, revenue, ...parsed };
    });
    const allCompact = [...(prevCompact || []), ...thisPage];

    if (!hasMore) {
      // Final page — commit everything to blob (1 write per event, not per page)
      const added = store.upsertResults(db, String(eventId), evObj.name, allCompact, { merge: backfill });
      store.upsertEventMeta(db, evObj, {
        fetchedAt:        new Date().toISOString(),
        resultCount:      storedCount + added,
        resultsCompleted: r.resultsCompleted ?? currentCompleted,
      });
      await store.save(db);
      cache.del('analytics_agg');

      return res.json({
        added, fetched: allCompact.length, skipped: false, backfilled: backfill,
        hasMore: false, nextPage: null,
        page: fetchPage, eventId, eventName: evObj.name,
      });
    }

    // Intermediate page — return this page's compact rows for the client to carry forward
    res.json({
      added: 0, fetched: allCompact.length, skipped: false,
      hasMore: true, nextPage: fetchPage + 1,
      page: fetchPage, eventId, eventName: evObj.name,
      compact: allCompact,  // client echoes this back as prevCompact on the next call
    });
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

// ── Reports: league participant overlap ───────────────────────────────────────
// Each result is indexed by ALL its identifiers (profileId, email, phone).
// When matching a B result, all of its identifiers are tried against the A index,
// so a match fires even when the two leagues stored different subsets for the same person.

app.get('/api/reports/league-overlap', async (req, res) => {
  const { eventIdA, eventIdB } = req.query;
  if (!eventIdA || !eventIdB) return res.status(400).json({ error: 'eventIdA and eventIdB required' });

  const db = await store.load();
  const resultsA = db.results.filter(r => String(r.eventId) === String(eventIdA));
  const resultsB = db.results.filter(r => String(r.eventId) === String(eventIdB));

  // All matchable identifiers — uses every email/phone from multi-player league forms
  function getKeys(r) {
    const keys = [];
    if (r.profileId) keys.push(`pid:${String(r.profileId)}`);
    const allEmails = r.emails?.length ? r.emails : (r.email ? [r.email] : []);
    for (const e of allEmails) { if (e && e.includes('@')) keys.push(`em:${e.toLowerCase().trim()}`); }
    const allPhones = r.phones?.length ? r.phones : (r.phone ? [r.phone] : []);
    for (const p of allPhones) { const d = String(p).replace(/\D/g, ''); if (d.length >= 10) keys.push(`ph:${d.slice(-10)}`); }
    return keys;
  }

  // Build multi-key index for League A: identifier → result
  // Every identifier gets its own entry so any of them can trigger a match.
  const indexA    = new Map();
  let matchableA  = 0;
  for (const r of resultsA) {
    const keys = getKeys(r);
    if (keys.length) matchableA++;
    for (const k of keys) {
      if (!indexA.has(k)) indexA.set(k, r);
    }
  }

  // Walk every League B result and try each of its identifiers against indexA.
  // Deduplicate by A-side result id so a person who registered twice in B only
  // appears once in "returning" (same as scatter's dedup logic).
  const returning   = [];
  const newUsers    = [];
  const matchedAIds = new Set(); // source result ids already matched
  let matchableB    = 0;

  for (const rB of resultsB) {
    const keysB = getKeys(rB);
    if (keysB.length) matchableB++;
    let pairedA = null;
    for (const k of keysB) {
      if (indexA.has(k)) { pairedA = indexA.get(k); break; }
    }
    if (pairedA) {
      // Only add the first B-result that matches each A-result (dedup duplicates)
      if (!matchedAIds.has(pairedA.id)) {
        returning.push({ past: pairedA, current: rB });
      }
      matchedAIds.add(pairedA.id);
    } else {
      newUsers.push(rB);
    }
  }

  // Lapsed = everyone in A who was not matched by any B result
  const lapsed = resultsA.filter(r => !matchedAIds.has(r.id));

  const hasContactData =
    resultsA.some(r => r.email || r.phone) ||
    resultsB.some(r => r.email || r.phone);

  res.json({
    eventA: db.events[String(eventIdA)] || { id: eventIdA, name: 'League A' },
    eventB: db.events[String(eventIdB)] || { id: eventIdB, name: 'League B' },
    newUsers, returning, lapsed,
    stats: {
      totalA: resultsA.length, totalB: resultsB.length,
      matchable: { A: matchableA, B: matchableB },
      new: newUsers.length, returning: returning.length, lapsed: lapsed.length,
    },
    hasContactData,
  });
});

// ── League contact export — all unique emails/phones for one league ────────────

app.get('/api/reports/league-emails', async (req, res) => {
  const { eventId } = req.query;
  if (!eventId) return res.status(400).json({ error: 'eventId required' });

  const db = await store.load();
  const results = db.results.filter(r => String(r.eventId) === String(eventId));

  // Collect ALL emails and phones across every registration in the league
  const emailSet = new Set();
  const phoneSet = new Set();
  const contacts = []; // one row per registration result

  for (const r of results) {
    const allEmails = r.emails?.length ? r.emails : (r.email ? [r.email] : []);
    const allPhones = r.phones?.length ? r.phones : (r.phone ? [r.phone] : []);
    for (const e of allEmails) if (e) emailSet.add(e.toLowerCase().trim());
    for (const p of allPhones) if (p) phoneSet.add(String(p).replace(/\D/g,'').slice(-10));
    contacts.push({
      id: r.id, completed: r.completed, created: r.created,
      emails: allEmails, phones: allPhones,
      gradYears: r.gradYears || [], gender: r.gender || null,
      grade: r.grade || null, city: r.city || null, state: r.state || null,
    });
  }

  res.json({
    eventId,
    eventName: db.events[String(eventId)]?.name || String(eventId),
    totalRegistrations: results.length,
    uniqueEmails: [...emailSet],
    uniquePhones: [...phoneSet],
    contacts,
  });
});

// ── Form field inspector — shows all answer field names for a registration ─────
// Use this to understand how many email/phone fields a league form has.

app.get('/api/reports/form-fields', async (req, res) => {
  const { eventId, orgId = '8008' } = req.query;
  if (!eventId) return res.status(400).json({ error: 'eventId required' });

  const Q = `query($regId:ID!,$orgId:Int!){
    registration(id:$regId,organizationId:$orgId){
      id name
      registrationResults(page:1,perPage:3){
        id
        answers{
          name
          ...on StringRegistrationResultAnswer{strValue:value}
          ...on NumberRegistrationResultAnswer{numValue:value}
          ...on ArrayRegistrationResultAnswer{arrValue:value}
        }
      }
    }
  }`;

  try {
    const d = await graphql(Q, { regId: String(eventId), orgId: parseInt(orgId) });
    const results = d?.data?.registration?.registrationResults || [];

    // Collect all field names + a sample value (email/phone fields starred)
    const fieldMap = {};
    for (const r of results) {
      for (const a of (r.answers || [])) {
        const val = a.strValue ?? a.numValue ?? (Array.isArray(a.arrValue) ? a.arrValue[0] : a.arrValue) ?? '';
        const n   = a.name || '';
        const lo  = n.toLowerCase();
        const isEmail = /email|e-mail/.test(lo);
        const isPhone = /phone|cell|mobile|telephone/.test(lo);
        if (!fieldMap[n]) fieldMap[n] = { name: n, isEmail, isPhone, sample: String(val).slice(0, 40), count: 0 };
        fieldMap[n].count++;
      }
    }

    const fields = Object.values(fieldMap).sort((a, b) => a.name.localeCompare(b.name));
    const emailFields = fields.filter(f => f.isEmail);
    const phoneFields = fields.filter(f => f.isPhone);

    res.json({
      eventId,
      registrationName: d?.data?.registration?.name,
      sampleCount: results.length,
      totalFields: fields.length,
      emailFields,
      phoneFields,
      allFields: fields,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Reports: league scatter — "where did they go?" ────────────────────────────
// Given a source league, finds every destination league that any of its participants
// also joined, and lists participants who didn't sign up anywhere else.

app.get('/api/reports/league-scatter', async (req, res) => {
  const { sourceEventId, year } = req.query;
  if (!sourceEventId) return res.status(400).json({ error: 'sourceEventId required' });

  const db = await store.load();
  const sourceResults = db.results.filter(r => String(r.eventId) === String(sourceEventId));

  function getKeys(r) {
    const keys = [];
    if (r.profileId) keys.push(`pid:${String(r.profileId)}`);
    const allEmails = r.emails?.length ? r.emails : (r.email ? [r.email] : []);
    for (const e of allEmails) { if (e && e.includes('@')) keys.push(`em:${e.toLowerCase().trim()}`); }
    const allPhones = r.phones?.length ? r.phones : (r.phone ? [r.phone] : []);
    for (const p of allPhones) { const d = String(p).replace(/\D/g, ''); if (d.length >= 10) keys.push(`ph:${d.slice(-10)}`); }
    return keys;
  }

  // Index all source participants by every identifier
  const sourceIndex = new Map(); // identifier key → source result
  let matchable = 0;
  for (const r of sourceResults) {
    const keys = getKeys(r);
    if (keys.length) matchable++;
    for (const k of keys) { if (!sourceIndex.has(k)) sourceIndex.set(k, r); }
  }

  // Resolve the display year for an event — prefers the year in the event name
  // (e.g. "2026 Maple Grove…") because a league that opens in Dec 2025 for a
  // 2026 season would otherwise be misclassified by its open/close dates.
  function eventDisplayYear(eventId, fallbackName) {
    const ev = db.events[String(eventId)];
    const nameStr = ev?.name || fallbackName || '';
    const m = nameStr.match(/\b(20\d{2})\b/);
    if (m) return m[1];
    return (ev?.close || ev?.open || '').slice(0, 4);
  }

  // Walk all other leagues' results (optionally filtered by year)
  const otherResults = db.results.filter(r => {
    if (String(r.eventId) === String(sourceEventId)) return false;
    if (year) {
      if (eventDisplayYear(r.eventId, r.eventName) !== String(year)) return false;
    }
    return true;
  });

  // Bucket by destination event; each source participant counted at most once per destination
  const bucketMap     = new Map(); // eventId → { eventId, eventName, participants[] }
  const matchedSrcIds = new Set(); // source result ids that found at least one destination

  for (const rDest of otherResults) {
    const keys = getKeys(rDest);
    let srcResult = null;
    for (const k of keys) { if (sourceIndex.has(k)) { srcResult = sourceIndex.get(k); break; } }
    if (!srcResult) continue;

    if (!bucketMap.has(String(rDest.eventId))) {
      const ev = db.events[String(rDest.eventId)] || {};
      bucketMap.set(String(rDest.eventId), {
        eventId:   String(rDest.eventId),
        eventName: ev.name || rDest.eventName || String(rDest.eventId),
        participants: [],
      });
    }
    const bucket = bucketMap.get(String(rDest.eventId));
    // One entry per unique source participant per destination
    if (!bucket.participants.some(p => p.sourceId === srcResult.id)) {
      const mergedEmails = [...new Set([...(rDest.emails||[]), ...(srcResult.emails||[]), rDest.email, srcResult.email].filter(Boolean))];
      const mergedPhones = [...new Set([...(rDest.phones||[]), ...(srcResult.phones||[]), rDest.phone, srcResult.phone].filter(Boolean))];
      bucket.participants.push({
        sourceId:      srcResult.id,
        email:         mergedEmails[0] || null,
        emails:        mergedEmails,
        phone:         mergedPhones[0] || null,
        phones:        mergedPhones,
        gradYearPast:  srcResult.gradYears?.[0] || null,
        gradYearNow:   rDest.gradYears?.[0]    || null,
        grade:         rDest.grade  || srcResult.grade  || null,
        gender:        rDest.gender || srcResult.gender || null,
        city:          rDest.city   || srcResult.city   || null,
        state:         rDest.state  || srcResult.state  || null,
      });
      matchedSrcIds.add(srcResult.id);
    }
  }

  const buckets = [...bucketMap.values()]
    .map(b => ({ ...b, count: b.participants.length }))
    .sort((a, b) => b.count - a.count);

  const nowhere = sourceResults
    .filter(r => !matchedSrcIds.has(r.id))
    .map(r => ({
      sourceId: r.id,
      email:    r.email  || null,
      phone:    r.phone  || null,
      gradYear: r.gradYears?.[0] || null,
      grade:    r.grade  || null,
      gender:   r.gender || null,
      city:     r.city   || null,
      state:    r.state  || null,
    }));

  // foundUnique = distinct source participants who signed up in at least one destination.
  // totalCrossRegistrations = sum across buckets (one person in 3 leagues counts 3 times).
  const foundUnique             = matchedSrcIds.size;
  const totalCrossRegistrations = buckets.reduce((s, b) => s + b.count, 0);

  res.json({
    source: {
      id:        sourceEventId,
      name:      db.events[String(sourceEventId)]?.name || 'Source League',
      total:     sourceResults.length,
      matchable,
    },
    buckets,
    nowhere: { count: nowhere.length, participants: nowhere },
    year: year || null,
    stats: {
      foundUnique,             // unique people who signed up somewhere (foundUnique + nowhere = matchable)
      totalCrossRegistrations, // total registrations across all destination leagues (can exceed foundUnique)
      nowhere: nowhere.length,
    },
  });
});

// ── Reports: league scatter — individual participants ─────────────────────────
// Unlike the primary scatter (which matches registration-to-registration),
// this endpoint expands ALL emails/phones from every source registration and
// treats each unique contact as one individual participant.  It then searches
// the entire emails[] / phones[] arrays of every destination registration,
// so a player who appears as a non-primary team member is still matched.

app.get('/api/reports/league-scatter-individuals', async (req, res) => {
  const { sourceEventId, year } = req.query;
  if (!sourceEventId) return res.status(400).json({ error: 'sourceEventId required' });

  const db = await store.load();
  const sourceResults = db.results.filter(r => String(r.eventId) === String(sourceEventId));

  // Individual = unique email only.  Phones stored alongside the email for display,
  // but NOT counted as extra individuals — prevents doubling for players with both.
  const individualMap = new Map();    // em:key  → { email, phones: string[] }
  const phoneToEmailKey = new Map();  // ph:key  → em:key  (for cross-ref matching only)

  for (const r of sourceResults) {
    // Prefer players[] (structured per-player data set by backfill) over flat email/phone arrays
    const players = r.players?.length ? r.players : null;

    if (players) {
      // Best case: each player has their own {name, email, phone} — perfectly paired
      for (const p of players) {
        if (!p.email) continue;
        const key = `em:${p.email.toLowerCase().trim()}`;
        if (!individualMap.has(key)) individualMap.set(key, { name: p.name||null, email: p.email, phones: p.phone ? [p.phone] : [] });
        else if (p.phone) {
          const entry = individualMap.get(key);
          if (!entry.phones.includes(p.phone)) entry.phones.push(p.phone);
          if (!entry.name && p.name) entry.name = p.name;
        }
        if (p.phone) {
          const pk = `ph:${p.phone}`;
          if (!phoneToEmailKey.has(pk)) phoneToEmailKey.set(pk, key);
        }
      }
    } else {
      // Fallback: flat emails[]/phones[] arrays — pair by position
      const allEmails  = r.emails?.length ? r.emails : (r.email ? [r.email] : []);
      const allPhones  = r.phones?.length ? r.phones : (r.phone ? [r.phone] : []);
      const phonesClean = allPhones.map(p => String(p).replace(/\D/g, '').slice(-10)).filter(d => d.length >= 10);
      const emailKeys  = [];
      allEmails.forEach((e, idx) => {
        const key = `em:${e.toLowerCase().trim()}`;
        const pairedPhone = phonesClean[idx] || null;
        if (!individualMap.has(key)) individualMap.set(key, { name: null, email: e, phones: pairedPhone ? [pairedPhone] : [] });
        else if (pairedPhone) {
          const entry = individualMap.get(key);
          if (!entry.phones.includes(pairedPhone)) entry.phones.push(pairedPhone);
        }
        emailKeys.push(key);
      });
      if (emailKeys.length > 0) {
        for (const d of phonesClean) {
          const pk = `ph:${d}`;
          if (!phoneToEmailKey.has(pk)) phoneToEmailKey.set(pk, emailKeys[0]);
        }
      }
    }
  }

  function eventDisplayYear(eventId, fallbackName) {
    const ev = db.events[String(eventId)];
    const nameStr = ev?.name || fallbackName || '';
    const m = nameStr.match(/\b(20\d{2})\b/);
    if (m) return m[1];
    return (ev?.close || ev?.open || '').slice(0, 4);
  }

  const otherResults = db.results.filter(r => {
    if (String(r.eventId) === String(sourceEventId)) return false;
    if (year && eventDisplayYear(r.eventId, r.eventName) !== String(year)) return false;
    return true;
  });

  const bucketMap = new Map();
  const foundKeys = new Set();

  for (const rDest of otherResults) {
    const allEmails = rDest.emails?.length ? rDest.emails : (rDest.email ? [rDest.email] : []);
    const allPhones = rDest.phones?.length ? rDest.phones : (rDest.phone ? [rDest.phone] : []);

    const matched = new Set();
    for (const e of allEmails) {
      const key = `em:${e.toLowerCase().trim()}`;
      if (individualMap.has(key)) matched.add(key);
    }
    for (const p of allPhones) {
      const d = String(p).replace(/\D/g, '').slice(-10);
      if (d.length >= 10) {
        const pk = `ph:${d}`;
        // Resolve phone → email identity (doesn't create new individuals, just finds existing ones)
        const emailKey = phoneToEmailKey.get(pk);
        if (emailKey && individualMap.has(emailKey)) matched.add(emailKey);
      }
    }

    for (const key of matched) {
      foundKeys.add(key);
      if (!bucketMap.has(String(rDest.eventId))) {
        const ev = db.events[String(rDest.eventId)] || {};
        bucketMap.set(String(rDest.eventId), {
          eventId: String(rDest.eventId),
          eventName: ev.name || rDest.eventName,
          individuals: new Set(),
        });
      }
      bucketMap.get(String(rDest.eventId)).individuals.add(key);
    }
  }

  const buckets = [...bucketMap.values()]
    .map(b => ({
      eventId:      b.eventId,
      eventName:    b.eventName,
      count:        b.individuals.size,
      participants: [...b.individuals]
        .map(k => individualMap.get(k))
        .filter(Boolean)
        .map(v => ({ name: v.name||null, email: v.email, phones: v.phones })),
    }))
    .sort((a, b) => b.count - a.count);

  const nowhereList = [...individualMap.entries()]
    .filter(([k]) => !foundKeys.has(k))
    .map(([, v]) => ({ name: v.name||null, email: v.email, phones: v.phones }))
    .filter(v => v.email);

  res.json({
    source: {
      id:   sourceEventId,
      name: db.events[String(sourceEventId)]?.name || 'Source League',
      totalRegistrations: sourceResults.length,
      totalIndividuals:   individualMap.size,
    },
    buckets,
    nowhere: { count: nowhereList.length, list: nowhereList },
    stats: { found: foundKeys.size, nowhere: nowhereList.length, total: individualMap.size },
    year: year || null,
  });
});

// ── Lapsed individuals — source-year participants not in exclude-year ─────────
// Returns per-player records (uses players[] when available, else emails[]) for
// everyone in sourceYear leagues whose email/phone doesn't appear in excludeYear.

app.get('/api/reports/lapsed-individuals', async (req, res) => {
  // excludeMode: 'year' (default) | 'events'
  const {
    sourceYear, sourceEventIds,
    excludeYear = new Date().getFullYear().toString(),
    excludeEventIds,   // comma-sep event IDs to use as "already signed up" instead of a year
  } = req.query;

  const db = await store.load();

  function eventDisplayYear(eventId, fallbackName) {
    const ev = db.events[String(eventId)];
    const nameStr = ev?.name || fallbackName || '';
    const m = nameStr.match(/\b(20\d{2})\b/);
    if (m) return m[1];
    return (ev?.close || ev?.open || '').slice(0, 4);
  }

  // ── Source results ────────────────────────────────────────────────────────────
  const sourceIdSet = sourceEventIds ? new Set(sourceEventIds.split(',').map(s => s.trim())) : null;
  const sourceResults = db.results.filter(r => {
    if (sourceIdSet) return sourceIdSet.has(String(r.eventId));
    if (sourceYear)  return eventDisplayYear(r.eventId, r.eventName) === String(sourceYear);
    return true;
  });

  // ── Build exclude index ───────────────────────────────────────────────────────
  const excludeIndex = new Set();
  const excludeIdSet = excludeEventIds ? new Set(excludeEventIds.split(',').map(s => s.trim())) : null;

  const excludeResults = db.results.filter(r => {
    if (excludeIdSet) return excludeIdSet.has(String(r.eventId));
    return eventDisplayYear(r.eventId, r.eventName) === String(excludeYear);
  });

  for (const r of excludeResults) {
    const allEmails = r.emails?.length ? r.emails : (r.email ? [r.email] : []);
    const allPhones = r.phones?.length ? r.phones : (r.phone ? [r.phone] : []);
    for (const e of allEmails) if (e) excludeIndex.add(`em:${e.toLowerCase().trim()}`);
    for (const p of allPhones) {
      const d = String(p).replace(/\D/g, '').slice(-10);
      if (d.length >= 10) excludeIndex.add(`ph:${d}`);
    }
    for (const pl of (r.players || [])) {
      if (pl.email) excludeIndex.add(`em:${pl.email.toLowerCase().trim()}`);
      if (pl.phone) { const d = String(pl.phone).replace(/\D/g,'').slice(-10); if (d.length>=10) excludeIndex.add(`ph:${d}`); }
    }
  }

  // ── Build individual map ──────────────────────────────────────────────────────
  // em:key → {name, email, phones[], gradYears: Set, sourceLeagues: Set}
  const individualMap = new Map();
  const phoneToEmailKey = new Map();

  for (const r of sourceResults) {
    const leagueName = db.events[String(r.eventId)]?.name || r.eventName || String(r.eventId);
    const players = r.players?.length ? r.players : null;
    const regGradYears = (r.gradYears || []).filter(y => /^\d{4}$/.test(y));

    const addIndividual = (key, name, phones, gradYears = []) => {
      if (!individualMap.has(key)) {
        individualMap.set(key, {
          name:         name || null,
          email:        key.slice(3),
          phones,
          gradYears:    new Set(gradYears),
          sourceLeagues: new Set([leagueName]),
        });
      } else {
        const entry = individualMap.get(key);
        entry.sourceLeagues.add(leagueName);
        if (!entry.name && name) entry.name = name;
        for (const ph of phones) if (!entry.phones.includes(ph)) entry.phones.push(ph);
        for (const gy of gradYears) entry.gradYears.add(gy);
      }
    };

    if (players) {
      players.forEach((p, idx) => {
        if (!p.email) return;
        const key = `em:${p.email.toLowerCase().trim()}`;
        // gradYear: prefer per-player field, fall back to registration-level list positionally
        const gy = p.gradYear || regGradYears[idx] || null;
        addIndividual(key, p.name || null, p.phone ? [p.phone] : [], gy ? [gy] : []);
        if (p.phone) { const pk = `ph:${p.phone}`; if (!phoneToEmailKey.has(pk)) phoneToEmailKey.set(pk, key); }
      });
    } else {
      const allEmails   = r.emails?.length ? r.emails : (r.email ? [r.email] : []);
      const allPhones   = r.phones?.length ? r.phones : (r.phone ? [r.phone] : []);
      const phonesClean = allPhones.map(p => String(p).replace(/\D/g,'').slice(-10)).filter(d => d.length >= 10);
      allEmails.forEach((e, idx) => {
        const key    = `em:${e.toLowerCase().trim()}`;
        const paired = phonesClean[idx] || null;
        const gy     = regGradYears[idx] || null;
        addIndividual(key, null, paired ? [paired] : [], gy ? [gy] : []);
        if (paired) { const pk = `ph:${paired}`; if (!phoneToEmailKey.has(pk)) phoneToEmailKey.set(pk, key); }
      });
    }
  }

  // ── Filter to lapsed ──────────────────────────────────────────────────────────
  const lapsed = [];
  for (const [key, ind] of individualMap) {
    const inExclude = excludeIndex.has(key) || ind.phones.some(p => excludeIndex.has(`ph:${p}`));
    if (!inExclude) lapsed.push({
      name:          ind.name,
      email:         ind.email,
      phones:        ind.phones,
      gradYears:     [...ind.gradYears].sort(),
      sourceLeagues: [...ind.sourceLeagues],
    });
  }

  // ── Grad-year breakdown of lapsed ─────────────────────────────────────────────
  const gyCount = {};
  for (const p of lapsed) {
    for (const gy of p.gradYears) gyCount[gy] = (gyCount[gy] || 0) + 1;
  }
  const gradYearBreakdown = Object.entries(gyCount)
    .map(([year, count]) => ({ year, count }))
    .sort((a, b) => a.year.localeCompare(b.year));

  // Labels for exclude section
  const excludeLabel = excludeIdSet
    ? [...excludeIdSet].map(id => db.events[id]?.name || id).join(', ')
    : excludeYear;

  res.json({
    sourceYear:        sourceYear || 'custom',
    excludeYear:       excludeIdSet ? null : excludeYear,
    excludeLabel,
    totalIndividuals:  individualMap.size,
    lapsedCount:       lapsed.length,
    lapsed,
    gradYearBreakdown,
  });
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
  const db   = await store.load();

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

// ── YoY day-by-day pace — cumulative registrations by day-of-year ─────────────

app.get('/api/reports/yoy-daily', async (req, res) => {
  const db = await store.load();

  // Classify an event by its name into league / camp / tournament
  function classifyEvent(name = '') {
    const n = name.toLowerCase();
    if (/\btournament\b|\btourney\b/.test(n)) return 'tournament';
    if (/\bcamp\b|\bclinic\b|\bshooting\b|\bscoring\b|\bskills?\b|\btraining\b|\bacademy\b|\bdevelopment\b/.test(n)) return 'camp';
    return 'league';
  }

  // Season year — name first (more reliable for early-opening leagues)
  function seasonYear(eventId, eventName) {
    const ev = db.events[String(eventId)];
    const m = (ev?.name || eventName || '').match(/\b(20\d{2})\b/);
    if (m) return m[1];
    return (ev?.close || ev?.open || '').slice(0, 4) || 'unknown';
  }

  // Day-of-year (1-based) from a YYYY-MM-DD date string
  function dayOfYear(dateStr) {
    if (!dateStr || dateStr.length < 10) return null;
    const [y, m, d] = dateStr.split('-').map(Number);
    const start = Date.UTC(y, 0, 1);
    const cur   = Date.UTC(y, m - 1, d);
    return Math.floor((cur - start) / 86400000) + 1;
  }

  // Reference labels: Jan 1 = day 1, using 2025 (non-leap) as display reference
  function dayLabel(n) {
    const d = new Date(Date.UTC(2025, 0, 1) + (n - 1) * 86400000);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  const TYPES = ['league', 'camp', 'tournament'];

  // Accumulate: year → type → dayOfYear → count
  const acc = {}; // year → { league: {}, camp: {}, tournament: {} }

  for (const r of db.results) {
    if (!r.completed) continue;
    const date = store.toCDTDate(r.created);
    if (!date || date.length < 10) continue;
    const year = seasonYear(r.eventId, r.eventName);
    if (!/^20\d{2}$/.test(year)) continue;
    const type = classifyEvent(r.eventName || '');
    const day  = dayOfYear(date);
    if (!day) continue;

    if (!acc[year]) acc[year] = { league: {}, camp: {}, tournament: {} };
    acc[year][type][day] = (acc[year][type][day] || 0) + 1;
  }

  // Build per-year cumulative arrays
  const byYear = {};
  for (const [year, types] of Object.entries(acc)) {
    // Combined across all types
    const combined = {};
    for (const t of TYPES) {
      for (const [d, n] of Object.entries(types[t])) {
        combined[d] = (combined[d] || 0) + n;
      }
    }
    const maxDay = Math.max(...Object.keys(combined).map(Number), 0);

    let cumAll = 0, cumLeague = 0, cumCamp = 0, cumTournament = 0;
    const cumByDay = [];
    for (let day = 1; day <= maxDay; day++) {
      const all  = combined[day]        || 0;
      const lg   = types.league[day]    || 0;
      const cp   = types.camp[day]      || 0;
      const tn   = types.tournament[day]|| 0;
      cumAll        += all;
      cumLeague     += lg;
      cumCamp       += cp;
      cumTournament += tn;
      if (all > 0 || cumAll > 0) {
        cumByDay.push({
          day, date: dayLabel(day),
          daily: all, dailyLeague: lg, dailyCamp: cp, dailyTournament: tn,
          cum: cumAll, cumLeague, cumCamp, cumTournament,
        });
      }
    }

    byYear[year] = {
      totals: { all: cumAll, league: cumLeague, camp: cumCamp, tournament: cumTournament },
      cumByDay,
    };
  }

  const years = Object.keys(byYear).sort();
  res.json({ byYear, years });
});

// ── YoY retention: "how many 2025 [type] participants came back in 2026?" ──────
// Source = ALL events of a given year+type, deduplicated across events.
// Target = ALL events of a given year (or type).

app.get('/api/reports/yoy-retention', async (req, res) => {
  const { sourceYear, targetYear, sourceType = 'all', targetType = 'all' } = req.query;
  if (!sourceYear || !targetYear) return res.status(400).json({ error: 'sourceYear and targetYear required' });

  const db = await store.load();

  function classifyEvent(name = '') {
    const n = name.toLowerCase();
    if (/\btournament\b|\btourney\b/.test(n)) return 'tournament';
    if (/\bcamp\b|\bclinic\b|\bshooting\b|\bscoring\b|\bskills?\b|\btraining\b|\bacademy\b|\bdevelopment\b/.test(n)) return 'camp';
    return 'league';
  }
  function eventYear(eventId, eventName) {
    const ev = db.events[String(eventId)];
    const m = (ev?.name || eventName || '').match(/\b(20\d{2})\b/);
    if (m) return m[1];
    return (ev?.close || ev?.open || '').slice(0, 4);
  }
  function getKeys(r) {
    const keys = [];
    if (r.profileId) keys.push(`pid:${String(r.profileId)}`);
    const allEmails = r.emails?.length ? r.emails : (r.email ? [r.email] : []);
    for (const e of allEmails) { if (e && e.includes('@')) keys.push(`em:${e.toLowerCase().trim()}`); }
    const allPhones = r.phones?.length ? r.phones : (r.phone ? [r.phone] : []);
    for (const p of allPhones) { const d = String(p).replace(/\D/g, ''); if (d.length >= 10) keys.push(`ph:${d.slice(-10)}`); }
    return keys;
  }

  const matchesType = (name, type) =>
    type === 'all' || classifyEvent(name) === type;

  // Source results: all completed results from sourceYear events of sourceType
  const sourceResults = db.results.filter(r =>
    r.completed &&
    eventYear(r.eventId, r.eventName) === String(sourceYear) &&
    matchesType(r.eventName, sourceType)
  );

  // Build DEDUPLICATED participant index for source.
  // A person in multiple source events counts once.
  const srcIndex  = new Map(); // identifier key → canonical result
  const srcById   = new Map(); // result.id → canonical result (for dedup within source)
  let uniqueSrc   = 0;

  for (const r of sourceResults) {
    const keys = getKeys(r);
    let canonical = null;
    for (const k of keys) { if (srcIndex.has(k)) { canonical = srcIndex.get(k); break; } }
    if (!canonical) {
      canonical = r;
      uniqueSrc++;
    }
    for (const k of keys) { if (!srcIndex.has(k)) srcIndex.set(k, canonical); }
    srcById.set(r.id, canonical);
  }

  // Target results: all completed results from targetYear events of targetType
  const targetResults = db.results.filter(r =>
    r.completed &&
    eventYear(r.eventId, r.eventName) === String(targetYear) &&
    matchesType(r.eventName, targetType)
  );

  // Match target results against source index — bucket by target event
  const bucketMap     = new Map();
  const matchedSrcIds = new Set(); // canonical source result ids

  for (const rT of targetResults) {
    const keys = getKeys(rT);
    let srcCanonical = null;
    for (const k of keys) { if (srcIndex.has(k)) { srcCanonical = srcIndex.get(k); break; } }
    if (!srcCanonical) continue;

    const eid = String(rT.eventId);
    if (!bucketMap.has(eid)) {
      const ev = db.events[eid] || {};
      bucketMap.set(eid, { eventId: eid, eventName: ev.name || rT.eventName, type: classifyEvent(ev.name||rT.eventName), participants: [] });
    }
    const bucket = bucketMap.get(eid);
    if (!bucket.participants.some(p => p.sourceId === srcCanonical.id)) {
      bucket.participants.push({
        sourceId: srcCanonical.id,
        email:    rT.email    || srcCanonical.email    || null,
        phone:    rT.phone    || srcCanonical.phone    || null,
        gradYearPast: srcCanonical.gradYears?.[0] || null,
        gradYearNow:  rT.gradYears?.[0]           || null,
        grade:   rT.grade    || srcCanonical.grade    || null,
        gender:  rT.gender   || srcCanonical.gender   || null,
        city:    rT.city     || srcCanonical.city     || null,
      });
      matchedSrcIds.add(srcCanonical.id);
    }
  }

  const buckets = [...bucketMap.values()]
    .map(b => ({ ...b, count: b.participants.length }))
    .sort((a, b) => b.count - a.count);

  // Revenue: sum from target results for matched participants
  const revenueTotal = targetResults
    .filter(r => { const keys = getKeys(r); return keys.some(k => srcIndex.has(k)); })
    .reduce((s, r) => s + (r.revenue || 0), 0);
  const revenueAll = targetResults.reduce((s, r) => s + (r.revenue || 0), 0);

  // Lapsed: source participants with no match in target
  const lapsed = [...new Set([...srcIndex.values()].map(r => r.id))]
    .filter(id => !matchedSrcIds.has(id))
    .map(id => {
      const r = sourceResults.find(s => s.id === id) || {};
      return { sourceId: id, email: r.email||null, phone: r.phone||null, gradYear: r.gradYears?.[0]||null, grade: r.grade||null, gender: r.gender||null, city: r.city||null };
    });

  res.json({
    sourceYear, targetYear, sourceType, targetType,
    source: { totalResults: sourceResults.length, uniqueParticipants: uniqueSrc },
    returned: { unique: matchedSrcIds.size, pct: uniqueSrc ? Math.round(matchedSrcIds.size/uniqueSrc*100) : 0 },
    lapsed:   { count: lapsed.length, participants: lapsed },
    buckets,
    revenue: { returned: revenueTotal, allTarget: revenueAll, hasData: revenueAll > 0 },
  });
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

// ── Shared helper: filter results from store.json for audience endpoints ────────
function filterStoreResults(db, { eventIds, gradYearFrom, gradYearTo, genders } = {}) {
  const eidSet    = eventIds ? new Set(eventIds.map(String)) : null;
  const genderSet = genders  ? new Set(genders.map(s => s.toLowerCase())) : null;
  return db.results.filter(r => {
    if (eidSet && !eidSet.has(String(r.eventId))) return false;
    if (genderSet) {
      const lc = (r.gender || '').toLowerCase();
      if (![...genderSet].some(g => lc.includes(g))) return false;
    }
    if (gradYearFrom || gradYearTo) {
      const gys = r.gradYears || [];
      const match = gys.some(y => {
        if (gradYearFrom && y < gradYearFrom) return false;
        if (gradYearTo   && y > gradYearTo)   return false;
        return true;
      });
      if (!match) return false;
    }
    return true;
  });
}

// ── Preview — estimate audience size (reads from main store, all player emails) ─
app.get('/api/contacts/preview', async (req, res) => {
  const { eventIds, gradYearFrom, gradYearTo, genders } = req.query;
  const db = await store.load();
  const filtered = filterStoreResults(db, {
    eventIds:     eventIds     ? eventIds.split(',').map(s=>s.trim())  : null,
    gradYearFrom: gradYearFrom || null,
    gradYearTo:   gradYearTo   || null,
    genders:      genders      ? genders.split(',').map(s=>s.trim())   : null,
  });

  // Unique emails — all player emails from emails[] array
  const allEmails = new Set();
  const gyMap = {}, geMap = {};
  for (const r of filtered) {
    const arr = r.emails?.length ? r.emails : (r.email ? [r.email] : []);
    for (const e of arr) if (e) allEmails.add(e.toLowerCase().trim());
    const g = r.gender?.trim(); if (g) geMap[g] = (geMap[g]||0)+1;
    for (const gy of (r.gradYears||[])) {
      if (/^\d{4}$/.test(gy)) gyMap[gy] = (gyMap[gy]||0)+1;
    }
  }
  const toArr = m => Object.entries(m).map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count);
  res.json({
    total:          filtered.length,           // registrations
    withEmail:      filtered.filter(r => r.email || r.emails?.length).length,
    uniqueEmails:   allEmails.size,            // individual player emails
    graduationYear: Object.entries(gyMap).map(([name,count])=>({name,count})).sort((a,b)=>a.name.localeCompare(b.name)),
    gender:         toArr(geMap),
  });
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
      const emails = [...new Set(
        pickAll('email','e-mail','email address','contact email','guardian email','parent email','account email','family email')
          .map(v => String(v).trim().toLowerCase()).filter(v => v.includes('@'))
      )];
      const phones = [...new Set(
        pickAll('phone','mobile','cell','telephone','contact phone','contact number')
          .map(v => String(v).replace(/\D/g,'').slice(-10)).filter(v => v.length >= 10)
      )];
      return {
        email:     emails[0] || '',
        emails,
        phone:     phones[0] || '',
        phones,
        firstName: pick('first name','contact first','parent first','guardian first','fname'),
        lastName:  pick('last name', 'contact last', 'parent last', 'guardian last', 'lname'),
        zip:       pick('zip','postal'),
        city:      pick('city'),
        state:     pick('state/province','state'),
        gender:    pick('gender of team','gender'),
        gradYears: pickAll('graduation year','grad year'),
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

// ── Audience export — reads from main store (all player emails, no API call) ───
app.get('/api/contacts/export', async (req, res) => {
  const { eventIds, gradYearFrom, gradYearTo, genders, label = 'audience' } = req.query;
  const db = await store.load();

  const filtered = filterStoreResults(db, {
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
  const seenEmails = new Set();
  const rows = [];

  for (const r of filtered) {
    const allEmails  = r.emails?.length ? r.emails : (r.email ? [r.email] : []);
    const allPhones  = r.phones?.length ? r.phones : (r.phone ? [r.phone] : []);
    const fn   = (r.firstName||'').replace(/,/g,' ');
    const ln   = (r.lastName ||'').replace(/,/g,' ');
    const zip  = (r.zip      ||'').slice(0,5);
    const cit  = (r.city     ||'').replace(/,/g,' ');
    const st   = r.state     || '';
    const gen  = mapGender(r.gender);
    const gys  = (r.gradYears||[]).filter(y=>(!gradYearFrom||y>=gradYearFrom)&&(!gradYearTo||y<=gradYearTo)).join(';');
    const ev   = (db.events[String(r.eventId)]?.name || r.eventName || '').replace(/,/g,' ');

    // One row per unique player email — pair positionally with phones[] when possible
    allEmails.forEach((email, idx) => {
      const em = (email || '').toLowerCase().trim();
      if (!em || seenEmails.has(em)) return;
      seenEmails.add(em);
      const ph = allPhones[idx] || allPhones[0] || '';
      rows.push([em, ph, fn, ln, zip, cit, st, 'US', gen, gys, ev].join(','));
    });

    // Registration with no emails — still include one row with phone/name for completeness
    if (!allEmails.some(e => e)) {
      const ph = allPhones[0] || r.phone || '';
      rows.push(['', ph, fn, ln, zip, cit, st, 'US', gen, gys, ev].join(','));
    }
  }

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
