/**
 * Persistent store for aggregated registration data.
 *
 * On Vercel (CONVEX_URL set): Convex is the primary store.
 *   - load()  reads events + meta from Convex (results NOT loaded — 30k docs)
 *   - save()  writes dirty events + new results + updated meta to Convex
 *
 * Local dev (no CONVEX_URL): reads/writes from server/data/store.json.
 */

const path = require('path');
const fs   = require('fs');

const IS_CONVEX  = !!process.env.CONVEX_URL;
const CONVEX_URL = process.env.CONVEX_URL;
const DATA_DIR   = path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

const CDT_OFFSET_MS = -5 * 60 * 60 * 1000; // UTC-5 (CDT)

// ── Convex HTTP helpers ────────────────────────────────────────────────────────

// Usage metering: every Convex round-trip is measured (request + response
// bytes, per function) so the app can estimate its own database bandwidth.
// index.js flushes this into daily KV buckets at most once a minute.
const usage = { bytes: 0, calls: 0, byFn: {} };
function meterUsage(fnPath, reqBytes, resBytes) {
  usage.calls++;
  usage.bytes += reqBytes + resBytes;
  const f = usage.byFn[fnPath] = usage.byFn[fnPath] || { calls: 0, bytes: 0 };
  f.calls++; f.bytes += reqBytes + resBytes;
}
function resetUsage() { usage.bytes = 0; usage.calls = 0; usage.byFn = {}; }

async function convexCall(endpoint, fnPath, args) {
  const body = JSON.stringify({ path: fnPath, args, format: 'json' });
  const r = await fetch(`${CONVEX_URL}/api/${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });
  const text = await r.text();
  meterUsage(fnPath, Buffer.byteLength(body), Buffer.byteLength(text));
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Convex ${endpoint} ${fnPath} failed: unparseable response`); }
  if (!r.ok) throw new Error(`Convex ${endpoint} ${fnPath} failed: ${JSON.stringify(data)}`);
  return data.value;
}

const convexQuery    = (fnPath, args = {}) => convexCall('query', fnPath, args);
const convexMutation = (fnPath, args = {}) => convexCall('mutation', fnPath, args);
const convexAction   = (fnPath, args = {}) => convexCall('action', fnPath, args);

// ── Helpers ───────────────────────────────────────────────────────────────────

function emptyStore() {
  return {
    meta:    { orgId: '8008', lastRunAt: null, totalResults: 0 },
    events:  {},
    results: [],
  };
}

function toCDTDate(isoStr) {
  if (!isoStr) return '';
  const ms = new Date(isoStr).getTime();
  if (isNaN(ms)) return String(isoStr).slice(0, 10);
  return new Date(ms + CDT_OFFSET_MS).toISOString().slice(0, 10);
}

function todayCDT() { return toCDTDate(new Date().toISOString()); }

// ── I/O ───────────────────────────────────────────────────────────────────────

async function load() {
  if (IS_CONVEX) {
    try {
      const value = await convexQuery('reports:storeStatus');
      return {
        meta:     value.meta || { orgId: '8008', lastRunAt: null, totalResults: 0 },
        events:   value.events || {},
        results:  [],          // never load all 30k results
        _convex:  true,        // flag for save() and upsertResults()
        _origTotal: value.meta?.totalResults ?? 0,
      };
    } catch (e) {
      console.error('[store] Convex load failed:', e.message);
      return { ...emptyStore(), _convex: true, _origTotal: 0 };
    }
  }

  // Local FS
  try {
    if (!fs.existsSync(STORE_FILE)) return emptyStore();
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) || emptyStore();
  } catch {
    return emptyStore();
  }
}

async function save(store) {
  if (IS_CONVEX) {
    const now = new Date().toISOString();

    // 1. Upsert dirty events
    const dirtyEvents = Object.values(store.events)
      .filter(e => e._dirty)
      .map(({ _dirty, ...e }) => ({
        seId:             String(e.id),
        name:             String(e.name ?? ''),
        status:           e.status,
        open:             e.open   || undefined,
        close:            e.close  || undefined,
        sport:            e.sport  || undefined,
        fetchedAt:        e.fetchedAt || now,
        resultCount:      e.resultCount      != null ? e.resultCount      : undefined,
        resultsCompleted: e.resultsCompleted  != null ? e.resultsCompleted  : undefined,
      }));

    if (dirtyEvents.length > 0) {
      for (let i = 0; i < dirtyEvents.length; i += 50) {
        await convexMutation('serverSync:batchUpsertEvents', { events: dirtyEvents.slice(i, i + 50) });
      }
    }

    // 2. Upsert new results (in-memory results accumulated during this request)
    let inserted = 0;
    if (store.results.length > 0) {
      for (let i = 0; i < store.results.length; i += 50) {
        const batch = store.results.slice(i, i + 50).map(r => ({
          seId:        String(r.seId ?? r.id),
          eventId:     String(r.eventId),
          eventName:   String(r.eventName ?? ''),
          profileId:   r.profileId   || undefined,
          email:       r.email       || undefined,
          emails:      Array.isArray(r.emails)    ? r.emails.map(String)    : [],
          phone:       r.phone       || undefined,
          phones:      Array.isArray(r.phones)    ? r.phones.map(String)    : [],
          firstName:   r.firstName   || undefined,
          lastName:    r.lastName    || undefined,
          zip:         r.zip         || undefined,
          city:        r.city        || undefined,
          state:       r.state       || undefined,
          gender:      r.gender      || undefined,
          gradYears:   Array.isArray(r.gradYears) ? r.gradYears.map(String) : [],
          grade:       r.grade       || undefined,
          revenue:     typeof r.revenue === 'number' ? r.revenue : undefined,
          players:     Array.isArray(r.players)   ? r.players                : [],
          created:     r.created     || undefined,
          completed:   typeof r.completed === 'boolean' ? r.completed : undefined,
        }));
        const res = await convexMutation('serverSync:batchUpsertResults', { results: batch });
        inserted += res?.inserted ?? 0;
      }
    }

    // 3. Update storeState — increment totalResults by newly inserted docs only
    if (dirtyEvents.length > 0 || inserted > 0) {
      const newTotal = (store._origTotal ?? 0) + inserted;
      await convexMutation('serverSync:updateStoreState', {
        orgId:         store.meta.orgId     || '8008',
        lastRunAt:     store.meta.lastRunAt || undefined,
        totalResults:  newTotal,
        lastUpdatedAt: now,
      });
    }
    return { inserted };
  }

  // Local FS
  store.meta.totalResults = store.results.length;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STORE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}

// ── Business logic (sync — operate on in-memory db) ───────────────────────────

function pendingEvents(store, allEvents) {
  return allEvents.filter(ev => {
    const saved = store.events[ev.id];
    if (!saved) return true;
    if (saved.status !== 2) return true; // open → may have new results
    return false;
  });
}

function upsertEventMeta(store, ev, extra = {}) {
  store.events[ev.id] = {
    id:     ev.id,
    name:   ev.name,
    status: ev.status,
    open:   ev.open,
    close:  ev.close,
    sport:  ev.sport,
    _dirty: true,     // marks event as changed — save() uses this
    ...extra,
  };
}

const BACKFILL_FIELDS = ['profileId', 'email', 'emails', 'phone', 'phones', 'grade', 'revenue', 'players'];

function upsertResults(store, eventId, eventName, newResults, { merge = false } = {}) {
  const idxById = {};
  store.results.forEach((r, i) => { if (r.eventId === eventId) idxById[r.id] = i; });

  let added = 0;
  for (const r of newResults) {
    if (idxById[r.id] !== undefined) {
      if (merge) {
        const existing = store.results[idxById[r.id]];
        for (const f of BACKFILL_FIELDS) {
          const newVal = r[f];
          const oldVal = existing[f];
          if (newVal == null || newVal === '') continue;
          if (Array.isArray(newVal)) {
            if (!Array.isArray(oldVal) || oldVal.length === 0) existing[f] = newVal;
          } else {
            if (oldVal == null || oldVal === '') existing[f] = newVal;
          }
        }
      }
      continue;
    }
    store.results.push({ ...r, eventId, eventName });
    idxById[r.id] = store.results.length - 1;
    added++;
  }

  // In Convex mode, don't touch meta.totalResults — save() computes it from inserted count
  if (!store._convex) {
    store.meta.totalResults = store.results.length;
  }
  return added;
}

function purgeEvent(store, eventId) {
  const before = store.results.length;
  store.results = store.results.filter(r => r.eventId !== eventId);
  const deleted = before - store.results.length;
  if (store.events[eventId]) {
    const { id, name, status, open, close, sport } = store.events[eventId];
    store.events[eventId] = { id, name, status, open, close, sport, _dirty: true };
  }
  if (!store._convex) {
    store.meta.totalResults = store.results.length;
  }
  return deleted;
}

function dailyStats(store, { fromDate, toDate, eventId } = {}) {
  const map = {};
  for (const r of store.results) {
    if (!r.created) continue;
    const day = toCDTDate(r.created);
    if (fromDate && day < fromDate) continue;
    if (toDate   && day > toDate)   continue;
    if (eventId  && r.eventId !== eventId) continue;
    if (!map[day]) map[day] = { date: day, total: 0, byEvent: {} };
    map[day].total++;
    map[day].byEvent[r.eventId] = (map[day].byEvent[r.eventId] || 0) + 1;
  }
  return Object.values(map).sort((a, b) => a.date.localeCompare(b.date));
}

function gradYearStats(store, { fromDate, toDate, eventId } = {}) {
  const map = {};
  for (const r of store.results) {
    if (!r.completed) continue;
    const day = toCDTDate(r.created);
    if (fromDate && day < fromDate) continue;
    if (toDate   && day > toDate)   continue;
    if (eventId  && r.eventId !== eventId) continue;
    for (const gy of (r.gradYears || [])) {
      if (/^\d{4}$/.test(gy)) map[gy] = (map[gy] || 0) + 1;
    }
  }
  return Object.entries(map)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

module.exports = {
  IS_CONVEX,
  convexQuery,
  convexMutation,
  convexAction,
  load, save, emptyStore,
  pendingEvents, upsertEventMeta, upsertResults, purgeEvent,
  dailyStats, gradYearStats,
  toCDTDate, todayCDT,
  usage, resetUsage,
};
