require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const axios      = require('axios');
const fs         = require('fs');
const path       = require('path');
const NodeCache  = require('node-cache');
const rateLimit  = require('express-rate-limit');
const store        = require('./store');
const blobStorage  = require('./blobStorage');
const userStore    = require('./userStore');
const auth         = require('./auth');
const { localPrefsLoad, localPrefsSave, kvGet, kvSet, kvGetCached, appendCapped, chatLog, chatLogRecent } = require('./kv');

// Aggregator only used for local SSE-based flow; on Vercel we use client-driven endpoints
let aggregator = null;
try { aggregator = require('./aggregator'); } catch {}

const convexSync = require('./convexSync');

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
// Flush the Convex usage meter into a daily KV bucket at most once a minute
// (kvGet/kvSet and maybeFlushUsage are declared later — hoisted functions).
app.use((req, res, next) => { res.on('finish', () => { try { maybeFlushUsage(); } catch {} }); next(); });
// Stripe webhooks are signature-verified over the RAW body — keep it unparsed
const jsonParser = express.json({ limit: '10mb' });
const rawParser = express.raw({ type: '*/*', limit: '1mb' });
app.use((req, res, next) =>
  req.path === '/api/billing/webhook' ? rawParser(req, res, next) : jsonParser(req, res, next));
app.use(rateLimit({
  windowMs: 60000,
  max: 200,
  validate: { xForwardedForHeader: false, forwardedHeader: false },
}));

// ── Auth ───────────────────────────────────────────────────────────────────────
// Custom username/password login. Accounts are created by an admin (via the
// Users page or the bootstrap script) — there is no public signup.
//
// Every /api/* route requires a valid session EXCEPT the ones listed here.
// SSE endpoints (EventSource can't send custom headers) accept the token via
// a `?token=` query parameter as a fallback — see auth.requireAuth.
const PUBLIC_API_PATHS = new Set([
  '/api/auth/login', '/api/health', '/api/runtime',
  '/api/auth/google', '/api/auth/google/callback',
  '/api/site-settings',   // landing page content (GET only — PUT re-runs auth below)
  '/api/billing/webhook', // Stripe signs its own requests; no app JWT
  '/api/messenger/webhook', // Meta verifies with hub.verify_token; replies keyed by page token
  '/api/cron/minute',       // guarded by CRON_SECRET header check inside
  '/api/signup',            // public self-serve registration
  '/api/signup/availability', // landing page checks whether trial slots remain
  '/api/assistant/chat',      // site chat widget (gated by per-org widget key)
  '/api/widget.js',           // the embeddable chat widget script itself
  '/api/cron/daily',          // Vercel cron (gated by CRON_SECRET when set)
]);
app.use((req, res, next) => {
  // /api/webhooks/* is public by prefix — SE signs nothing (we gate with a key
  // in query/path/header) and every delivery is recorded for inspection.
  if (!req.path.startsWith('/api/') || PUBLIC_API_PATHS.has(req.path) || req.path.startsWith('/api/webhooks/')) return next();
  return auth.requireAuth(req, res, next);
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  try {
    const user = await userStore.findByUsername(username);
    if (!user || !(await auth.verifyPassword(password, user.passwordHash))) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    await userStore.recordLogin(user.id);
    const token = auth.signToken(user);
    res.json({ token, user: userStore.publicView(user) });
  } catch (err) {
    res.status(500).json({ error: 'Login failed: ' + err.message });
  }
});

app.get('/api/auth/me', async (req, res) => {
  const user = await userStore.findById(req.user.id);
  if (!user) return res.status(401).json({ error: 'Account no longer exists' });
  res.json({ user: userStore.publicView(user) });
});

// ── Sign in with Google ────────────────────────────────────────────────────────
//
// GET /api/auth/google           → redirect to Google's consent screen
// GET /api/auth/google/callback  → exchange code, find-or-provision user, issue
//                                  the app JWT, redirect to the SPA with #gtoken=
//
// Access policy: SUPER_ADMIN_EMAIL is auto-provisioned as role 'superadmin'.
// Any other Google account must match the email of an existing user (added via
// the Users page) — no open signup.

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const SUPER_ADMIN_EMAIL    = (process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();

// Where the API lives (must match a redirect URI registered on the OAuth client)
// and where the SPA lives (where we send the browser back with the token).
function googleUrls(req) {
  const onVercel = process.env.VERCEL === '1';
  const apiOrigin    = onVercel ? `https://${req.headers['x-forwarded-host'] || req.headers.host}` : 'http://localhost:3001';
  const clientOrigin = onVercel ? apiOrigin : (process.env.CLIENT_ORIGIN || 'http://localhost:5173');
  return { redirectUri: `${apiOrigin}/api/auth/google/callback`, clientOrigin };
}

app.get('/api/auth/google', (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(503).json({ error: 'Google sign-in is not configured' });
  }
  const { redirectUri } = googleUrls(req);
  // Signed short-lived state to reject forged callbacks. It also carries the
  // SPA origin the user actually came from (dev servers hop ports: Vite picks
  // 5174+ when 5173 is busy) so the callback returns to a live page instead
  // of a hardcoded port. Only localhost origins are honored — see callback.
  let from = '';
  try { from = new URL(req.headers.referer).origin; } catch {}
  const state = auth.signToken({ id: 'oauth-state', username: from || 'state', role: 'state' });
  const params = new URLSearchParams({
    client_id:     GOOGLE_CLIENT_ID,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope:         'openid email profile',
    prompt:        'select_account',
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  const { redirectUri, clientOrigin: defaultOrigin } = googleUrls(req);

  // Prefer the origin recorded when the flow started — but never off-host:
  // localhost-only in dev, ignored entirely on Vercel (no open redirects).
  let clientOrigin = defaultOrigin;
  let statePayload = null;
  try { statePayload = auth.verifyToken(String(state || '')); } catch {}
  if (process.env.VERCEL !== '1' && /^http:\/\/localhost:\d+$/.test(statePayload?.username || '')) {
    clientOrigin = statePayload.username;
  }
  const fail = (msg) => res.redirect(`${clientOrigin}/login?gerror=${encodeURIComponent(msg)}`);

  if (error) return fail(String(error));
  if (!code)  return fail('Missing authorization code');
  if (!statePayload) return fail('Invalid sign-in state — try again');

  try {
    // Exchange the code for tokens
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
      code:          String(code),
      client_id:     GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code',
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

    // id_token is a JWT signed by Google; we just received it over TLS directly
    // from Google's token endpoint, so decoding the payload is sufficient here.
    const idToken = tokenRes.data.id_token;
    const claims  = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    const email   = String(claims.email || '').trim().toLowerCase();
    const name    = String(claims.name || email.split('@')[0]);
    if (!email || claims.email_verified === false) return fail('Google account has no verified email');

    // Find or provision the user
    let user = await userStore.findByEmail(email);
    if (!user && email === SUPER_ADMIN_EMAIL) {
      // First-ever platform-owner sign-in — provision the account
      const randomPw = await auth.hashPassword(require('crypto').randomUUID());
      user = await userStore.create({
        username: name || 'Owner',
        passwordHash: randomPw,
        role: 'owner',
        email, provider: 'google',
      });
      user = await userStore.findByEmail(email); // re-read with internal id
    } else if (user && email === SUPER_ADMIN_EMAIL && user.role !== 'owner') {
      await userStore.update(user.id, { role: 'owner' });
      user = await userStore.findByEmail(email);
    }
    if (!user) return fail('No account for this Google email — ask the admin to add you');

    await userStore.recordLogin(user.id);
    const token = auth.signToken(user);
    // Hash fragment keeps the token out of server/proxy logs
    res.redirect(`${clientOrigin}/login#gtoken=${encodeURIComponent(token)}`);
  } catch (err) {
    const detail = err.response?.data?.error_description || err.response?.data?.error || err.message;
    fail(`Google sign-in failed: ${detail}`);
  }
});

// ── User management (admin only) ──────────────────────────────────────────────

app.get('/api/users', auth.requireAdmin, async (req, res) => {
  res.json({ users: await userStore.list() });
});

app.post('/api/users', auth.requireAdmin, async (req, res) => {
  const { username, password, role, email, accountKey } = req.body || {};
  if (!username || !password || !role) {
    return res.status(400).json({ error: 'username, password, and role are required' });
  }
  if (!['admin', 'editor', 'superadmin', 'owner'].includes(role)) {
    return res.status(400).json({ error: 'role must be "admin", "editor", "superadmin", or "owner"' });
  }
  // Only the Owner can mint platform roles
  if (['superadmin', 'owner'].includes(role) && req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Only the Owner can create Super Admin or Owner accounts' });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  try {
    const passwordHash = await auth.hashPassword(password);
    const user = await userStore.create({ username, passwordHash, role, email: email || undefined, accountKey: accountKey || undefined });
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/users/:id', auth.requireAdmin, async (req, res) => {
  const { role, password, email, accountKey } = req.body || {};
  const patch = {};
  if (role !== undefined) {
    if (!['admin', 'editor', 'superadmin', 'owner'].includes(role)) {
      return res.status(400).json({ error: 'role must be "admin", "editor", "superadmin", or "owner"' });
    }
    if (['superadmin', 'owner'].includes(role) && req.user.role !== 'owner') {
      return res.status(403).json({ error: 'Only the Owner can grant Super Admin or Owner roles' });
    }
    patch.role = role;
  }
  if (accountKey !== undefined) {
    patch.accountKey = String(accountKey || '') || undefined; // link user to a company
  }
  if (password !== undefined) {
    if (String(password).length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    patch.passwordHash = await auth.hashPassword(password);
  }
  if (email !== undefined) {
    // Email enables Google sign-in for this account
    patch.email = String(email).trim().toLowerCase() || undefined;
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'Nothing to update — provide role, password, and/or email' });
  }
  try {
    const user = await userStore.update(req.params.id, patch);
    res.json({ user });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.delete('/api/users/:id', auth.requireAdmin, async (req, res) => {
  // Super admins can do everything EXCEPT delete
  if (req.user.role === 'superadmin') {
    return res.status(403).json({ error: 'Super Admins cannot delete — ask the Owner' });
  }
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete your own account' });
  }
  // Nobody below Owner can delete platform-role accounts
  const target = await userStore.findById(req.params.id);
  if (target && ['owner', 'superadmin'].includes(target.role) && req.user.role !== 'owner') {
    return res.status(403).json({ error: 'Only the Owner can delete platform accounts' });
  }
  try {
    await userStore.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

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
  let knownTotal = null; // resultsTotal from first response (all registrations, not just completed)

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
    if (knownTotal === null) knownTotal = reg.resultsTotal ?? null;
    allResults = allResults.concat(batch);

    if (logFn) {
      const totalLabel = knownTotal != null ? `/${knownTotal}` : '';
      const estPages   = knownTotal != null ? Math.ceil(knownTotal / PER_PAGE) : '?';
      logFn(`  ← page ${page}/${estPages}: +${batch.length} results (${allResults.length}${totalLabel} fetched)`, 'response');
    }

    if (batch.length < PER_PAGE) break;
    if (knownTotal !== null && allResults.length >= knownTotal) break;
    page++;
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

// Some SE registration forms mislabel the email field (seen as "Middle Name"
// on several Midwest 3on3 form templates) — when keyword matching finds no
// email, fall back to scanning all answers for a value shaped like one.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function findEmailFallback(answers) {
  for (const a of (answers || [])) {
    const v = resolveAnswerVal(a);
    if (v && EMAIL_RE.test(String(v).trim())) return String(v).trim().toLowerCase();
  }
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
      storeResults:  db._convex ? db.meta.totalResults : db.results.length,
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
  const stored = store.IS_CONVEX
    ? await store.convexQuery('reports:resultsByEvent', { eventId: String(registrationId) })
    : db.results.filter(r => String(r.eventId) === String(registrationId));
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
    const toArr = m =>
      Object.entries(m).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

    // Per-event team counts and the all-time total can be derived directly from
    // db.events (resultsCompleted) — already loaded, no results scan needed.
    const registrationSummary = Object.values(db.events)
      .filter(e => (e.resultsCompleted || 0) > 0)
      .map(e => ({ id: String(e.id), name: e.name, teams: e.resultsCompleted || 0 }))
      .sort((a, b) => b.teams - a.teams);
    const totalTeams = registrationSummary.reduce((s, e) => s + e.teams, 0);

    let gradYearData, genderData, stateData, cityData, zipData;

    if (store.IS_CONVEX) {
      const [gradYears, demo] = await Promise.all([
        store.convexQuery('reports:reportGradYears', {}),
        store.convexQuery('reports:reportDemographics', {}),
      ]);
      gradYearData = gradYears;
      genderData   = demo.gender;
      stateData    = demo.state;
      cityData     = demo.city;
      zipData      = demo.zip;
    } else {
      const gradYearMap = {}, genderMap = {}, stateMap = {}, cityMap = {}, zipMap = {};
      for (const r of db.results) {
        if (!r.completed) continue;
        for (const gy of (r.gradYears || [])) {
          if (/^\d{4}$/.test(gy)) gradYearMap[gy] = (gradYearMap[gy] || 0) + 1;
        }
        if (r.gender) genderMap[r.gender] = (genderMap[r.gender] || 0) + 1;
        const st = r.state?.trim(); if (st) stateMap[st] = (stateMap[st] || 0) + 1;
        const ci = r.city?.trim();  if (ci) cityMap[ci]  = (cityMap[ci]  || 0) + 1;
        if (r.zip) { const z = String(r.zip).slice(0,5); zipMap[z] = (zipMap[z] || 0) + 1; }
      }
      gradYearData = toArr(gradYearMap);
      genderData   = toArr(genderMap);
      stateData    = toArr(stateMap);
      cityData     = toArr(cityMap).slice(0, 50);
      zipData      = toArr(zipMap).slice(0, 100);
    }

    if (gradYearFilter) {
      const years = gradYearFilter.split(',').map(s => s.trim());
      gradYearData = gradYearData.filter(d => years.includes(d.name));
    }

    res.json({
      registrationsAnalyzed: registrationSummary.length,
      registrationSummary,
      total: totalTeams,
      graduationYear: gradYearData,
      gender:   genderData,
      state:    stateData,
      city:     cityData,
      zip:      zipData,
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
    meta:          db.meta,
    totalResults:  db._convex ? db.meta.totalResults : db.results.length,
    totalEvents:   eventList.length,
    closedFetched: closed,
    openFetched:   open,
    pending,
    aggregator:    aggregator.getState(),
  });
});

// ── Purge + reload a single event — SSE stream ────────────────────────────────
// Client connects via EventSource; server streams live log lines then fires
// a 'complete' or 'error' event when done.

app.get('/api/store/purge-reload-stream', auth.requireAdmin, async (req, res) => {
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
    // On Vercel+Convex: also purge results from Convex (local purge is no-op when results=[])
    if (store.IS_CONVEX) {
      await convexSync.purgeEventResults(String(eventId));
    }
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
    if (!db._convex) db.meta.totalResults = db.results.length;
    await store.save(db);

    log(`  ✓ Saved ${added} new results`, 'ok');
    log(`  ✓ Total results in store  : ${db._convex ? db.meta.totalResults : db.results.length}`, 'ok');
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

app.post('/api/store/purge', auth.requireAdmin, async (req, res) => {
  const { eventId } = req.body || {};
  if (!eventId) return res.status(400).json({ error: 'eventId required' });
  const db = await store.load();
  const eventName    = db.events[eventId]?.name || eventId;
  const deletedCount = store.purgeEvent(db, eventId);
  if (store.IS_CONVEX) {
    await convexSync.purgeEventResults(String(eventId));
  }
  await store.save(db);
  cache.keys().filter(k =>
    k.includes(eventId) || k.startsWith('analytics_agg_') || k.startsWith('regs_all_')
  ).forEach(k => cache.del(k));
  res.json({ eventId, eventName, deleted: deletedCount, totalInStore: db._convex ? db.meta.totalResults : db.results.length });
});

// ── List events currently in store (for the data-management UI) ───────────────

app.get('/api/store/events', async (req, res) => {
  const db = await store.load();

  let events, totalResults;
  if (store.IS_CONVEX) {
    // db.results is always [] in Convex mode — use db.events which has full metadata
    events = Object.values(db.events).map(ev => ({
      id:               ev.id,
      name:             ev.name,
      count:            ev.resultCount    ?? 0,
      meta:             ev,
      resultsCompleted: ev.resultsCompleted ?? null,
      fetchedAt:        ev.fetchedAt        ?? null,
    })).sort((a, b) => (b.fetchedAt || '').localeCompare(a.fetchedAt || ''));
    totalResults = db.meta.totalResults ?? 0;
  } else {
    const byEvent = {};
    for (const r of db.results) {
      if (!byEvent[r.eventId]) byEvent[r.eventId] = { id: r.eventId, name: r.eventName, count: 0 };
      byEvent[r.eventId].count++;
    }
    events = Object.values(byEvent).map(ev => {
      const meta = db.events[ev.id] || {};
      return {
        ...ev,
        meta,
        resultsCompleted: meta.resultsCompleted ?? null,
        fetchedAt:        meta.fetchedAt        ?? null,
      };
    }).sort((a, b) => (b.fetchedAt || '').localeCompare(a.fetchedAt || ''));
    totalResults = db.results.length;
  }
  res.json({ events, totalResults });
});

// ── SSE — aggregation progress stream ─────────────────────────────────────────

// ── Legacy SSE stream (local dev only — Vercel uses client-driven fetch-event) ─

app.get('/api/aggregate/stream', auth.requireRole('admin', 'editor'), async (req, res) => {
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

app.post('/api/aggregate/start', auth.requireRole('admin', 'editor'), async (req, res) => {
  if (process.env.VERCEL === '1' || !aggregator) {
    return res.json({ started: false, message: 'Use /api/aggregate/plan + /api/aggregate/fetch-event on Vercel' });
  }
  const { orgId = '8008', delayMs = 1200, events = [], purgeFirst = false } = req.body || {};
  if (purgeFirst && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can purge data before re-fetching' });
  }
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

app.get('/api/aggregate/plan', auth.requireRole('admin', 'editor'), async (req, res) => {
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
app.post('/api/aggregate/fetch-event', auth.requireRole('admin', 'editor'), async (req, res) => {
  const {
    orgId = '8008', eventId, eventName, eventStatus,
    resultsCompleted: currentCompleted = 0,
    purgeFirst = false,
    backfill  = false,     // re-fetch all pages and merge new fields into existing records (no purge)
    page: requestedPage,   // undefined/null = first call; number = continuation
    prevCompact = [],      // compact results from earlier pages (client carries them)
  } = req.body || {};
  if (!eventId) return res.status(400).json({ error: 'eventId required' });
  if (purgeFirst && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can purge data before re-fetching' });
  }

  const isFirstCall = requestedPage == null;

  try {
    const db = await store.load();

    // Purge is disabled on Vercel — only allowed in local dev
    if (isFirstCall && purgeFirst && process.env.VERCEL !== '1') store.purgeEvent(db, String(eventId));

    const storedEvent     = db.events[String(eventId)];
    const storedCompleted = storedEvent?.resultsCompleted ?? null;
    const storedCount     = storedEvent?.resultCount     || 0;

    // Skip when count unchanged — but never skip in backfill or purge mode, and
    // never skip if the store is behind what the API already reported (e.g. a
    // prior fetch attempt was interrupted) — otherwise the gap never closes.
    if (isFirstCall && !purgeFirst && !backfill && storedCompleted !== null && currentCompleted === storedCompleted && storedCount >= currentCompleted) {
      return res.json({ added: 0, skipped: true, reason: 'count_unchanged', eventId });
    }

    const PER_PAGE = 25;
    const isConvex = store.IS_CONVEX;
    // In Convex mode the incremental page-offset optimization is UNSAFE: db.results is
    // always [] so we can't recompute an accurate storedCount, and an inflated/stale
    // count makes the fetch start beyond the real data and silently miss rows (this is
    // what left events like Chanhassen permanently 7 rows short). Convex dedups by seId
    // on save, so re-fetching from page 1 every time is idempotent and never misses.
    const fetchPage = isFirstCall
      ? ((!isConvex && !purgeFirst && !backfill && storedCompleted !== null && currentCompleted > storedCompleted && storedCount > 0)
          ? Math.max(1, Math.floor(storedCount / PER_PAGE))
          : 1)
      : requestedPage;

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

    const d = await graphql(ANSWERS_Q, { regId: String(eventId), orgId: parseInt(orgId), page: fetchPage, perPage: PER_PAGE });
    const r = d?.data?.registration;
    if (!r) return res.json({ added: 0, fetched: 0, hasMore: false, page: fetchPage, skipped: false, eventId });

    const batch   = r.registrationResults || [];
    const hasMore = batch.length >= PER_PAGE;

    const evObj     = { id: String(eventId), name: eventName || r.name || String(eventId), status: eventStatus ?? 2 };
    const thisPage  = batch.map(row => {
      const parsed = extractAnswers(row.answers || []);
      return { id: row.id, profileId: row.profileId || null, eventId: String(eventId), eventName: evObj.name, created: row.created || null, completed: row.completed, revenue: null, ...parsed };
    });
    const allCompact = [...(prevCompact || []), ...thisPage];

    if (!hasMore) {
      // Final page — commit everything to blob (1 write per event, not per page)
      const inMemAdded = store.upsertResults(db, String(eventId), evObj.name, allCompact, { merge: backfill });

      // In Convex mode we always fetch from page 1, so allCompact holds EVERY row for
      // this event — its length is the true row count and its completed subset is the
      // true completed count. Basing the stored metadata on what we actually fetched
      // (not on SE's claimed resultsCompleted) means a short/partial store self-heals on
      // the next run instead of being permanently marked "synced" while rows are missing.
      const completedInFetch = allCompact.filter(x => x.completed).length;
      const trueTotal = isConvex ? allCompact.length : (storedCount + inMemAdded);
      store.upsertEventMeta(db, evObj, {
        fetchedAt:        new Date().toISOString(),
        resultCount:      trueTotal,
        resultsCompleted: isConvex ? completedInFetch : (r.resultsCompleted ?? currentCompleted),
      });
      const saveRes = await store.save(db);
      cache.del('analytics_agg');

      // Report the actual number of newly-inserted rows. In Convex mode upsertResults
      // over-counts (db.results is empty so every fetched row looks "new"); the real
      // insert count comes from batchUpsertResults' dedup on save.
      const added = isConvex ? (saveRes?.inserted ?? 0) : inMemAdded;

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
    res.status(500).json({ error: err.message, detail: err.response?.data, eventId });
  }
});

// ── Reports: daily stats ───────────────────────────────────────────────────────

app.get('/api/reports/daily', async (req, res) => {
  const { fromDate, toDate, eventId } = req.query;
  const db = await store.load();

  const eventMap = {};
  for (const e of Object.values(db.events)) eventMap[e.id] = e.name;

  if (store.IS_CONVEX) {
    const daily = await store.convexQuery('reports:reportDaily', {
      fromDate: fromDate || undefined,
      toDate: toDate || undefined,
      eventId: eventId || undefined,
    });
    return res.json({ daily, eventMap, totalResults: db.meta.totalResults, meta: db.meta });
  }

  const daily = store.dailyStats(db, { fromDate, toDate, eventId });
  res.json({ daily, eventMap, totalResults: db.results.length, meta: db.meta });
});

// ── Reports: grad-year stats (from store) ─────────────────────────────────────

app.get('/api/reports/grad-years', async (req, res) => {
  const { fromDate, toDate, eventId } = req.query;
  const db = await store.load();

  if (store.IS_CONVEX) {
    const gradYears = await store.convexQuery('reports:reportGradYears', {
      fromDate: fromDate || undefined,
      toDate: toDate || undefined,
      eventId: eventId || undefined,
    });
    return res.json({ gradYears, totalResults: db.meta.totalResults });
  }

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

  if (store.IS_CONVEX) {
    // In Convex mode, build event list from db.events (already loaded).
    // resultCount is pre-stored per event; date filtering not applied.
    const list = Object.values(db.events)
      .filter(e => (e.resultCount || 0) > 0)
      .map(e => ({
        id: e.id,
        name: e.name,
        count: e.resultCount || 0,
        status: e.status ?? null,
        gradYears: [],
      }))
      .sort((a, b) => b.count - a.count);
    return res.json({ events: list, totalResults: db.meta.totalResults, meta: db.meta });
  }

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

  if (store.IS_CONVEX) {
    const stats = await store.convexQuery('reports:reportRecent', {});
    return res.json({ ...stats, meta: db.meta });
  }

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

  if (store.IS_CONVEX) {
    // Pre-computed daily totals + an indexed range scan for just this date's
    // results (bounded — one day's registrations, not all 30k)
    const data = await store.convexQuery('reports:reportDailyActivity', { date });
    for (const s of data.dailyStats) dayTotals[s.date] = s.count;
    for (const r of data.dayResults) {
      if (!leagueMap[r.eventId]) {
        leagueMap[r.eventId] = { id: r.eventId, name: r.eventName, count: 0, gradYears: {} };
      }
      leagueMap[r.eventId].count++;
      for (const gy of (r.gradYears || [])) {
        if (/^\d{4}$/.test(gy))
          leagueMap[r.eventId].gradYears[gy] = (leagueMap[r.eventId].gradYears[gy] || 0) + 1;
      }
    }
  } else {
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

  // Group by event (using each event's resultsCompleted as its team count) —
  // avoids scanning all results, which Convex mode doesn't load into memory.
  // normalizedName → { baseName, eventsByYear: { year: { id, name, count } } }
  const groups = {};

  for (const ev of Object.values(db.events)) {
    const count = ev.resultsCompleted || 0;
    if (count <= 0) continue;
    const norm = normalizeName(ev.name);
    const year = seasonYear(ev.id, ev.name);

    if (!groups[norm]) {
      // Use the shortest/cleanest version of the name as display name
      const base = (ev.name || '').replace(/\s+(20\d{2})\s*$/, '').trim();
      groups[norm] = { baseName: base, years: {} };
    }

    if (!groups[norm].years[year]) {
      groups[norm].years[year] = { id: ev.id, name: ev.name, count: 0 };
    }
    groups[norm].years[year].count += count;
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

  if (store.IS_CONVEX) {
    const rows = await store.convexQuery('reports:reportYoyDaily', {});
    for (const { year, type, day, count } of rows) {
      if (!/^20\d{2}$/.test(year) || !TYPES.includes(type) || !day) continue;
      if (!acc[year]) acc[year] = { league: {}, camp: {}, tournament: {} };
      acc[year][type][day] = (acc[year][type][day] || 0) + count;
    }
  } else {
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

  if (store.IS_CONVEX) {
    // db.events is fully synced (small table) — use it to find the bounded
    // list of event ids for source/target years+types, then let Convex do
    // the per-event indexed scans (avoids reading all 30k results).
    const sourceEventIds = Object.entries(db.events)
      .filter(([eid, ev]) => eventYear(eid, ev.name) === String(sourceYear) && matchesType(ev.name, sourceType))
      .map(([eid]) => eid);
    const targetEventIds = Object.entries(db.events)
      .filter(([eid, ev]) => eventYear(eid, ev.name) === String(targetYear) && matchesType(ev.name, targetType))
      .map(([eid]) => eid);

    const result = await store.convexQuery('reports:yoyRetention', { sourceEventIds, targetEventIds });

    const buckets = result.buckets.map(b => {
      const ev = db.events[b.eventId] || {};
      return { ...b, eventName: ev.name || b.eventName, type: classifyEvent(ev.name || b.eventName) };
    });
    const uniqueSrc = result.source.uniqueParticipants;

    return res.json({
      sourceYear, targetYear, sourceType, targetType,
      source: result.source,
      returned: { unique: result.returned.unique, pct: uniqueSrc ? Math.round(result.returned.unique / uniqueSrc * 100) : 0 },
      lapsed: result.lapsed,
      buckets,
      revenue: { returned: result.revenue.returned, allTarget: result.revenue.allTarget, hasData: result.revenue.allTarget > 0 },
    });
  }

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

app.post('/api/exports', auth.requireRole('admin', 'editor'), async (req, res) => {
  const meta = req.body;
  if (!meta?.eventId) return res.status(400).json({ error: 'eventId required' });
  const list = await loadExportsMeta();
  const id   = Math.random().toString(36).slice(2) + Date.now().toString(36);
  list.unshift({ id, createdAt: new Date().toISOString(), ...meta });
  // Keep at most 200 records total
  await saveExportsMeta(list.slice(0, 200));
  res.json({ id });
});

app.delete('/api/exports/:id', auth.requireAdmin, async (req, res) => {
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

app.get('/api/export/league-csv-stream', auth.requireRole('admin', 'editor'), async (req, res) => {
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
        email:      pick('email','contact email','guardian email','parent email','account email','e-mail','family email') || findEmailFallback(ans),
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
app.delete('/api/export/league-csv/:token', auth.requireAdmin, async (req, res) => {
  const { token } = req.params;
  await blobStorage.deleteFile(`exports/${token}.csv`);
  exportCache.delete(token);
  const list = (await loadExportsMeta()).filter(e => e.id !== token);
  await saveExportsMeta(list);
  res.json({ ok: true });
});

// ── Shared helper: filter results from store.json for audience endpoints ────────
// Convex mode never loads the 30k-row results table into store.load() (it's
// stubbed to [] there, by design — see store.js). Contacts/audience endpoints
// need real rows though, so pull them per-event via the already-deployed
// indexed query. When no eventIds filter is given ("all leagues" mode, the
// UI's default), fall back to every event the store knows has results.
async function loadContactResults(db, eventIds) {
  if (!store.IS_CONVEX) return db.results;
  let ids = eventIds && eventIds.length ? eventIds.map(String) : null;
  if (!ids) ids = Object.values(db.events).filter(e => (e.resultCount || 0) > 0).map(e => String(e.id));
  const all = [];
  const CONCURRENCY = 8;
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batches = await Promise.all(
      ids.slice(i, i + CONCURRENCY).map(eid => store.convexQuery('reports:resultsByEvent', { eventId: eid }).catch(() => []))
    );
    for (const rows of batches) all.push(...rows);
  }
  return all;
}

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
  const idList = eventIds ? eventIds.split(',').map(s => s.trim()) : null;
  db.results = await loadContactResults(db, idList);
  const filtered = filterStoreResults(db, {
    eventIds:     idList,
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



// ── Audience export — reads from main store (all player emails, no API call) ───
app.get('/api/contacts/export', async (req, res) => {
  const { eventIds, gradYearFrom, gradYearTo, genders, label = 'audience' } = req.query;
  const db = await store.load();
  const idList = eventIds ? eventIds.split(',').map(s => s.trim()) : null;
  db.results = await loadContactResults(db, idList);

  const filtered = filterStoreResults(db, {
    eventIds:     idList,
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

  // All Midwest 3on3 registrants are US-based — Facebook Custom Audience
  // phone matching needs a country code, so normalize every number to
  // E.164 (+1XXXXXXXXXX). Without this, raw 10-digit numbers from SE never
  // match FB's hashed phone lookups for some contacts.
  function fmtPhone(p) {
    if (!p) return '';
    let digits = String(p).replace(/\D/g, '');
    if (digits.length === 13 && digits.startsWith('001')) digits = digits.slice(2); // "001" intl prefix
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return digits ? `+${digits}` : '';
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
      const ph = fmtPhone(allPhones[idx] || allPhones[0]);
      rows.push([em, ph, fn, ln, zip, cit, st, 'US', gen, gys, ev].join(','));
    });

    // Registration with no emails — still include a row, but only if there's a
    // phone to match on. Facebook rejects rows with zero identifiers (no email
    // AND no phone), so a row with neither would break the whole import.
    if (!allEmails.some(e => e)) {
      const ph = fmtPhone(allPhones[0] || r.phone);
      if (ph) rows.push(['', ph, fn, ln, zip, cit, st, 'US', gen, gys, ev].join(','));
    }
  }

  const csv = [header, ...rows].join('\r\n');
  res.setHeader('Content-Type',        'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="fb_audience_${slug}_${date}.csv"`);
  res.send(csv);
});

// ── Clear cache ────────────────────────────────────────────────────────────────

app.post('/api/cache/clear', auth.requireRole('admin', 'editor'), async (req, res) => {
  cache.flushAll();
  tokenCache = { token: null, expiresAt: 0 };
  res.json({ message: 'Cache cleared' });
});

// ── Per-user UI preferences (dashboard slots etc.) ────────────────────────────
// Convex-backed in production so selections survive devices/browsers; a local
// JSON file in dev. Value is an opaque JSON string owned by the client.
const PREF_KEY_RE = /^[a-z0-9_-]{1,64}$/i;

app.get('/api/prefs/:key', async (req, res) => {
  const { key } = req.params;
  if (!PREF_KEY_RE.test(key)) return res.status(400).json({ error: 'bad key' });
  try {
    if (store.IS_CONVEX) {
      const value = await store.convexQuery('prefs:getPref', { userId: String(req.user.id), key });
      return res.json({ key, value: value ?? null });
    }
    const all = localPrefsLoad();
    res.json({ key, value: all[`${req.user.id}:${key}`] ?? null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/prefs/:key', async (req, res) => {
  const { key } = req.params;
  if (!PREF_KEY_RE.test(key)) return res.status(400).json({ error: 'bad key' });
  const value = typeof req.body?.value === 'string' ? req.body.value : JSON.stringify(req.body?.value ?? null);
  if (value.length > 20000) return res.status(413).json({ error: 'value too large' });
  try {
    if (store.IS_CONVEX) {
      await store.convexMutation('prefs:setPref', { userId: String(req.user.id), key, value });
      return res.json({ ok: true });
    }
    const all = localPrefsLoad();
    all[`${req.user.id}:${key}`] = value;
    localPrefsSave(all);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Site settings (landing page content) + organizations registry ─────────────
// GET is public (the landing page renders pre-login); writes are superadmin.

const SITE_SETTINGS_FILE = path.join(__dirname, 'data', 'site-settings.json');
const ORGS_FILE          = path.join(__dirname, 'data', 'orgs.json');
function localJsonLoad(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function localJsonSave(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

const DEFAULT_SITE_SETTINGS = {
  appName: 'Data Explorer for SportsEngine',
  tagline: "Registration analytics, year-over-year insights, Facebook audiences — and the real Meta conversion tracking SportsEngine won't let you have.",
  betaBanner: 'We are in beta right now — lock in the discounted rate.',
  priceMonthly: 100,
  betaPriceMonthly: 30,
  features: [
      {
          "icon": "📡",
          "title": "Real Meta Conversion Signal",
          "desc": "SportsEngine checkout can't run a pixel or GTM — we forward every registration to Meta's Conversions API server-side, hashed exactly how Meta wants. Your ads finally learn who actually registers."
      },
      {
          "icon": "📊",
          "title": "Live Registration Dashboard",
          "desc": "Day-by-day activity, week trends, and league breakdowns at a glance — on desktop and phone."
      },
      {
          "icon": "📈",
          "title": "Year-over-Year Comparisons",
          "desc": "Pit any league against last season with cumulative pace charts, deadline markers, and same-day deltas."
      },
      {
          "icon": "📱",
          "title": "Ads Manager Built for Phones",
          "desc": "Campaigns → ad sets → ads with spend, results and cost-per-result — the drill-down Meta's mobile app makes painful."
      },
      {
          "icon": "🎯",
          "title": "Facebook Custom Audiences",
          "desc": "Build filtered, dedup-ed audience CSVs (emails + E.164 phones) ready for Meta import."
      },
      {
          "icon": "⚡",
          "title": "Smart Update Sync",
          "desc": "One click pulls only what changed from SportsEngine — no manual exports."
      },
      {
          "icon": "⏰",
          "title": "Deadline Intelligence",
          "desc": "Early-bird and final registration deadlines from your website, marked on every pace chart — see the deadline rush coming."
      },
      {
          "icon": "🔁",
          "title": "Lapsed Player Detection",
          "desc": "Find every past participant who has not re-registered — with contact details."
      },
      {
          "icon": "🎥",
          "title": "Demo / Stream Mode",
          "desc": "Mask sensitive data instantly for screen shares and client demos."
      }
  ],
};

// Returns the stored settings merged over defaults (new fields appear automatically)
async function loadSiteSettings() {
  let stored = null;
  if (store.IS_CONVEX) {
    try { stored = await store.convexQuery('admin:getSettings', {}); } catch {}
  } else {
    const raw = localJsonLoad(SITE_SETTINGS_FILE, null);
    stored = raw ? JSON.stringify(raw) : null;
  }
  try { return { ...DEFAULT_SITE_SETTINGS, ...(stored ? JSON.parse(stored) : {}) }; }
  catch { return DEFAULT_SITE_SETTINGS; }
}

app.get('/api/site-settings', async (req, res) => {
  const s = await loadSiteSettings();
  // Non-secret tracking ids ride along so the client can boot GA4 + Meta pixel.
  // The platform site tracks with the built-in company's (Midwest's) org ids.
  try {
    const mw = ((await kvGet('tracking:orgs')) || {})['midwest-3on3'];
    const g = await growthSettings();
    s.ga4Id = mw?.ga4Id || g.ga4Id;
    s.metaPixelId = mw?.metaPixelId || g.metaPixelId;
  } catch {}
  res.json(s);
});

// Path is public for GET, so PUT must authenticate explicitly
app.put('/api/site-settings', auth.requireAuth, auth.requireRole('superadmin'), async (req, res) => {
  const value = JSON.stringify(req.body || {});
  if (value.length > 50000) return res.status(413).json({ error: 'settings too large' });
  try {
    if (store.IS_CONVEX) await store.convexMutation('admin:setSettings', { value });
    else localJsonSave(SITE_SETTINGS_FILE, req.body || {});
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Organizations registry — SE credentials verified live against SportsEngine,
// then encrypted at rest (AES-256-GCM, key only in server env) and locked.
// Secrets are write-only: responses never include plaintext OR ciphertext.
const cryptoLib = require('crypto');
function encryptSecret(plain) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY || '', 'hex');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY missing or invalid (need 64 hex chars)');
  const iv = cryptoLib.randomBytes(12);
  const cipher = cryptoLib.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}
function decryptSecret(blob) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY || '', 'hex');
  const [iv, tag, data] = String(blob).split(':').map(h => Buffer.from(h, 'hex'));
  const decipher = cryptoLib.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
function maskOrgSecret(o) {
  const { seClientSecret, seClientSecretEnc, ...rest } = o;
  return {
    ...rest,
    hasCredentials: !!(seClientSecretEnc || seClientSecret),
    seClientSecret: (seClientSecretEnc || seClientSecret) ? '••••••••' : '',
  };
}
async function loadOrg(orgKey) {
  const orgs = store.IS_CONVEX
    ? await store.convexQuery('admin:listOrgs', {})
    : localJsonLoad(ORGS_FILE, []);
  return orgs.find(o => o.orgKey === orgKey) || null;
}
async function saveOrgDoc(doc) {
  if (store.IS_CONVEX) {
    const { _id, _creationTime, ...clean } = doc;
    await store.convexMutation('admin:upsertOrg', clean);
  } else {
    const orgs = localJsonLoad(ORGS_FILE, []).filter(o => o.orgKey !== doc.orgKey);
    orgs.push(doc);
    localJsonSave(ORGS_FILE, orgs);
  }
}

// ── Company accounts (a company owns one or more organizations) ───────────────
const ACCOUNTS_FILE = path.join(__dirname, 'data', 'accounts.json');

async function listAccountsRaw() {
  return store.IS_CONVEX
    ? await store.convexQuery('admin:listAccounts', {})
    : localJsonLoad(ACCOUNTS_FILE, []);
}
async function saveAccountDoc(doc) {
  if (store.IS_CONVEX) {
    const { _id, _creationTime, ...clean } = doc;
    await store.convexMutation('admin:upsertAccount', clean);
  } else {
    const list = localJsonLoad(ACCOUNTS_FILE, []).filter(a => a.accountKey !== doc.accountKey);
    list.push(doc);
    localJsonSave(ACCOUNTS_FILE, list);
  }
}

// First load bootstraps the default company + Midwest org so the existing
// deployment appears in the new hierarchy without touching its data.
async function ensureDefaultCompany() {
  const accounts = await listAccountsRaw();
  if (accounts.length > 0) return accounts;
  const now = new Date().toISOString();
  const account = { accountKey: 'midwest-3on3', name: 'Midwest 3on3', createdAt: now };
  await saveAccountDoc(account);
  const existingOrg = await loadOrg('midwest-default');
  if (!existingOrg) {
    await saveOrgDoc({
      orgKey: 'midwest-default', accountKey: 'midwest-3on3',
      name: 'Midwest 3on3', seOrgId: '8008',
      verified: true, verifiedOrgName: '3 on 3 Hoops Hub', lockedAt: now,
      status: 'active', subscriptionStatus: 'beta', createdAt: now,
      notes: 'Built-in default org — runs on the server environment credentials',
    });
  }
  return [account];
}

app.get('/api/admin/accounts', auth.requireRole('superadmin'), async (req, res) => {
  try {
    const accounts = await ensureDefaultCompany();
    res.json({ accounts: accounts.map(({ _id, _creationTime, ...a }) => a) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/accounts/:accountKey', auth.requireRole('superadmin'), async (req, res) => {
  const { accountKey } = req.params;
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name is required' });
  try {
    const existing = (await listAccountsRaw()).find(a => a.accountKey === accountKey);
    await saveAccountDoc({
      accountKey,
      name: String(b.name),
      ownerUserId: b.ownerUserId || existing?.ownerUserId || undefined,
      createdAt: existing?.createdAt || new Date().toISOString(),
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/accounts/:accountKey', auth.requireOwner, async (req, res) => {
  try {
    if (PROTECTED_ORG_KEYS.has(req.params.accountKey)) {
      return res.status(403).json({ error: 'This company is permanently protected and can never be deleted' });
    }
    const acct = (await listAccountsRaw()).find(a => a.accountKey === req.params.accountKey);
    if (!acct) return res.status(404).json({ error: 'Company not found' });
    if (!(await checkDeleteGuards(req, res, 'account', req.params.accountKey, acct.name))) return;
    if (store.IS_CONVEX) await store.convexMutation('admin:removeAccount', { accountKey: req.params.accountKey });
    else localJsonSave(ACCOUNTS_FILE, localJsonLoad(ACCOUNTS_FILE, []).filter(a => a.accountKey !== req.params.accountKey));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Company-level endpoints — for customer admins linked to an account ────────
async function requireCompanyUser(req, res) {
  const me = await userStore.findById(req.user.id);
  if (!me?.accountKey) { res.status(403).json({ error: 'No company linked to this account' }); return null; }
  return me;
}

app.get('/api/company/me', async (req, res) => {
  try {
    const me = await requireCompanyUser(req, res); if (!me) return;
    const [accounts, orgsRes] = await Promise.all([
      listAccountsRaw(),
      store.IS_CONVEX ? store.convexQuery('admin:listOrgs', {}) : localJsonLoad(ORGS_FILE, []),
    ]);
    const account = accounts.find(a => a.accountKey === me.accountKey);
    const orgs = orgsRes.filter(o => o.accountKey === me.accountKey)
      .map(({ _id, _creationTime, ...o }) => maskOrgSecret(o));
    const g = await growthSettings();
    res.json({
      account: account ? { accountKey: account.accountKey, name: account.name } : null,
      orgs,
      onboardingVideoUrl: g.onboardingVideoUrl || '',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Self-serve SportsEngine connection: the customer pastes their own
// Client ID + Secret, we verify live against SE, auto-detect the org id and
// name, encrypt the secret and lock the org — no support ticket needed.
app.post('/api/company/orgs', auth.requireRole('admin'), async (req, res) => {
  try {
    const me = await requireCompanyUser(req, res); if (!me) return;
    const { seClientId, seClientSecret, name } = req.body || {};
    if (!seClientId || !seClientSecret) return res.status(400).json({ error: 'Client ID and Client Secret are required' });

    // Live test: token grant + identity lookup (same check the owner uses)
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', String(seClientId).trim());
    params.append('client_secret', String(seClientSecret).trim());
    let seName = '', seOrgIds = [];
    try {
      const tok = await axios.post(SE_TOKEN_URL, params, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      const meRes = await axios.get('https://user.sportsengine.com/oauth/me', {
        headers: { Authorization: `Bearer ${tok.data.access_token}` },
      });
      seName   = meRes.data?.result?.client?.name || '';
      seOrgIds = meRes.data?.result?.client?.organization_ids || [];
    } catch (err) {
      return res.status(400).json({
        error: 'SportsEngine rejected these credentials — double-check the Client ID and Secret',
        detail: err.response?.data?.error_description || err.response?.data?.error || err.message,
      });
    }

    const orgName = String(name || seName || 'My Organization').trim();
    let orgKey = `${me.accountKey}-${orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`.slice(0, 50);
    if (await loadOrg(orgKey)) orgKey = `${orgKey}-${Date.now().toString(36).slice(-4)}`;
    const doc = {
      orgKey, accountKey: me.accountKey, name: orgName,
      seClientId: String(seClientId).trim(),
      seClientSecretEnc: encryptSecret(String(seClientSecret).trim()),
      seOrgId: seOrgIds[0] != null ? String(seOrgIds[0]) : undefined,
      verified: true, verifiedOrgName: seName || undefined,
      lockedAt: new Date().toISOString(), status: 'active',
      createdAt: new Date().toISOString(), notes: 'Self-serve onboarding',
    };
    await saveOrgDoc(doc);
    capiSend('SubmitApplication', { email: me.email, ip: req.ip, ua: req.headers['user-agent'] });
    res.json({ ok: true, org: maskOrgSecret(doc), seName, seOrgIds });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/company/users', async (req, res) => {
  try {
    const me = await requireCompanyUser(req, res); if (!me) return;
    const users = (await userStore.list()).filter(u => u.accountKey === me.accountKey);
    res.json({ users });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/company/users', auth.requireRole('admin'), async (req, res) => {
  try {
    const me = await requireCompanyUser(req, res); if (!me) return;
    const { username, password, role, email } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    if (!['admin', 'editor'].includes(role)) return res.status(400).json({ error: 'role must be admin or editor' });
    if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
    const passwordHash = await auth.hashPassword(password);
    const user = await userStore.create({ username, passwordHash, role, email: email || undefined, accountKey: me.accountKey });
    res.json({ user });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.get('/api/admin/orgs', auth.requireRole('superadmin'), async (req, res) => {
  try {
    const orgs = store.IS_CONVEX
      ? await store.convexQuery('admin:listOrgs', {})
      : localJsonLoad(ORGS_FILE, []);
    res.json({ orgs: orgs.map(({ _id, _creationTime, ...o }) => maskOrgSecret(o)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/orgs/:orgKey', auth.requireRole('superadmin'), async (req, res) => {
  const { orgKey } = req.params;
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'name is required' });
  try {
    const existing = await loadOrg(orgKey);
    const locked = !!existing?.lockedAt;
    const newSecret = (b.seClientSecret && !/^•+$/.test(b.seClientSecret)) ? b.seClientSecret : null;
    // Once locked, credentials are immutable via plain save — only the
    // verify endpoint (which re-tests against SE) can replace them.
    if (locked && (newSecret || (b.seClientId && b.seClientId !== existing.seClientId))) {
      return res.status(409).json({ error: 'Credentials are verified & locked — use Verify & Replace to change them' });
    }
    const doc = {
      orgKey,
      accountKey:         b.accountKey || existing?.accountKey || undefined,
      name:               String(b.name),
      seOrgId:            b.seOrgId ?? existing?.seOrgId ?? undefined,
      seClientId:         locked ? existing.seClientId : (b.seClientId || existing?.seClientId || undefined),
      seClientSecret:     locked ? undefined : (newSecret || existing?.seClientSecret || undefined),
      seClientSecretEnc:  existing?.seClientSecretEnc || undefined,
      verified:           existing?.verified || undefined,
      verifiedOrgName:    existing?.verifiedOrgName || undefined,
      lockedAt:           existing?.lockedAt || undefined,
      status:             b.status || 'beta',
      plan:               b.plan   || undefined,
      stripeCustomerId:   existing?.stripeCustomerId   || undefined,
      subscriptionStatus: b.subscriptionStatus || existing?.subscriptionStatus || 'beta',
      createdAt:          existing?.createdAt || new Date().toISOString(),
      notes:              b.notes || undefined,
    };
    await saveOrgDoc(doc);
    res.json({ ok: true, org: maskOrgSecret(doc) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Verify credentials against SportsEngine, then encrypt + lock them.
// Send { seClientId, seClientSecret } (or omit to re-verify stored ones).
app.post('/api/admin/orgs/:orgKey/verify', auth.requireRole('superadmin'), async (req, res) => {
  try {
    const org = await loadOrg(req.params.orgKey);
    if (!org) return res.status(404).json({ error: 'Organization not found' });

    const cid = req.body?.seClientId
      || org.seClientId;
    const sec = (req.body?.seClientSecret && !/^•+$/.test(req.body.seClientSecret))
      ? req.body.seClientSecret
      : (org.seClientSecret || (org.seClientSecretEnc ? decryptSecret(org.seClientSecretEnc) : null));
    if (!cid || !sec) return res.status(400).json({ error: 'Client ID and secret are required to verify' });

    // Live test against SportsEngine: token grant + identity lookup
    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', cid);
    params.append('client_secret', sec);
    let seName = '', seOrgIds = [];
    try {
      const tok = await axios.post(SE_TOKEN_URL, params, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      const me  = await axios.get('https://user.sportsengine.com/oauth/me', {
        headers: { Authorization: `Bearer ${tok.data.access_token}` },
      });
      seName   = me.data?.result?.client?.name || '';
      seOrgIds = me.data?.result?.client?.organization_ids || [];
    } catch (err) {
      return res.status(400).json({
        error: 'SportsEngine rejected these credentials',
        detail: err.response?.data?.error_description || err.response?.data?.error || err.message,
      });
    }

    // Success — encrypt, clear plaintext, lock
    const doc = {
      ...org,
      seClientId:        cid,
      seClientSecret:    undefined,
      seClientSecretEnc: encryptSecret(sec),
      seOrgId:           org.seOrgId || (seOrgIds[0] != null ? String(seOrgIds[0]) : undefined),
      verified:          true,
      verifiedOrgName:   seName || undefined,
      lockedAt:          new Date().toISOString(),
    };
    delete doc._id; delete doc._creationTime;
    await saveOrgDoc(doc);
    res.json({ ok: true, verified: true, seName, seOrgIds, org: maskOrgSecret(doc) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Guarded deletion: multi-step, typed-name, email 2FA — and a platform-wide
//    kill-switch. Even the Owner cannot delete until PLATFORM_DELETES_ENABLED=1
//    is set in the environment (deliberately disabled for safety right now).
const DELETES_ENABLED = process.env.PLATFORM_DELETES_ENABLED === '1';
// The founding org can never be deleted, no matter who asks or what flags are
// set — it holds the live Midwest data, Sarah, tracking, everything.
const PROTECTED_ORG_KEYS = new Set(['midwest-3on3']);

// KV layer (blobs, cache, capped lists, chat logs) lives in ./kv — see
// DEVELOPERS.md §3. Extracted verbatim in refactor step 1 (§9).

// ── Convex usage estimation ─────────────────────────────────────────────────
// store.js meters every Convex round-trip; this flushes the counters into a
// per-day KV bucket (usage:convex:YYYY-MM-DD) at most once a minute. The
// flush itself is tiny (~1-5KB) and self-metered, so numbers stay honest.
let lastUsageFlush = 0;
let usageFlushing = false;
async function maybeFlushUsage() {
  if (!store.IS_CONVEX || usageFlushing) return;
  const now = Date.now();
  if (now - lastUsageFlush < 60000 || !store.usage.calls) return;
  usageFlushing = true; lastUsageFlush = now;
  try {
    const snap = { bytes: store.usage.bytes, calls: store.usage.calls, byFn: { ...store.usage.byFn } };
    store.resetUsage();
    const key = `usage:convex:${store.todayCDT()}`;
    const cur = (await kvGet(key)) || { bytes: 0, calls: 0, byFn: {} };
    cur.bytes += snap.bytes; cur.calls += snap.calls;
    for (const [f, v] of Object.entries(snap.byFn)) {
      const c = cur.byFn[f] = cur.byFn[f] || { calls: 0, bytes: 0 };
      c.calls += v.calls; c.bytes += v.bytes;
    }
    await kvSet(key, cur);
  } catch {} finally { usageFlushing = false; }
}

app.get('/api/admin/usage', auth.requireRole('admin'), async (req, res) => {
  try {
    await (async () => { lastUsageFlush = 0; await maybeFlushUsage(); })(); // include the freshest numbers
    const today = store.todayCDT();
    const days = [];
    for (let i = 0; i < 31; i++) {
      const d = new Date(Date.now() - i * 86400000 + -5 * 3600000).toISOString().slice(0, 10);
      if (d.slice(0, 7) === today.slice(0, 7) || i < 7) days.push(d);
    }
    const buckets = await Promise.all([...new Set(days)].map(async d => ({ day: d, data: await kvGet(`usage:convex:${d}`) })));
    const sum = (list) => list.reduce((a, b) => ({ bytes: a.bytes + (b.data?.bytes || 0), calls: a.calls + (b.data?.calls || 0) }), { bytes: 0, calls: 0 });
    const week = buckets.filter(b => b.day > new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10));
    const month = buckets.filter(b => b.day.slice(0, 7) === today.slice(0, 7));
    // top functions this month
    const byFn = {};
    for (const b of month) for (const [f, v] of Object.entries(b.data?.byFn || {})) {
      const c = byFn[f] = byFn[f] || { calls: 0, bytes: 0 };
      c.calls += v.calls; c.bytes += v.bytes;
    }
    res.json({
      today: sum(buckets.filter(b => b.day === today)),
      week: sum(week),
      month: sum(month),
      topFunctions: Object.entries(byFn).map(([fn, v]) => ({ fn, ...v })).sort((a, b) => b.bytes - a.bytes).slice(0, 10),
      daily: buckets.filter(b => b.data).map(b => ({ day: b.day, bytes: b.data.bytes, calls: b.data.calls })).sort((a, b) => a.day.localeCompare(b.day)),
      note: 'App-measured estimate (request+response JSON bytes over Convex HTTP). Convex bills stricter internally — treat as a trend indicator, not an invoice.',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Sends via Resend when RESEND_API_KEY is configured; returns false otherwise.
async function sendEmail(to, subject, text) {
  if (!process.env.RESEND_API_KEY) return false;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM || 'onboarding@resend.dev', to, subject, text }),
    });
    return r.ok;
  } catch { return false; }
}

// Step 1 of deletion: request a 2FA code (Owner only). Emails a 6-digit code
// to the Owner's email; the code is stored hashed with a 10-minute expiry.
app.post('/api/admin/delete-request', auth.requireOwner, async (req, res) => {
  const { targetType, targetKey } = req.body || {};
  if (!['org', 'account'].includes(targetType) || !targetKey) {
    return res.status(400).json({ error: 'targetType (org|account) and targetKey required' });
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const codeHash = cryptoLib.createHash('sha256').update(code).digest('hex');
  await kvSet(`del2fa:${targetType}:${targetKey}`, {
    codeHash, requestedBy: req.user.id, expiresAt: Date.now() + 10 * 60 * 1000,
  });
  const me = await userStore.findById(req.user.id);
  const to = me?.email || SUPER_ADMIN_EMAIL;
  const emailSent = to ? await sendEmail(
    to,
    'Deletion confirmation code',
    `Your confirmation code for deleting ${targetType} "${targetKey}" is: ${code}\n\nIt expires in 10 minutes. If you did not request this, ignore this email.`
  ) : false;
  res.json({ ok: true, emailSent, emailConfigured: !!process.env.RESEND_API_KEY, deletesEnabled: DELETES_ENABLED });
});

async function checkDeleteGuards(req, res, targetType, targetKey, expectedName) {
  if (!DELETES_ENABLED) {
    res.status(403).json({ error: 'Deletion is disabled platform-wide for safety (PLATFORM_DELETES_ENABLED is off)' });
    return false;
  }
  const { confirmName, code } = req.body || {};
  if (!confirmName || confirmName !== expectedName) {
    res.status(400).json({ error: 'Typed name does not match — deletion aborted' });
    return false;
  }
  if (process.env.RESEND_API_KEY) { // 2FA enforced whenever email delivery exists
    const rec = await kvGet(`del2fa:${targetType}:${targetKey}`);
    const hash = code ? cryptoLib.createHash('sha256').update(String(code)).digest('hex') : null;
    if (!rec || rec.expiresAt < Date.now() || rec.codeHash !== hash) {
      res.status(403).json({ error: 'Invalid or expired confirmation code' });
      return false;
    }
    await kvSet(`del2fa:${targetType}:${targetKey}`, { used: true, expiresAt: 0 });
  }
  return true;
}

app.delete('/api/admin/orgs/:orgKey', auth.requireOwner, async (req, res) => {
  try {
    if (PROTECTED_ORG_KEYS.has(req.params.orgKey)) {
      return res.status(403).json({ error: 'This organization is permanently protected and can never be deleted' });
    }
    const org = await loadOrg(req.params.orgKey);
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    if (!(await checkDeleteGuards(req, res, 'org', req.params.orgKey, org.name))) return;
    if (store.IS_CONVEX) await store.convexMutation('admin:removeOrg', { orgKey: req.params.orgKey });
    else localJsonSave(ORGS_FILE, localJsonLoad(ORGS_FILE, []).filter(o => o.orgKey !== req.params.orgKey));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// GROWTH ENGINE — self-serve signup, 7-day trials with caps, Stripe billing,
// GA4/Meta CAPI tracking, auto1labs service offers, feedback inbox.
// Everything is dormant-safe: with no STRIPE_* keys the flows render "coming
// soon"; paste the keys and the same code goes live unchanged.
// ═══════════════════════════════════════════════════════════════════════════════

// Growth settings (owner-editable): trial caps + tracking ids. CAPI token is
// encrypted at rest like the Meta ads token.
async function growthSettings() {
  const s = (await kvGet('growth:settings')) || {};
  return {
    trialDays: s.trialDays ?? 7,
    trialActiveLimit: s.trialActiveLimit ?? 5,
    trialMonthlyLimit: s.trialMonthlyLimit ?? 20,
    ga4Id: s.ga4Id || process.env.GA4_MEASUREMENT_ID || '',
    metaPixelId: s.metaPixelId || process.env.META_PIXEL_ID || '',
    capiToken: s.capiTokenEnc ? decryptSecret(s.capiTokenEnc) : (process.env.META_CAPI_TOKEN || ''),
    hasCapiToken: !!(s.capiTokenEnc || process.env.META_CAPI_TOKEN),
    stripePriceId: s.stripePriceId || process.env.STRIPE_PRICE_ID || '',
    onboardingVideoUrl: s.onboardingVideoUrl || '',
    seWebhookKey: s.seWebhookKey || '',
  };
}

// Billing state lives in KV (not the accounts table) so no schema migration:
// { [accountKey]: { status, orgSize, trialStartedAt, trialEndsAt,
//                   stripeCustomerId, stripeSubscriptionId, updatedAt } }
async function billingAll() { return (await kvGet('billing:accounts')) || {}; }
async function billingSave(accountKey, patch) {
  const all = await billingAll();
  all[accountKey] = { ...(all[accountKey] || {}), ...patch, updatedAt: new Date().toISOString() };
  await kvSet('billing:accounts', all);
  return all[accountKey];
}
function liveStatus(b) {
  if (!b) return 'none';
  if (b.status === 'trialing' && b.trialEndsAt && b.trialEndsAt < new Date().toISOString()) return 'expired';
  return b.status;
}

async function trialAvailability() {
  const [s, all] = await Promise.all([growthSettings(), billingAll()]);
  const now = new Date().toISOString();
  const month = now.slice(0, 7);
  let active = 0, thisMonth = 0;
  for (const b of Object.values(all)) {
    if (b.status === 'trialing' && b.trialEndsAt > now) active++;
    if ((b.trialStartedAt || '').slice(0, 7) === month) thisMonth++;
  }
  const available = active < s.trialActiveLimit && thisMonth < s.trialMonthlyLimit;
  return { available, active, thisMonth, activeLimit: s.trialActiveLimit, monthlyLimit: s.trialMonthlyLimit, trialDays: s.trialDays };
}

// ── Meta Conversions API (server-side) — fire-and-forget, dormant without token
const sha256 = (v) => cryptoLib.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');
async function capiSend(eventName, { email, phone, firstName, lastName, ip, ua, sourceUrl, value, eventId, pixelId, token, eventTimeSec } = {}) {
  try {
    // per-org override (customer's own pixel) falls back to platform settings
    const s = await growthSettings();
    const pixel = pixelId || s.metaPixelId;
    const capiToken = token || s.capiToken;
    if (!pixel || !capiToken) return false;
    const user_data = { client_user_agent: ua || undefined, client_ip_address: ip || undefined };
    if (email)     user_data.em = [sha256(email)];
    if (phone)     user_data.ph = [sha256(String(phone).replace(/[^\d]/g, ''))];
    if (firstName) user_data.fn = [sha256(firstName)];
    if (lastName)  user_data.ln = [sha256(lastName)];
    const body = {
      data: [{
        event_name: eventName,
        // Meta accepts event_time up to 7 days back — retried/backfilled sends
        // carry the REAL registration moment so attribution timing stays right
        event_time: eventTimeSec || Math.floor(Date.now() / 1000),
        action_source: 'website', event_source_url: sourceUrl || 'https://www.midwest3on3.com',
        ...(eventId ? { event_id: String(eventId) } : {}),   // dedup key
        user_data, ...(value ? { custom_data: { currency: 'USD', value } } : {}),
      }],
    };
    await axios.post(`https://graph.facebook.com/v21.0/${pixel}/events`,
      body, { params: { access_token: capiToken }, timeout: 8000 });
    console.log(`[capi] sent ${eventName}`);
    capiSend.lastError = null;
    return true;
  } catch (err) {
    capiSend.lastError = err.response?.data?.error?.message || err.message;
    console.warn('[capi] failed:', capiSend.lastError);
    return false;
  }
}

// ── Public: does the landing page still show the free-trial option?
app.get('/api/signup/availability', async (req, res) => {
  try {
    const t = await trialAvailability();
    res.json({ trialAvailable: t.available, trialDays: t.trialDays });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Public: self-serve registration → company + admin user + trial
app.post('/api/signup', async (req, res) => {
  const { companyName, orgSize, username, email, password } = req.body || {};
  if (!companyName || !username || !password) return res.status(400).json({ error: 'Company name, username and password are required' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  try {
    if (await userStore.findByUsername(String(username).trim())) {
      return res.status(409).json({ error: 'That username is taken — pick another' });
    }
    let accountKey = String(companyName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'org';
    const existing = await listAccountsRaw();
    if (existing.some(a => a.accountKey === accountKey)) accountKey = `${accountKey}-${Date.now().toString(36).slice(-4)}`;

    const trial = await trialAvailability();
    const now = new Date();
    await saveAccountDoc({ accountKey, name: String(companyName).trim(), createdAt: now.toISOString() });
    const passwordHash = await auth.hashPassword(String(password));
    const user = await userStore.create({
      username: String(username).trim(), passwordHash, role: 'admin',
      email: email ? String(email).trim() : undefined, accountKey,
    });
    const billing = await billingSave(accountKey, trial.available ? {
      status: 'trialing', orgSize: orgSize || 'unknown',
      trialStartedAt: now.toISOString(),
      trialEndsAt: new Date(now.getTime() + trial.trialDays * 86400000).toISOString(),
    } : { status: 'pending', orgSize: orgSize || 'unknown' });

    capiSend(trial.available ? 'StartTrial' : 'CompleteRegistration', {
      email, ip: req.ip, ua: req.headers['user-agent'], sourceUrl: req.headers.referer,
    });
    const token = auth.signToken(user);
    res.json({ ok: true, token, user: { id: user.id, username: user.username, role: user.role, accountKey }, billing: { ...billing, status: liveStatus(billing) } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Stripe (lazy — only loaded when a key exists) ─────────────────────────────
let _stripe = null;
function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  if (!_stripe) _stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  return _stripe;
}
// If no price id is configured, create the product+price once from site
// settings and remember it — "paste the secret key and boom".
async function ensureStripePrice(stripe) {
  const s = await growthSettings();
  if (s.stripePriceId) return s.stripePriceId;
  const site = await loadSiteSettings();
  const amount = Math.round(Number(site.betaPriceMonthly || 30) * 100);
  const product = await stripe.products.create({ name: site.appName || 'Data Explorer for SportsEngine' });
  const price = await stripe.prices.create({ product: product.id, unit_amount: amount, currency: 'usd', recurring: { interval: 'month' } });
  const cur = (await kvGet('growth:settings')) || {};
  await kvSet('growth:settings', { ...cur, stripePriceId: price.id });
  return price.id;
}

// My billing status (any signed-in user)
app.get('/api/billing/me', async (req, res) => {
  try {
    const me = await userStore.findById(req.user.id);
    if (!me?.accountKey || me.accountKey === 'midwest-3on3' || ['owner', 'superadmin'].includes(me.role)) {
      return res.json({ status: 'internal', stripeEnabled: !!process.env.STRIPE_SECRET_KEY });
    }
    const b = (await billingAll())[me.accountKey];
    const status = liveStatus(b);
    const daysLeft = b?.trialEndsAt ? Math.max(0, Math.ceil((new Date(b.trialEndsAt) - Date.now()) / 86400000)) : 0;
    res.json({ status, trialEndsAt: b?.trialEndsAt || null, trialDaysLeft: status === 'trialing' ? daysLeft : 0, stripeEnabled: !!process.env.STRIPE_SECRET_KEY });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Start a subscription — Stripe-hosted Checkout collects the card (PCI-safe)
app.post('/api/billing/checkout', async (req, res) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: 'Billing opens soon — you stay on the free beta until then' });
    const me = await userStore.findById(req.user.id);
    if (!me?.accountKey) return res.status(400).json({ error: 'No company linked to this user' });
    const priceId = await ensureStripePrice(stripe);
    const origin = req.headers.origin || `https://${req.headers.host}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: me.email || undefined,
      client_reference_id: me.accountKey,
      metadata: { accountKey: me.accountKey },
      subscription_data: { metadata: { accountKey: me.accountKey } },
      success_url: `${origin}/?billing=success`,
      cancel_url: `${origin}/?billing=cancelled`,
      allow_promotion_codes: true,
    });
    res.json({ url: session.url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Manage card / cancel — Stripe-hosted billing portal
app.post('/api/billing/portal', async (req, res) => {
  try {
    const stripe = getStripe();
    if (!stripe) return res.status(503).json({ error: 'Billing is not configured yet' });
    const me = await userStore.findById(req.user.id);
    const b = (await billingAll())[me?.accountKey];
    if (!b?.stripeCustomerId) return res.status(400).json({ error: 'No subscription on file yet' });
    const origin = req.headers.origin || `https://${req.headers.host}`;
    const session = await stripe.billingPortal.sessions.create({ customer: b.stripeCustomerId, return_url: origin });
    res.json({ url: session.url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Stripe → us. Signature verified over the raw body.
app.post('/api/billing/webhook', async (req, res) => {
  const stripe = getStripe();
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).json({ error: 'Billing is not configured yet' });
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) { return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` }); }
  try {
    const obj = event.data.object;
    const accountKey = obj.metadata?.accountKey || obj.client_reference_id;
    if (event.type === 'checkout.session.completed' && accountKey) {
      await billingSave(accountKey, { status: 'active', stripeCustomerId: obj.customer, stripeSubscriptionId: obj.subscription });
      capiSend('Subscribe', { email: obj.customer_details?.email, value: (obj.amount_total || 0) / 100 });
    } else if (event.type === 'customer.subscription.updated' && accountKey) {
      const map = { active: 'active', trialing: 'active', past_due: 'past_due', unpaid: 'past_due', canceled: 'canceled' };
      await billingSave(accountKey, { status: map[obj.status] || obj.status });
    } else if (event.type === 'customer.subscription.deleted' && accountKey) {
      await billingSave(accountKey, { status: 'canceled' });
    } else if (event.type === 'invoice.payment_failed') {
      const key = obj.subscription_details?.metadata?.accountKey;
      if (key) await billingSave(key, { status: 'past_due' });
    }
    console.log(`[stripe] ${event.type}${accountKey ? ' → ' + accountKey : ''}`);
    res.json({ received: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SportsEngine → Meta CAPI bridge ────────────────────────────────────────────
// SE checkout pages can't run a pixel/GTM, but SE HQ can POST webhooks on
// "Registration" / "Registration Result". We receive those server-to-server,
// deep-scan the payload for contact fields, hash them the way Meta wants
// (SHA-256 em/ph/fn/ln) and forward CompleteRegistration + Purchase via CAPI.
// Every delivery's raw body is kept (capped) so extraction can be refined
// once real payloads are seen.

function deepScan(obj) {
  // Walk any payload shape and pull out likely contact + event fields
  const found = { emails: new Set(), phones: new Set(), first: null, last: null, eventIds: new Set(), ids: new Set(), prices: [] };
  const walk = (v, key = '') => {
    if (v == null) return;
    if (typeof v === 'object') { for (const [k, x] of Object.entries(v)) walk(x, k.toLowerCase()); return; }
    const s = String(v);
    if (/@/.test(s) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) found.emails.add(s.toLowerCase());
    else if (/phone|mobile|cell/.test(key) && s.replace(/\D/g, '').length >= 10) found.phones.add(s);
    else if (/first.?name/.test(key) && !found.first) found.first = s;
    else if (/last.?name/.test(key) && !found.last) found.last = s;
    else if (/event/.test(key) && /^\d{6,8}$/.test(s)) found.eventIds.add(s);
    else if (/(^|_)id$|uuid|guid/.test(key)) found.ids.add(s.slice(0, 60));
    else if (/price|amount|total|fee/.test(key) && /^\d+(\.\d+)?$/.test(s)) found.prices.push(Number(s));
  };
  walk(obj);
  return found;
}

// Per-organization tracking config (pixel/GA4/CAPI/webhook key) — each
// customer's conversion signal goes to THEIR pixel, not a global one.
// KV 'tracking:orgs' = { [accountKey]: {ga4Id, metaPixelId, capiTokenEnc, seWebhookKey, updatedAt} }
async function orgTrackingAll() { return (await kvGet('tracking:orgs')) || {}; }
async function resolveWebhookKey(key) {
  if (!key) return null;
  const all = await orgTrackingAll();
  for (const [accountKey, cfg] of Object.entries(all)) {
    if (cfg.seWebhookKey && cfg.seWebhookKey === key) return { accountKey, cfg };
  }
  // legacy: the key minted before tracking moved org-side — it's Midwest's
  const g = await growthSettings();
  if (g.seWebhookKey && key === g.seWebhookKey) return { accountKey: 'midwest-3on3', cfg: all['midwest-3on3'] || null };
  return null;
}

// ── Enrichment: SE webhooks carry only a pointer ({organizationId,
// resourceOperation, resourceId, resourceType}) — fetch the full registration
// result from SportsEngine GraphQL by id, decide if it's genuinely NEW, and
// forward only the PRIMARY CONTACT (the purchaser — the person who saw the ad).
const RESULT_BY_ID_QUERY = `query($id: Int!) {
  registrationResult(id: $id) {
    id completed status created registrationId
    answers {
      name
      ... on StringRegistrationResultAnswer { strValue: value }
      ... on ArrayRegistrationResultAnswer  { arrValue: value }
    }
  }
}`;

// Which SE credentials enrich this delivery: the platform key uses the env
// credentials; an org's key uses that org's own verified credentials.
async function seTokenFor(accountKey) {
  if (!accountKey || accountKey === 'midwest-3on3') return getAccessToken();
  const orgs = store.IS_CONVEX ? await store.convexQuery('admin:listOrgs', {}) : localJsonLoad(ORGS_FILE, []);
  const org = orgs.find(o => o.accountKey === accountKey && o.verified && o.seClientId && o.seClientSecretEnc);
  if (!org) throw new Error(`no verified SE credentials for ${accountKey}`);
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('client_id', org.seClientId);
  params.append('client_secret', decryptSecret(org.seClientSecretEnc));
  const tok = await axios.post(SE_TOKEN_URL, params, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  return tok.data.access_token;
}

// The purchaser: SE forms put the buyer in top-level answers ("Primary Contact
// First Name", "Last Name", "Phone", "Email") while teammates live under
// "Player N …" — only the primary contact is sent to Meta, so attribution
// lands on the person who saw the ad and paid, not a teammate.
function primaryContactFrom(answers) {
  const get = (re) => {
    const a = (answers || []).find(x => re.test(x.name) && !/player|alternate|parent 2|guardian 2/i.test(x.name));
    return a?.strValue || (Array.isArray(a?.arrValue) ? a.arrValue[0] : null) || null;
  };
  return {
    email:     get(/^e-?mail$/i) || get(/primary.*email|^email address$/i),
    phone:     get(/^phone( number)?$/i) || get(/primary.*phone/i),
    firstName: get(/primary contact first name/i) || get(/^first name$/i),
    lastName:  get(/^last name$/i) || get(/primary contact last name/i),
  };
}

// NEW registration = completed + created within 48h + never forwarded before.
// SE fires "update" webhooks for edits to years-old registrations — not sales.
const NEW_REG_WINDOW_MS = 48 * 3600 * 1000;
const maskEmail = (e) => e ? String(e).replace(/^(.).*(@.*)$/, '$1***$2') : null;
// asOfMs: "new registration" freshness is judged against when the webhook was
// DELIVERED, not when we process — so retrying a failed delivery days later
// still classifies it correctly.
async function processRegistrationResult(match, resourceId, asOfMs = Date.now(), opts = {}) {
  const sentMap = (await kvGet('sewh:sent')) || {};
  if (sentMap[resourceId]) {
    const first = sentMap[resourceId]?.at || sentMap[resourceId];
    return { decision: 'duplicate — this registration was already forwarded to Meta', reason: `first sent ${String(first).slice(0, 16).replace('T', ' ')}` };
  }

  const token = await seTokenFor(match.accountKey);
  let res;
  try {
    res = await axios.post(SE_GRAPHQL_URL, { query: RESULT_BY_ID_QUERY, variables: { id: Number(resourceId) } },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 });
  } catch (err) {
    // SE returns transient 5xx under bursts — one paced retry before failing
    if (err.response?.status >= 500) {
      await new Promise(r => setTimeout(r, 1500));
      res = await axios.post(SE_GRAPHQL_URL, { query: RESULT_BY_ID_QUERY, variables: { id: Number(resourceId) } },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 });
    } else throw err;
  }
  const rr = res.data?.data?.registrationResult;
  if (!rr) return { decision: 'result id not found in SportsEngine', reason: 'the API returned nothing for this id — possibly deleted' };

  const eventId = String(rr.registrationId || '');
  // Event name: our store first (authoritative), scraped deadlines as fallback
  let eventName = null;
  try { const db = await store.load(); eventName = db.events?.[eventId]?.name || null; } catch {}
  const dl = ((await kvGet('deadlines:all')) || {})[eventId];
  eventName = eventName || dl?.eventName || null;
  const resultCreated = String(rr.created || '');
  const base = { eventId, eventName, resultCreated };

  if (!rr.completed) return { ...base, decision: 'incomplete registration — no sale (yet)', reason: 'SportsEngine marks it not completed; a completed webhook will follow if they finish checkout' };
  const ageMs = asOfMs - new Date(rr.created).getTime();
  if (ageMs > NEW_REG_WINDOW_MS) {
    const days = Math.round(ageMs / 86400000);
    return { ...base, decision: `edit of an EXISTING registration — not a new sale`, reason: `registered ${resultCreated.slice(0, 10)} (${days} days ago); SportsEngine fires update webhooks when old registrations are edited` };
  }

  const contact = primaryContactFrom(rr.answers);
  if (!contact.email && !contact.phone) return { ...base, decision: 'NEW registration, but no primary contact found in the answers', reason: 'no top-level Email/Phone answer — check the form field names in the raw payload' };

  // Order value: EB price if registered on/before the EB date, else final
  let value = null;
  if (dl) {
    const regDay = resultCreated.slice(0, 10);
    value = (dl.earlyBird && regDay <= dl.earlyBird) ? (dl.earlyBirdPrice || dl.finalPrice) : (dl.finalPrice || dl.earlyBirdPrice);
  }

  if (opts.send === false) {
    return { ...base, decision: 'found unsent — outside Meta 7-day backfill window (enriched, not sent)',
      reason: 'Meta rejects conversions older than 7 days; full details recorded for visibility',
      value, capiSent: false, contactMasked: maskEmail(contact.email), hasEmail: !!contact.email, hasPhone: !!contact.phone };
  }

  const override = match.cfg?.metaPixelId && match.cfg?.capiTokenEnc
    ? { pixelId: match.cfg.metaPixelId, token: decryptSecret(match.cfg.capiTokenEnc) }
    : null;
  const eventTimeSec = Math.min(Math.floor(new Date(rr.created).getTime() / 1000), Math.floor(Date.now() / 1000));
  const args = { ...contact, value, eventId: `se-${resourceId}`, eventTimeSec, ...(override || {}) };
  const ok = await capiSend('CompleteRegistration', args);
  if (ok && value) await capiSend('Purchase', { ...args, eventId: `se-${resourceId}-p` });

  if (ok) {
    sentMap[resourceId] = { at: new Date().toISOString(), created: rr.created };
    const keys = Object.keys(sentMap);
    if (keys.length > 800) for (const k of keys.slice(0, keys.length - 800)) delete sentMap[k];
    await kvSet('sewh:sent', sentMap);
  }
  return {
    ...base,
    decision: ok ? '🟢 NEW registration → CompleteRegistration + Purchase sent to Meta' : 'NEW registration, but Meta CAPI send failed',
    reason: ok
      ? `matched primary contact ${maskEmail(contact.email) || contact.phone}${override ? ' → org pixel ' + override.pixelId : ' → default pixel'}`
      : (capiSend.lastError || 'no pixel id / CAPI token configured for this organization — set them on this page'),
    value, capiSent: ok, contactMasked: maskEmail(contact.email),
    hasEmail: !!contact.email, hasPhone: !!contact.phone,
  };
}

// SE settings may probe the URL first — answer GET/HEAD with 200 (+challenge echo)
app.get(['/api/webhooks/sportsengine', '/api/webhooks/sportsengine/:key'], (req, res) =>
  res.status(200).send(String(req.query.challenge || 'ok')));

// Key accepted in query (?key=), path (/sportsengine/<key>) or header — SE's
// settings UI may mangle query strings, so the path form is the safe default.
app.post(['/api/webhooks/sportsengine', '/api/webhooks/sportsengine/:key'], async (req, res) => {
  try {
    const key = req.params.key || req.query.key || req.headers['x-webhook-key'] || '';
    const match = await resolveWebhookKey(String(key));
    const body = req.body || {};
    const resourceType = body.resourceType || body.resource_type || '';
    const resourceId = body.resourceId || body.resource_id || null;

    let outcome = { decision: !match ? 'rejected — bad/missing key' : 'received' };
    if (match && /registrationresult/i.test(resourceType) && resourceId) {
      // Enrich synchronously (SE result lookup ~1-2s) so Vercel doesn't kill
      // the work after the response; SE tolerates the latency.
      try { outcome = await processRegistrationResult(match, String(resourceId)); }
      catch (err) { outcome = { decision: `enrichment failed: ${err.message.slice(0, 120)}` }; }
    } else if (match) {
      // Non-registration payloads (or unknown shapes): best-effort direct scan
      const scan = deepScan(body);
      const email = [...scan.emails][0] || null;
      if (email) {
        const override = match.cfg?.metaPixelId && match.cfg?.capiTokenEnc
          ? { pixelId: match.cfg.metaPixelId, token: decryptSecret(match.cfg.capiTokenEnc) } : null;
        const dedupId = cryptoLib.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 24);
        const ok = await capiSend('CompleteRegistration', { email, eventId: dedupId, ...(override || {}) });
        outcome = { decision: ok ? 'scanned payload → sent to Meta' : 'scanned, CAPI not configured', hasEmail: true, capiSent: ok };
      } else {
        outcome = { decision: `ignored (${resourceType || 'no resourceType'})` };
      }
    }

    // Record EVERY delivery — including rejected ones — for the inspector
    await appendCapped('sewh:recent', {
      at: new Date().toISOString(),
      accountKey: match?.accountKey || null,
      keyOk: !!match,
      type: `${resourceType || body.type || 'unknown'}${body.resourceOperation ? '.' + body.resourceOperation : ''}`,
      resourceId: resourceId || null,
      decision: outcome.decision, reason: outcome.reason || null,
      eventId: outcome.eventId || null, eventName: outcome.eventName || null,
      resultCreated: outcome.resultCreated || null, contactMasked: outcome.contactMasked || null,
      hasEmail: !!outcome.hasEmail, hasPhone: !!outcome.hasPhone,
      value: outcome.value || null, capiSent: !!outcome.capiSent,
      sample: JSON.stringify(body).slice(0, 1200) || '(empty body)',
    }, 400);

    // Silent-breakage guard: enrichment failures (e.g. an SE schema change)
    // email the owner — at most once per 6h — instead of waiting to be noticed.
    if (/enrichment failed/.test(outcome.decision || '')) {
      const alertState = (await kvGet('sewh:alert')) || {};
      if (!alertState.lastAt || Date.now() - new Date(alertState.lastAt).getTime() > 6 * 3600 * 1000) {
        await kvSet('sewh:alert', { lastAt: new Date().toISOString() });
        sendEmail(SUPER_ADMIN_EMAIL,
          '⚠ SportsEngine → Meta signal: enrichment is failing',
          `A registration webhook could not be enriched:\n\n${outcome.decision}\n\nResource ${resourceId} · ${new Date().toISOString()}\n\nCheck the 📡 Tracking & Signal page — the raw payload and error are recorded there, and ♻ Retry failed will recover the missed sales once the cause is fixed. (This alert is sent at most once every 6 hours.)`
        ).catch(() => {});
      }
    }
    const stats = (await kvGet('sewh:stats')) || { total: 0, capiSent: 0 };
    stats.total++; if (outcome.capiSent) stats.capiSent++;
    if (!match) stats.rejected = (stats.rejected || 0) + 1;
    stats.lastAt = new Date().toISOString();
    await kvSet('sewh:stats', stats);

    // Self-healing: each healthy delivery quietly retries up to 2 older failed
    // ones — once a breakage is fixed, the backlog drains without anyone
    // pressing Retry. (Runs before the response; Vercel kills post-response work.)
    if (match && !/enrichment failed/.test(outcome.decision || '')) {
      try { await drainFailedDeliveries(2); } catch {}
      try {
        const g2 = (await kvGet('sewh:lastAutoAudit')) || 0;
        if (Date.now() - Number(g2) > 6 * 3600 * 1000) {
          await kvSet('sewh:lastAutoAudit', Date.now());
          const host = process.env.VERCEL === '1' ? `https://${req.headers['x-forwarded-host'] || req.headers.host}` : 'http://localhost:3001';
          const tok = auth.signToken({ id: 'auto-audit', username: 'auto-audit', role: 'admin' });
          await axios.post(`${host}/api/webhooks/audit7d?limit=15`, {}, { headers: { Authorization: `Bearer ${tok}` }, timeout: 40000 }).catch(() => {});
        }
      } catch {}
    }
    res.json({ ok: true });
  } catch (err) {
    console.warn('[sewh] failed:', err.message);
    if (!res.headersSent) res.json({ ok: true });
  }
});

// Reprocess failed deliveries (e.g. after an SE schema change broke
// enrichment): re-runs each failed registrationResult with the freshness
// window judged at its original delivery time, updates the rows in place.
// Shared retry engine: re-run failed deliveries (freshness judged at original
// delivery time), update rows in place. Used by the ♻ Retry button, the
// per-webhook self-heal, and the daily cron.
async function drainFailedDeliveries(limit, accountFilter = null) {
  const recent = (await kvGet('sewh:recent')) || [];
  // Only failures where data can appear later: transient errors, results not
  // yet visible in SE, and incomplete checkouts. Terminal verdicts (old edits,
  // duplicates, no contact) are never worth retrying.
  const all = recent.filter(r =>
    /enrichment failed|not found in SportsEngine|incomplete registration/.test(r.decision || '') && r.resourceId &&
    (!accountFilter || r.accountKey === accountFilter));
  const targets = all.slice(0, Math.min(Math.max(limit || 8, 1), 20));
  const seen = new Set();
  let sent = 0, done = 0;
  const items = [];
  for (const r of targets) {
    if (seen.has(String(r.resourceId))) { r.decision = 'duplicate delivery of a retried result'; r.reason = 'same resourceId reprocessed above'; continue; }
    seen.add(String(r.resourceId));
    const match = { accountKey: r.accountKey || 'midwest-3on3', cfg: (await orgTrackingAll())[r.accountKey || 'midwest-3on3'] || null };
    try {
      const outcome = await processRegistrationResult(match, String(r.resourceId), new Date(r.at).getTime());
      Object.assign(r, {
        decision: outcome.decision, reason: outcome.reason || null,
        eventId: outcome.eventId || null, eventName: outcome.eventName || null,
        resultCreated: outcome.resultCreated || null, contactMasked: outcome.contactMasked || null,
        hasEmail: !!outcome.hasEmail, hasPhone: !!outcome.hasPhone,
        value: outcome.value || null, capiSent: !!outcome.capiSent,
        retriedAt: new Date().toISOString(),
      });
      if (outcome.capiSent) sent++;
      done++;
      items.push({ id: r.resourceId, decision: outcome.decision || '?', eventName: outcome.eventName || null, value: outcome.value || null, capiSent: !!outcome.capiSent, contactMasked: outcome.contactMasked || null });
    } catch (err) {
      r.decision = `enrichment failed: ${err.message.slice(0, 120)}`;
      r.retriedAt = new Date().toISOString();
    }
  }
  if (targets.length) {
    await kvSet('sewh:recent', recent);
    if (sent) {
      const stats = (await kvGet('sewh:stats')) || { total: 0, capiSent: 0 };
      stats.capiSent += sent;
      await kvSet('sewh:stats', stats);
    }
  }
  return { retried: done, uniqueResults: seen.size, sentToMeta: sent, remaining: Math.max(0, all.length - targets.length), totalFailed: all.length, items };
}

app.post('/api/webhooks/reprocess', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    const me = await userStore.findById(req.user.id);
    const platform = ['owner', 'superadmin'].includes(me?.role) || !me?.accountKey || me?.accountKey === 'midwest-3on3';
    const out = await drainFailedDeliveries(Number(req.query.limit) || 8, platform ? null : me.accountKey);
    res.json({ ok: true, ...out });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Daily cron (vercel.json, 09:00 UTC): retry any failed webhook deliveries and
// refresh the Meta ads data so dashboards open warm. Vercel sends
// Authorization: Bearer <CRON_SECRET> when that env var is set.
app.get('/api/cron/daily', async (req, res) => {
  if (process.env.CRON_SECRET && req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'bad cron secret' });
  }
  const out = {};
  try { out.webhookRetry = await drainFailedDeliveries(8); } catch (e) { out.webhookRetry = { error: e.message }; }
  // chat-log retention: keep the freshest N of each type, trim the tail daily
  if (store.IS_CONVEX) {
    try {
      out.chatLogPrune = {};
      for (const [type, keep] of [['convo', 2000], ['question', 3000], ['unanswered', 500]]) {
        out.chatLogPrune[type] = (await store.convexMutation('chatLogs:prune', { type, keep })).deleted;
      }
    } catch (e) { out.chatLogPrune = { error: e.message }; }
  }
  try {
    const host2 = process.env.VERCEL === '1' ? `https://${req.headers['x-forwarded-host'] || req.headers.host}` : 'http://localhost:3001';
    const tok2 = auth.signToken({ id: 'cron', username: 'cron', role: 'admin' });
    out.audit = (await axios.post(`${host2}/api/webhooks/audit7d?limit=15`, {}, { headers: { Authorization: `Bearer ${tok2}` }, timeout: 45000 })).data;
  } catch (e) { out.audit = { error: e.message }; }
  try {
    // Self-call the ads sync with a short-lived internal admin token
    const host = process.env.VERCEL === '1' ? `https://${req.headers['x-forwarded-host'] || req.headers.host}` : 'http://localhost:3001';
    const tok = auth.signToken({ id: 'cron', username: 'cron', role: 'admin' });
    const r = await axios.post(`${host}/api/ads/sync`, {}, { headers: { Authorization: `Bearer ${tok}` }, timeout: 45000 });
    out.adsSync = r.data;
  } catch (e) { out.adsSync = { error: e.response?.data?.error || e.message }; }
  console.log('[cron] daily:', JSON.stringify(out).slice(0, 300));
  res.json({ ok: true, ...out });
});

// 7-day cross-check: walk OUR STORE's recent registrations (independent of
// webhook history), find any not yet forwarded to Meta, enrich + send them,
// and record each find as an 'audit.7d' row in the log.
app.post('/api/webhooks/audit7d', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 60);
    const cutoff = Date.now() - days * 86400000;
    const metaLimit = Date.now() - 7 * 86400000 + 3600000; // Meta rejects event_time >7d old
    const db = await store.load();
    let candidates = [];
    if (!store.IS_CONVEX) {
      candidates = db.results.filter(r => r.created && new Date(r.created).getTime() >= cutoff)
        .map(r => ({ id: String(r.id), created: r.created, email: r.email || null, eventId: String(r.eventId || ''), eventName: r.eventName || null }));
    } else {
      // Convex: scan only actively-selling events (open status) to stay in budget
      const openEvents = Object.values(db.events).filter(e => e.status === 1).slice(0, 120);
      for (const ev of openEvents) {
        try {
          const rows = await store.convexQuery('reports:resultsByEvent', { eventId: String(ev.id) });
          for (const r of (rows || [])) if (r.created && new Date(r.created).getTime() >= cutoff) candidates.push({ id: String(r.id), created: r.created, email: r.email || null, eventId: String(r.eventId || ev.id), eventName: r.eventName || ev.name || null });
        } catch {}
      }
    }
    const sentMap = (await kvGet('sewh:sent')) || {};
    const missing = candidates.filter(c => !sentMap[c.id]);
    const limit = Math.min(Number(req.query.limit) || 10, 15);
    const batch = missing.slice(0, limit);
    let sent = 0;
    const items = [];
    const cfg = (await orgTrackingAll())['midwest-3on3'] || null;
    const sentLedger = sentMap;
    for (const m of batch) {
      // Enrich from OUR STORE (smart-update keeps it fresh) — no SE calls
      let outcome;
      const tooOld = new Date(m.created).getTime() < metaLimit;
      if (!m.email) {
        outcome = { decision: 'found unsent — no email in store row', reason: 'store row has no contact; run a purge-reload for this event to refresh answers', eventId: m.eventId, eventName: m.eventName, resultCreated: m.created };
      } else if (tooOld) {
        outcome = { decision: 'found unsent — outside Meta 7-day backfill window (enriched from store, not sent)', reason: 'Meta rejects conversions older than 7 days', eventId: m.eventId, eventName: m.eventName, resultCreated: m.created, contactMasked: maskEmail(m.email), hasEmail: true };
      } else {
        let value = null;
        const dl = ((await kvGet('deadlines:all')) || {})[m.eventId];
        if (dl) { const day = String(m.created).slice(0, 10); value = (dl.earlyBird && day <= dl.earlyBird) ? (dl.earlyBirdPrice || dl.finalPrice) : (dl.finalPrice || dl.earlyBirdPrice); }
        const override = cfg?.metaPixelId && cfg?.capiTokenEnc ? { pixelId: cfg.metaPixelId, token: decryptSecret(cfg.capiTokenEnc) } : null;
        const eventTimeSec = Math.min(Math.floor(new Date(m.created).getTime() / 1000), Math.floor(Date.now() / 1000));
        const args = { email: m.email, value, eventId: 'se-' + m.id, eventTimeSec, ...(override || {}) };
        const ok = await capiSend('CompleteRegistration', args);
        if (ok && value) await capiSend('Purchase', { ...args, eventId: 'se-' + m.id + '-p' });
        if (ok) { sentLedger[m.id] = { at: new Date().toISOString(), created: m.created }; await kvSet('sewh:sent', sentLedger); }
        outcome = { decision: ok ? '🟢 AUDIT: missed sale found in store → sent to Meta' : 'store find, but CAPI send failed', reason: ok ? 'enriched from the local store (no SE call needed)' : (capiSend.lastError || 'CAPI not configured'), eventId: m.eventId, eventName: m.eventName, resultCreated: m.created, contactMasked: maskEmail(m.email), hasEmail: true, value, capiSent: ok };
      }
      if (outcome.capiSent) sent++;
      items.push({ id: m.id, decision: outcome.decision, eventName: outcome.eventName || null, value: outcome.value || null, capiSent: !!outcome.capiSent, contactMasked: outcome.contactMasked || null });
      await appendCapped('sewh:audit', {
        at: new Date().toISOString(), accountKey: 'midwest-3on3', keyOk: true,
        type: 'audit.' + days + 'd', resourceId: m.id,
        decision: outcome.capiSent ? '🟢 AUDIT: missed sale found → sent to Meta' : 'audit: ' + (outcome.decision || '?'),
        reason: outcome.reason || 'found by 7-day store cross-check (no webhook had forwarded it)',
        eventId: outcome.eventId || null, eventName: outcome.eventName || null,
        resultCreated: outcome.resultCreated || m.created, contactMasked: outcome.contactMasked || null,
        hasEmail: !!outcome.hasEmail, hasPhone: !!outcome.hasPhone,
        value: outcome.value || null, capiSent: !!outcome.capiSent,
        sample: '(store audit — no webhook payload)',
      }, 400);
    }
    if (sent) { const st = (await kvGet('sewh:stats')) || { total: 0, capiSent: 0 }; st.capiSent += sent; await kvSet('sewh:stats', st); }
    res.json({ ok: true, checked: candidates.length, alreadySent: candidates.length - missing.length, missing: missing.length, processed: batch.length, sentToMeta: sent, remaining: Math.max(0, missing.length - batch.length), items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Store registrations NEVER sent to Meta — the browsable gap list.
// Same candidate scan as the audit, no sends; the Cross-check button sends them.
app.get('/api/webhooks/missing', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 60);
    const cutoff = Date.now() - days * 86400000;
    const db = await store.load();
    let candidates = [];
    if (!store.IS_CONVEX) {
      candidates = db.results.filter(r => r.created && new Date(r.created).getTime() >= cutoff)
        .map(r => ({ id: String(r.id), created: r.created, email: r.email || null, eventName: r.eventName || null }));
    } else {
      const openEvents = Object.values(db.events).filter(e => e.status === 1).slice(0, 120);
      for (const ev of openEvents) {
        try {
          const rows = await store.convexQuery('reports:resultsByEvent', { eventId: String(ev.id) });
          for (const r of (rows || [])) if (r.created && new Date(r.created).getTime() >= cutoff)
            candidates.push({ id: String(r.id), created: r.created, email: r.email || null, eventName: r.eventName || ev.name || null });
        } catch {}
      }
    }
    const ledger = (await kvGet('sewh:sent')) || {};
    const missing = candidates.filter(c => !ledger[c.id])
      .sort((a, b) => String(b.created).localeCompare(String(a.created)));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const stats = (await kvGet('sewh:stats')) || { total: 0, capiSent: 0 };
    res.json({
      stats, totalStored: missing.length, offset, inStore: candidates.length,
      deliveries: missing.slice(offset, offset + 50).map(m => ({
        at: m.created, type: 'never-sent', resourceId: m.id, capiSent: false, keyOk: true,
        hasEmail: !!m.email, contactMasked: m.email ? String(m.email).replace(/^(.).*(@.*)$/, '$1***$2') : null,
        decision: 'in store, never forwarded to Meta',
        reason: m.email ? 'run 🔍 Cross-check to send (if within Meta 7-day window)' : 'no email in store row — purge-reload this event to refresh answers',
        eventName: m.eventName, resultCreated: m.created, sample: '(store row — no webhook payload)',
      })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// The forwarded list — the send ledger, enriched from the logs where possible
app.get('/api/webhooks/forwarded', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  const [ledger, recent, auditRows] = await Promise.all([kvGet('sewh:sent'), kvGet('sewh:recent'), kvGet('sewh:audit')]);
  const detail = {};
  for (const r of [...(auditRows || []), ...(recent || [])]) if (r.resourceId && r.capiSent) detail[String(r.resourceId)] = r;
  const rows = Object.entries(ledger || {}).map(([id, v]) => ({
    resourceId: id, sentAt: v?.at || v, registeredAt: v?.created || null,
    eventName: detail[id]?.eventName || null, value: detail[id]?.value || null, contactMasked: detail[id]?.contactMasked || null,
  })).sort((a, b) => String(b.sentAt).localeCompare(String(a.sentAt)));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const stats = (await kvGet('sewh:stats')) || { total: 0, capiSent: 0 };
  res.json({ stats, total: rows.length, offset, deliveries: rows.slice(offset, offset + 50).map(r => ({
    at: r.sentAt, type: 'forwarded', resourceId: r.resourceId, capiSent: true, keyOk: true, hasEmail: !!r.contactMasked,
    decision: 'forwarded to Meta', reason: null, eventName: r.eventName, value: r.value, contactMasked: r.contactMasked,
    resultCreated: r.registeredAt, sample: '(send ledger entry)',
  })), totalStored: rows.length });
});

// Reconciliation: Meta events sent (total/today/week) vs SportsEngine
// registrations in the same windows — equal numbers = healthy; the gap is
// what the cross-check should recover.
app.get('/api/webhooks/reconcile', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  try {
    const sentMap = (await kvGet('sewh:sent')) || {};
    const today = store.todayCDT();
    const weekStart = store.toCDTDate(new Date(Date.now() - 6 * 86400000).toISOString());
    let sentTotal = 0, sentToday = 0, sentWeek = 0;
    for (const v of Object.values(sentMap)) {
      sentTotal++;
      // reconcile by REGISTRATION date (created); legacy entries only know send time
      const day = store.toCDTDate(v?.created || v?.at || v);
      if (day === today) sentToday++;
      if (day >= weekStart) sentWeek++;
    }
    // SportsEngine side: daily registration counts from the store
    let seToday = 0, seWeek = 0;
    const daily = store.IS_CONVEX
      ? await store.convexQuery('reports:reportDaily', { fromDate: weekStart })
      : store.dailyStats(await store.load(), { fromDate: weekStart });
    for (const r of (daily || [])) {
      if (r.date === today) seToday += r.total;
      if (r.date >= weekStart) seWeek += r.total;
    }
    // Last 7 weeks: store registrations vs Meta sends per 7-day bucket
    const w7Start = store.toCDTDate(new Date(Date.now() - 48 * 86400000).toISOString());
    const daily7w = store.IS_CONVEX
      ? await store.convexQuery('reports:reportDaily', { fromDate: w7Start })
      : store.dailyStats(await store.load(), { fromDate: w7Start });
    const weekOf = (day) => {
      const idx = Math.floor((new Date(today) - new Date(day)) / (7 * 86400000));
      return Math.min(Math.max(idx, 0), 6);
    };
    const weeks = Array.from({ length: 7 }, (_, i) => ({
      start: store.toCDTDate(new Date(Date.now() - (i * 7 + 6) * 86400000).toISOString()),
      end: store.toCDTDate(new Date(Date.now() - i * 7 * 86400000).toISOString()),
      store: 0, sent: 0,
    }));
    for (const r of (daily7w || [])) { const i = weekOf(r.date); if (weeks[i]) weeks[i].store += r.total; }
    for (const v of Object.values(sentMap)) {
      const day = store.toCDTDate(v?.created || v?.at || v);
      if (day >= w7Start) { const i = weekOf(day); if (weeks[i]) weeks[i].sent++; }
    }
    res.json({
      sent: { total: sentTotal, today: sentToday, week: sentWeek },
      se: { today: seToday, week: seWeek },
      missing: { today: Math.max(0, seToday - sentToday), week: Math.max(0, seWeek - sentWeek) },
      windows: { today, weekStart },
      weeks,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Webhook inspector — every recorded delivery with raw payloads.
// Platform roles see everything; a company admin sees their own org's.
app.get('/api/webhooks/deliveries', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
  const me = await userStore.findById(req.user.id);
  const platform = ['owner', 'superadmin'].includes(me?.role) || !me?.accountKey || me?.accountKey === 'midwest-3on3';
  const src = req.query.view === 'audit' ? 'sewh:audit' : 'sewh:recent';
  let [stats, recent] = await Promise.all([kvGet('sewh:stats'), kvGet(src)]);
  if (src === 'sewh:recent' && (recent || []).some(r => String(r.type || '').startsWith('audit.'))) {
    recent = recent.filter(r => !String(r.type || '').startsWith('audit.'));  // audit rows moved to their own log
    await kvSet('sewh:recent', recent);
  }
  let rows = (recent || []).filter(r => platform || r.accountKey === me.accountKey);
  if (req.query.sent === '1') rows = rows.filter(r => r.capiSent);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  res.json({ stats: stats || { total: 0, capiSent: 0 }, deliveries: rows.slice(offset, offset + limit), totalStored: rows.length, offset, scope: platform ? 'all' : me.accountKey });
});

// Per-org tracking settings — pixel/GA4/CAPI + webhook URL. Tracking is an
// ORGANIZATION concern: each company's admins manage their own (Midwest's
// admins included — platform users without an accountKey resolve to the
// built-in midwest-3on3 company; nothing tracking-related lives at platform
// level anymore).
async function trackingAccountKey(req, res) {
  const me = await userStore.findById(req.user.id);
  const key = me?.accountKey || (['admin', 'owner', 'superadmin'].includes(me?.role) ? 'midwest-3on3' : null);
  if (!key) { res.status(403).json({ error: 'No company linked to this account' }); return null; }
  return key;
}
// One-time migration: Midwest's tracking used to live in the global growth
// settings — move it into its org slot the first time it's read.
async function migrateMidwestTracking(all) {
  if (all['midwest-3on3']?.migrated) return all;
  const g = (await kvGet('growth:settings')) || {};
  all['midwest-3on3'] = {
    ga4Id: g.ga4Id || '', metaPixelId: g.metaPixelId || '',
    ...(g.capiTokenEnc ? { capiTokenEnc: g.capiTokenEnc } : {}),
    ...(g.seWebhookKey ? { seWebhookKey: g.seWebhookKey } : {}),   // SE HQ already has this URL — keep it
    ...(all['midwest-3on3'] || {}),
    migrated: true, updatedAt: new Date().toISOString(),
  };
  await kvSet('tracking:orgs', all);
  return all;
}

app.get('/api/company/tracking', auth.requireRole('admin'), async (req, res) => {
  const accountKey = await trackingAccountKey(req, res); if (!accountKey) return;
  let all = await orgTrackingAll();
  if (accountKey === 'midwest-3on3') all = await migrateMidwestTracking(all);
  let cfg = all[accountKey];
  if (!cfg?.seWebhookKey) {
    cfg = { ...(cfg || {}), seWebhookKey: cryptoLib.randomBytes(18).toString('base64url') };
    all[accountKey] = { ...cfg, updatedAt: new Date().toISOString() };
    await kvSet('tracking:orgs', all);
  }
  const host = process.env.VERCEL === '1' ? `https://${req.headers['x-forwarded-host'] || req.headers.host}` : 'https://<your-production-domain>';
  res.json({
    accountKey,
    ga4Id: cfg.ga4Id || '', metaPixelId: cfg.metaPixelId || '',
    hasCapiToken: !!cfg.capiTokenEnc,
    webhookUrl: `${host}/api/webhooks/sportsengine/${cfg.seWebhookKey}`,
  });
});
app.put('/api/company/tracking', auth.requireRole('admin'), async (req, res) => {
  const accountKey = await trackingAccountKey(req, res); if (!accountKey) return;
  const b = req.body || {};
  let all = await orgTrackingAll();
  if (accountKey === 'midwest-3on3') all = await migrateMidwestTracking(all);
  const cfg = all[accountKey] || {};
  for (const k of ['ga4Id', 'metaPixelId']) if (b[k] !== undefined) cfg[k] = String(b[k]).trim();
  if (b.capiToken && !/^•+$/.test(b.capiToken)) cfg.capiTokenEnc = encryptSecret(String(b.capiToken).trim());
  if (!cfg.seWebhookKey) cfg.seWebhookKey = cryptoLib.randomBytes(18).toString('base64url');
  all[accountKey] = { ...cfg, updatedAt: new Date().toISOString() };
  await kvSet('tracking:orgs', all);
  res.json({ ok: true });
});

// Owner: webhook status + the URL (with secret) to paste into SE HQ settings
app.get('/api/admin/sewebhooks', auth.requireRole('superadmin'), async (req, res) => {
  const cur = (await kvGet('growth:settings')) || {};
  if (!cur.seWebhookKey) {
    cur.seWebhookKey = cryptoLib.randomBytes(18).toString('base64url');
    await kvSet('growth:settings', cur);
  }
  const host = process.env.VERCEL === '1' ? `https://${req.headers['x-forwarded-host'] || req.headers.host}` : 'https://<your-production-domain>';
  const [stats, recent] = await Promise.all([kvGet('sewh:stats'), kvGet('sewh:recent')]);
  res.json({
    url: `${host}/api/webhooks/sportsengine/${cur.seWebhookKey}`,
    stats: stats || { total: 0, capiSent: 0 },
    recent: (recent || []).slice(0, 10),   // includes raw `sample` bodies for inspection
  });
});

// ── auto1labs service offers — owner-curated, matched to org size ─────────────
const DEFAULT_OFFERS = [
  { id: 'media-small', service: 'media', title: 'Done-for-you Meta Ads', priceLabel: 'from $299/mo',
    desc: 'We run your league campaigns end to end — creatives, budgets, weekly reporting tied to your registration pace.',
    url: 'https://auto1labs.com?utm_source=dataexplorer&utm_medium=inapp&utm_campaign=media_buying',
    sizeMin: 0, sizeMax: 5000, active: true },
  { id: 'media-large', service: 'media', title: 'Growth media buying', priceLabel: 'from $799/mo',
    desc: 'Multi-league campaign management with audience exports, retargeting and season-over-season pacing goals.',
    url: 'https://auto1labs.com?utm_source=dataexplorer&utm_medium=inapp&utm_campaign=media_buying_growth',
    sizeMin: 5001, sizeMax: 999999, active: true },
  { id: 'tracking', service: 'tracking', title: 'GTM + Meta CAPI setup', priceLabel: 'one-time $499',
    desc: 'Server-side tracking done right: Google Tag Manager, Conversions API, per-league custom events — see exactly which ad sells registrations.',
    url: 'https://auto1labs.com?utm_source=dataexplorer&utm_medium=inapp&utm_campaign=tracking_setup',
    sizeMin: 0, sizeMax: 999999, active: true },
];
const SIZE_BUCKET = { small: 1000, medium: 5000, large: 20000, unknown: 1000 };

app.get('/api/offers', async (req, res) => {
  try {
    const offers = (await kvGet('growth:offers')) || DEFAULT_OFFERS;
    const me = await userStore.findById(req.user.id);
    const b = me?.accountKey ? (await billingAll())[me.accountKey] : null;
    const size = SIZE_BUCKET[b?.orgSize] ?? Number(b?.orgSize) ?? 1000;
    res.json({ offers: offers.filter(o => o.active && size >= (o.sizeMin || 0) && size <= (o.sizeMax || 999999)) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/admin/offers', auth.requireRole('superadmin'), async (req, res) => {
  res.json({ offers: (await kvGet('growth:offers')) || DEFAULT_OFFERS });
});
app.put('/api/admin/offers', auth.requireRole('superadmin'), async (req, res) => {
  const offers = req.body?.offers;
  if (!Array.isArray(offers)) return res.status(400).json({ error: 'offers array required' });
  await kvSet('growth:offers', offers);
  res.json({ ok: true });
});

// ── Feedback: bug reports, feature requests, auto-captured client errors ──────
app.post('/api/feedback', async (req, res) => {
  const { type, message, page } = req.body || {};
  if (!message || !['bug', 'feature'].includes(type)) return res.status(400).json({ error: 'type (bug|feature) and message required' });
  const me = await userStore.findById(req.user.id);
  await appendCapped('feedback:items', {
    id: crypto.randomUUID(), type, message: String(message).slice(0, 2000), page: page || null,
    username: me?.username, accountKey: me?.accountKey || null, status: 'new',
    createdAt: new Date().toISOString(),
  }, 500);
  res.json({ ok: true });
});
app.post('/api/feedback/error', async (req, res) => {
  const { message, stack, page } = req.body || {};
  await appendCapped('feedback:errors', {
    id: crypto.randomUUID(), message: String(message || '').slice(0, 500),
    stack: String(stack || '').slice(0, 1500), page: page || null,
    username: req.user?.username, createdAt: new Date().toISOString(),
  }, 200);
  res.json({ ok: true });
});
app.get('/api/feedback', auth.requireRole('superadmin'), async (req, res) => {
  const [items, errors] = await Promise.all([kvGet('feedback:items'), kvGet('feedback:errors')]);
  res.json({ items: items || [], errors: errors || [] });
});
app.put('/api/feedback/:id', auth.requireRole('superadmin'), async (req, res) => {
  const list = (await kvGet('feedback:items')) || [];
  const it = list.find(i => i.id === req.params.id);
  if (!it) return res.status(404).json({ error: 'not found' });
  it.status = req.body?.status || it.status;
  await kvSet('feedback:items', list);
  res.json({ ok: true });
});

// ── Owner: customers overview + growth settings ────────────────────────────────
app.get('/api/admin/customers', auth.requireRole('superadmin'), async (req, res) => {
  try {
    const [accounts, billing, users, trial] = await Promise.all([
      listAccountsRaw(), billingAll(), userStore.list(), trialAvailability(),
    ]);
    const customers = accounts.map(({ _id, _creationTime, ...a }) => {
      const b = billing[a.accountKey] || null;
      return {
        ...a,
        billing: b ? { ...b, status: liveStatus(b) } : { status: a.accountKey === 'midwest-3on3' ? 'internal' : 'none' },
        userCount: users.filter(u => u.accountKey === a.accountKey).length,
        users: users.filter(u => u.accountKey === a.accountKey).map(u => ({ username: u.username, email: u.email, role: u.role, lastLoginAt: u.lastLoginAt })),
      };
    });
    res.json({ customers, trial, stripeEnabled: !!process.env.STRIPE_SECRET_KEY, webhookConfigured: !!process.env.STRIPE_WEBHOOK_SECRET });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/admin/growth', auth.requireRole('superadmin'), async (req, res) => {
  const s = await growthSettings();
  res.json({ trialDays: s.trialDays, trialActiveLimit: s.trialActiveLimit, trialMonthlyLimit: s.trialMonthlyLimit,
    ga4Id: s.ga4Id, metaPixelId: s.metaPixelId, hasCapiToken: s.hasCapiToken, stripePriceId: s.stripePriceId,
    onboardingVideoUrl: s.onboardingVideoUrl,
    stripeEnabled: !!process.env.STRIPE_SECRET_KEY, webhookConfigured: !!process.env.STRIPE_WEBHOOK_SECRET });
});
app.put('/api/admin/growth', auth.requireRole('superadmin'), async (req, res) => {
  const b = req.body || {};
  const cur = (await kvGet('growth:settings')) || {};
  const next = { ...cur };
  for (const k of ['trialDays', 'trialActiveLimit', 'trialMonthlyLimit']) if (b[k] !== undefined) next[k] = Math.max(0, Number(b[k]) || 0);
  for (const k of ['ga4Id', 'metaPixelId', 'stripePriceId', 'onboardingVideoUrl']) if (b[k] !== undefined) next[k] = String(b[k]).trim();
  if (b.capiToken && !/^•+$/.test(b.capiToken)) next.capiTokenEnc = encryptSecret(String(b.capiToken).trim());
  await kvSet('growth:settings', next);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// DEADLINES — extracted to server/deadlines.js (refactor step 4, §9).
// Returns the site-scrape helpers the assistant/reminders modules depend on.
// ═══════════════════════════════════════════════════════════════════════════════
const registerDeadlines = require('./deadlines');
const { scrapeTokens, htmlToText, fetchSitePage, SITE_BASE } = registerDeadlines(app);

// ═══════════════════════════════════════════════════════════════════════════════
// SARAH — extracted to server/assistant.js (refactor step 2, DEVELOPERS.md §9).
// Chat widget, knowledge base, FAQ bank, Messenger channel, LLM queue.
// ═══════════════════════════════════════════════════════════════════════════════
const registerAssistant = require('./assistant');
const { assistantSettings } = registerAssistant(app, {
  encryptSecret, decryptSecret, capiSend, sendEmail, EMAIL_RE, htmlToText, fetchSitePage, SITE_BASE,
});

// ═══════════════════════════════════════════════════════════════════════════════
// REMINDERS — extracted to server/reminders.js (refactor step 3, §9).
// ═══════════════════════════════════════════════════════════════════════════════
const registerReminders = require('./reminders');
registerReminders(app, { assistantSettings, loadContactResults, scrapeTokens, EMAIL_RE });

// (Messenger threads/webhook/queue + widget moved to server/assistant.js)

// META ADS REPORTING — read-only Marketing API sync + classification + reports
// Token: in-app setting (encrypted, write-only) wins over META_ACCESS_TOKEN env.
// ══════════════════════════════════════════════════════════════════════════════

const GRAPH = 'https://graph.facebook.com/v21.0';

async function adsSettings() {
  const s = (await kvGet('ads:settings')) || {};
  const token = s.tokenEnc ? decryptSecret(s.tokenEnc) : (process.env.META_ACCESS_TOKEN || null);
  const adAccountId = s.adAccountId || process.env.META_AD_ACCOUNT_ID || null;
  return { token, adAccountId, fromApp: !!s.tokenEnc, updatedAt: s.updatedAt || null };
}

async function metaGet(path, params = {}, token) {
  const q = new URLSearchParams({ ...params, access_token: token });
  const r = await fetch(`${GRAPH}/${path}?${q}`);
  const d = await r.json();
  if (d.error) throw new Error(`Meta API: ${d.error.message}`);
  return d;
}

async function metaGetAll(path, params, token, cap = 2000) {
  let url = `${GRAPH}/${path}?${new URLSearchParams({ ...params, access_token: token })}`;
  const out = [];
  while (url && out.length < cap) {
    const r = await fetch(url);
    const d = await r.json();
    if (d.error) throw new Error(`Meta API: ${d.error.message}`);
    out.push(...(d.data || []));
    url = d.paging?.next || null;
  }
  return out;
}

// GET current settings (masked)
app.get('/api/ads/settings', auth.requireRole('admin'), async (req, res) => {
  const s = await adsSettings();
  res.json({
    adAccountId: s.adAccountId,
    hasToken: !!s.token,
    tokenSource: s.fromApp ? 'app' : (process.env.META_ACCESS_TOKEN ? 'env' : 'none'),
    updatedAt: s.updatedAt,
  });
});

// Save settings — token is write-only; verifies live before saving
app.put('/api/ads/settings', auth.requireRole('admin'), async (req, res) => {
  try {
    const { token, adAccountId } = req.body || {};
    const cur = (await kvGet('ads:settings')) || {};
    const useToken = (token && !/^•+$/.test(token)) ? token : (cur.tokenEnc ? decryptSecret(cur.tokenEnc) : process.env.META_ACCESS_TOKEN);
    const acct = adAccountId || cur.adAccountId || process.env.META_AD_ACCOUNT_ID;
    if (!useToken || !acct) return res.status(400).json({ error: 'Token and ad account ID are required' });
    // Live verification
    const who = await metaGet('me', {}, useToken);
    const acctInfo = await metaGet(`act_${acct}`, { fields: 'name,account_status,currency' }, useToken);
    const next = {
      adAccountId: String(acct),
      tokenEnc: (token && !/^•+$/.test(token)) ? encryptSecret(token) : cur.tokenEnc,
      updatedAt: new Date().toISOString(),
    };
    await kvSet('ads:settings', next);
    res.json({ ok: true, verified: true, tokenUser: who.name, accountName: acctInfo.name, currency: acctInfo.currency });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Full sync: campaigns → daily insights → ads/creatives → classification
app.post('/api/ads/sync', auth.requireRole('admin', 'editor'), async (req, res) => {
  try {
    const { token, adAccountId: acct } = await adsSettings();
    if (!token || !acct) return res.status(400).json({ error: 'Ads not configured — add the Meta token in settings' });

    // 1. ACTIVE campaigns (metadata)
    const campaigns = await metaGetAll(`act_${acct}/campaigns`, {
      fields: 'id,name,status,effective_status,start_time,stop_time,objective,daily_budget',
      filtering: JSON.stringify([{ field: 'effective_status', operator: 'IN', value: ['ACTIVE'] }]),
      limit: 200,
    }, token);

    // 2. "Really active" = ACTIVE status + any spend in the last 21 days —
    //    a small campaign-level totals query (the account has ~70 zombie
    //    ACTIVE campaigns; an unfiltered ad-level query errors out at Meta)
    const sinceYear = `${new Date().getFullYear()}-01-01`;
    const today = new Date().toISOString().slice(0, 10);
    const cutoff = new Date(Date.now() - 21 * 86400000).toISOString().slice(0, 10);
    const recentTotals = await metaGetAll(`act_${acct}/insights`, {
      level: 'campaign', fields: 'campaign_id,spend',
      time_range: JSON.stringify({ since: cutoff, until: today }),
      limit: 500,
    }, token);
    const recentSpend = {};
    for (const r of recentTotals) recentSpend[r.campaign_id] = (recentSpend[r.campaign_id] || 0) + (Number(r.spend) || 0);
    const activeCampaigns = campaigns.filter(c => (recentSpend[c.id] || 0) > 0);
    const activeIds = activeCampaigns.map(c => c.id);

    // 3. Daily insights at AD level for the active campaigns this year — one
    //    dataset from which campaign/adset/ad totals for any date range are
    //    derived client-side (the drill-down UI re-aggregates per range).
    const rawInsights = activeIds.length ? await metaGetAll(`act_${acct}/insights`, {
      level: 'ad', time_increment: '1',
      fields: 'campaign_id,adset_id,ad_id,spend,impressions,reach,clicks,actions',
      time_range: JSON.stringify({ since: sinceYear, until: today }),
      filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: activeIds }]),
      limit: 500,
    }, token, 12000) : [];

    // Keep only report-relevant action types; discover metric names as we go
    const KEEP_ACTIONS = /^(link_click|landing_page_view|video_view|offsite_conversion\.)/;
    const discovered = new Set();
    const pickActions = (raw) => {
      const actions = {};
      for (const a of (raw || [])) {
        if (KEEP_ACTIONS.test(a.action_type)) {
          actions[a.action_type] = Number(a.value) || 0;
          discovered.add(a.action_type);
        }
      }
      return actions;
    };
    const insights = rawInsights.map(r => ({
      c: r.campaign_id, as: r.adset_id, ad: r.ad_id, d: r.date_start,
      spend: Number(r.spend) || 0, imp: Number(r.impressions) || 0,
      reach: Number(r.reach) || 0,
      clicks: Number(r.clicks) || 0, actions: pickActions(r.actions),
    }));

    // 4a. Ad sets for the really-active campaigns — each carries its conversion
    //     goal (promoted_object.custom_event_str, e.g. InitiateRegistration)
    let adsets = [];
    if (activeIds.length) {
      const rawAdsets = await metaGetAll(`act_${acct}/adsets`, {
        fields: 'id,name,campaign_id,effective_status,optimization_goal,daily_budget,promoted_object',
        filtering: JSON.stringify([{ field: 'campaign.id', operator: 'IN', value: activeIds }]),
        limit: 300,
      }, token);
      adsets = rawAdsets.map(s => ({
        id: s.id, name: s.name, campaignId: s.campaign_id, status: s.effective_status,
        optimizationGoal: s.optimization_goal || null,
        dailyBudget: s.daily_budget ? Number(s.daily_budget) / 100 : null,
        goalEvent: s.promoted_object?.custom_event_str || null,
        goalCustomConversionId: s.promoted_object?.custom_conversion_id || null,
      }));
    }

    // 4b. Ads + creatives for the really-active campaigns (thumbnail, video, landing URL)
    let ads = [];
    if (activeIds.length) {
      const rawAds = await metaGetAll(`act_${acct}/ads`, {
        fields: 'id,name,campaign_id,adset_id,effective_status,creative{id,thumbnail_url,video_id,object_type,body,title,object_story_spec}',
        filtering: JSON.stringify([
          { field: 'campaign.id', operator: 'IN', value: activeIds },
          { field: 'effective_status', operator: 'IN', value: ['ACTIVE'] },
        ]),
        limit: 300,
      }, token);
      ads = rawAds.map(a => {
        const cr = a.creative || {};
        const spec = cr.object_story_spec || {};
        const landing = spec.link_data?.link
          || spec.video_data?.call_to_action?.value?.link
          || (cr.body?.match(/https?:\/\/[^\s"']+/) || [])[0]
          || null;
        return {
          id: a.id, name: a.name, campaignId: a.campaign_id, adsetId: a.adset_id,
          creativeId: cr.id || null, thumbnailUrl: cr.thumbnail_url || null,
          videoId: cr.video_id || null, objectType: cr.object_type || null,
          title: cr.title || null, landingUrl: landing,
        };
      });
    }

    // 5. Custom conversion id → friendly name (for offsite_conversion.custom.<id>)
    const ccList = await metaGetAll(`act_${acct}/customconversions`, { fields: 'id,name', limit: 100 }, token).catch(() => []);
    const ccNames = {};
    for (const cc of ccList) ccNames[`offsite_conversion.custom.${cc.id}`] = cc.name;

    const campaignsOut = activeCampaigns.map(c => ({
      id: c.id, name: c.name, status: c.effective_status, startTime: c.start_time,
      objective: c.objective, dailyBudget: c.daily_budget ? Number(c.daily_budget) / 100 : null,
    }));

    const data = {
      syncedAt: new Date().toISOString(), adAccountId: acct,
      campaigns: campaignsOut,
      adsets,
      ads,
      insights: insights.filter(i => activeIds.includes(i.c)),
      ccNames,
      discoveredMetrics: [...discovered].sort(),
      zombieActiveCount: campaigns.length - activeCampaigns.length,
    };
    await kvSet('ads:data', data);
    res.json({ ok: true, campaigns: campaignsOut.length, ads: ads.length, insightDays: data.insights.length, zombiesHidden: data.zombieActiveCount, syncedAt: data.syncedAt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Report data: the synced blob
app.get('/api/ads/data', async (req, res) => {
  const data = await kvGet('ads:data');
  const s = await adsSettings();
  res.json({ data: data || null, configured: !!(s.token && s.adAccountId), adAccountId: s.adAccountId });
});

// ── Recompute dashboard stats + per-event counts from Convex results ──────────
// Fixes (1) double-counted daily stats after a purge, and (2) inflated/stale
// per-event resultCount/resultsCompleted that caused Smart Update to skip events
// that were actually missing rows. Fire-and-forget — each action can take 1-2 min.
app.post('/api/admin/recompute-stats', auth.requireAdmin, async (req, res) => {
  if (!store.IS_CONVEX) return res.status(400).json({ error: 'Only available when connected to Convex' });
  (async () => {
    try {
      const ec = await store.convexAction('reports:recomputeEventCounts', {});
      console.log(`[admin] recomputeEventCounts completed — ${ec?.events ?? '?'} events`);
      await store.convexAction('reports:backfillStats', {});
      console.log('[admin] backfillStats completed');
    } catch (err) {
      console.error('[admin] recompute failed:', err.message);
    }
  })();
  res.json({ ok: true, message: 'Recompute started — fixes event sync counts + dashboard stats. Takes ~1–2 minutes, then run Smart Update and refresh.' });
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
