/**
 * Thin helpers for Convex operations that can't go through store.save().
 * Currently: purgeEventResults (loops until all docs deleted).
 *
 * Writes (upsert events/results/storeState) are now handled directly in
 * store.save() via the Convex HTTP API.
 */

const CONVEX_URL = process.env.CONVEX_URL;

async function convexMutation(fnPath, args = {}) {
  if (!CONVEX_URL) return null;
  const r = await fetch(`${CONVEX_URL}/api/mutation`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ path: fnPath, args, format: 'json' }),
  });
  const data = await r.json();
  return data.value;
}

/** Delete all results for an event from Convex (500 at a time until done). */
async function purgeEventResults(eventId) {
  if (!CONVEX_URL) return;
  let deleted;
  do {
    const result = await convexMutation('serverSync:purgeEventResults', { eventId: String(eventId) });
    deleted = result ?? 0;
  } while (deleted > 0);
}

module.exports = { purgeEventResults };
