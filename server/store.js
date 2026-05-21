/**
 * Persistent store for aggregated registration data.
 *
 * All I/O is now ASYNC so the same code works both locally (fs) and on
 * Vercel (Blob storage) via the blobStorage abstraction layer.
 *
 * Callers must await load() and save().
 */
const blobStorage = require('./blobStorage');

const STORE_FILE    = 'store.json';
const CDT_OFFSET_MS = -5 * 60 * 60 * 1000; // UTC-5 (CDT)

// ── Helpers ───────────────────────────────────────────────────────────────────

function emptyStore() {
  return {
    meta: { orgId:'8008', lastRunAt:null, totalResults:0 },
    events:  {},   // eventId → { id, name, status, open, close, fetchedAt, resultCount, resultsCompleted }
    results: [],   // flat array of registration results
  };
}

/** Convert any ISO timestamp to a CDT date string (YYYY-MM-DD). */
function toCDTDate(isoStr) {
  if (!isoStr) return '';
  const ms = new Date(isoStr).getTime();
  if (isNaN(ms)) return String(isoStr).slice(0, 10);
  return new Date(ms + CDT_OFFSET_MS).toISOString().slice(0, 10);
}

/** Today's date in CDT. */
function todayCDT() { return toCDTDate(new Date().toISOString()); }

// ── I/O ───────────────────────────────────────────────────────────────────────

async function load() {
  const data = await blobStorage.readJSON(STORE_FILE, null);
  return data || emptyStore();
}

async function save(store) {
  store.meta.totalResults = store.results.length;
  await blobStorage.writeJSON(STORE_FILE, store);
}

// ── Business logic (all sync — they operate on the in-memory object) ──────────

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
    id:    ev.id,
    name:  ev.name,
    status: ev.status,
    open:  ev.open,
    close: ev.close,
    sport: ev.sport,
    ...extra,
  };
}

// Fields that backfill mode fills in when they are missing on existing records.
const BACKFILL_FIELDS = ['profileId', 'email', 'emails', 'phone', 'phones', 'grade', 'revenue', 'players'];

function upsertResults(store, eventId, eventName, newResults, { merge = false } = {}) {
  // Build index: resultId → array index, for fast lookup and in-place mutation
  const idxById = {};
  store.results.forEach((r, i) => { if (r.eventId === eventId) idxById[r.id] = i; });

  let added = 0;
  for (const r of newResults) {
    if (idxById[r.id] !== undefined) {
      if (merge) {
        // Fill in any fields that were null/missing on the stored record
        const existing = store.results[idxById[r.id]];
        for (const f of BACKFILL_FIELDS) {
          const newVal = r[f];
          const oldVal = existing[f];
          if (newVal == null || newVal === '') continue;
          // For arrays (emails, phones): merge if old is missing or empty
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
  store.meta.totalResults = store.results.length;
  return added;
}

function purgeEvent(store, eventId) {
  const before = store.results.length;
  store.results = store.results.filter(r => r.eventId !== eventId);
  const deleted = before - store.results.length;
  if (store.events[eventId]) {
    const { id, name, status, open, close, sport } = store.events[eventId];
    store.events[eventId] = { id, name, status, open, close, sport };
  }
  store.meta.totalResults = store.results.length;
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
    if (!map[day]) map[day] = { date:day, total:0, byEvent:{} };
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
  load, save, emptyStore,
  pendingEvents, upsertEventMeta, upsertResults, purgeEvent,
  dailyStats, gradYearStats,
  toCDTDate, todayCDT,
};
