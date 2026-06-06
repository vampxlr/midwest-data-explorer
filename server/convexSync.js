/**
 * Non-blocking Convex sync helper for the Express server.
 *
 * After each SportsEngine fetch, call these functions to mirror the data
 * into Convex so the frontend can use real-time Convex queries.
 *
 * All functions are fire-and-forget: errors are logged but never thrown.
 * CONVEX_URL env var must be set; if missing, all calls are no-ops.
 */

const CONVEX_URL = process.env.CONVEX_URL;
let _client = null;

async function client() {
  if (!CONVEX_URL) return null;
  if (_client) return _client;
  try {
    const mod = await import('convex/browser');
    _client = new mod.ConvexHttpClient(CONVEX_URL);
    return _client;
  } catch (err) {
    console.error('[convexSync] Failed to init client:', err.message);
    return null;
  }
}

async function callMutation(name, args) {
  const c = await client();
  if (!c) return null;
  return c.mutation(name, args);
}

/**
 * Sync all results for a single event (and its event metadata) to Convex.
 * @param {object} db - in-memory store
 * @param {string} eventId
 */
async function syncEventResults(db, eventId) {
  try {
    const ev = db.events[String(eventId)];
    if (ev) {
      await callMutation('serverSync:batchUpsertEvents', {
        events: [{
          seId: String(ev.id ?? eventId),
          name: ev.name,
          status: ev.status,
          open: ev.open,
          close: ev.close,
          sport: ev.sport,
          fetchedAt: ev.fetchedAt,
          resultCount: ev.resultCount,
          resultsCompleted: ev.resultsCompleted,
        }],
      });
    }

    const results = db.results.filter(r => String(r.eventId) === String(eventId));
    const BATCH = 50;
    for (let i = 0; i < results.length; i += BATCH) {
      await callMutation('serverSync:batchUpsertResults', {
        results: results.slice(i, i + BATCH),
      });
    }

    console.log(`[convexSync] Synced ${results.length} results for event ${eventId}`);
  } catch (err) {
    console.error('[convexSync] syncEventResults error:', err.message);
  }
}

/**
 * Purge all results for an event in Convex (call before reloading).
 * Loops until all are deleted (500 per call limit).
 * @param {string} eventId
 */
async function purgeEventResults(eventId) {
  try {
    let deleted;
    let total = 0;
    do {
      deleted = await callMutation('serverSync:purgeEventResults', { eventId: String(eventId) });
      total += deleted ?? 0;
    } while (deleted > 0);
    console.log(`[convexSync] Purged ${total} results for event ${eventId} from Convex`);
  } catch (err) {
    console.error('[convexSync] purgeEventResults error:', err.message);
  }
}

/**
 * Update the store metadata in Convex.
 * @param {object} db - in-memory store
 */
async function updateState(db) {
  try {
    await callMutation('serverSync:updateStoreState', {
      orgId: db.meta?.orgId ?? '8008',
      lastRunAt: db.meta?.lastRunAt ?? undefined,
      totalResults: db.results.length,
      lastUpdatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[convexSync] updateState error:', err.message);
  }
}

/**
 * Fire-and-forget wrapper: runs fn() in background without blocking caller.
 * @param {function} fn
 */
function fireAndForget(fn) {
  setImmediate(() => fn().catch(e => console.error('[convexSync]', e.message)));
}

module.exports = { syncEventResults, purgeEventResults, updateState, fireAndForget };
