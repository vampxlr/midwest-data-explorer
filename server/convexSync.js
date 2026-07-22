/**
 * Thin helpers for Convex operations that can't go through store.save().
 * Currently: purgeEventResults (loops until all docs deleted).
 *
 * Writes (upsert events/results/storeState) are now handled directly in
 * store.save() via the Convex HTTP API.
 */

const CONVEX_URL = process.env.CONVEX_URL;

// Shared with store.js so purges go through the usage meter (this module
// used to have a private unmetered copy). Errors intentionally swallowed to
// keep the old "best effort" behavior.
const store = require('./store');
async function convexMutation(fnPath, args = {}) {
  if (!CONVEX_URL) return null;
  try { return await store.convexMutation(fnPath, args); } catch { return null; }
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
