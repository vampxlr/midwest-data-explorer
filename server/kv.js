/**
 * KV + logging layer — the platform's small-state storage (see DEVELOPERS.md §3).
 *
 * - kvGet/kvSet: one JSON blob per key. Convex `preferences` table under
 *   userId '__platform' in production; server/data/prefs.json in local dev.
 * - kvGetCached: in-instance read cache for hot, rarely-changing blobs
 *   (assistant KB/FAQ/settings, deadlines). kvSet invalidates same-instance.
 * - appendCapped: read-modify-write of a whole capped array. Fine for
 *   low-volume lists (leads, abuse); FORBIDDEN for per-message logging.
 * - chatLog/chatLogRecent: high-volume logs → insert-only Convex `chatLogs`
 *   table (~1KB/write); capped KV arrays only in local dev. Reads merge
 *   legacy KV entries so old data stays visible.
 *
 * Code moved verbatim from index.js (refactor step 1, DEVELOPERS.md §9).
 */

const path = require('path');
const fs = require('fs');
const store = require('./store');

// ── Local prefs file (dev mode) ──────────────────────────────────────────────
const PREFS_FILE = path.join(__dirname, 'data', 'prefs.json');
function localPrefsLoad() {
  try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')) || {}; } catch { return {}; }
}
function localPrefsSave(obj) {
  fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true });
  fs.writeFileSync(PREFS_FILE, JSON.stringify(obj, null, 2));
}

// ── KV blobs ─────────────────────────────────────────────────────────────────
async function kvSet(key, obj) {
  if (store.IS_CONVEX) await store.convexMutation('prefs:setPref', { userId: '__platform', key, value: JSON.stringify(obj) });
  else { const all = localPrefsLoad(); all[`__platform:${key}`] = JSON.stringify(obj); localPrefsSave(all); }
  kvMemo.delete(key);
}
async function kvGet(key) {
  let raw;
  if (store.IS_CONVEX) raw = await store.convexQuery('prefs:getPref', { userId: '__platform', key });
  else raw = localPrefsLoad()[`__platform:${key}`];
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

// In-instance read cache for hot KV blobs. Warm serverless instances keep it
// between requests — cuts Convex bandwidth massively on chat traffic.
const kvMemo = new Map();
async function kvGetCached(key, ttlMs = 300000) {
  const hit = kvMemo.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v;
  const v = await kvGet(key);
  kvMemo.set(key, { v, at: Date.now() });
  return v;
}

// ── Capped lists (low-volume only) ───────────────────────────────────────────
async function appendCapped(key, item, cap) {
  const list = (await kvGet(key)) || [];
  list.unshift(item);
  await kvSet(key, list.slice(0, cap));
}

// ── High-volume chat logging ─────────────────────────────────────────────────
const CHATLOG_KV_KEY = { convo: 'assistant:convos', question: 'assistant:questions', unanswered: 'assistant:unanswered' };
const CHATLOG_KV_CAP = { convo: 150, question: 400, unanswered: 200 };
async function chatLog(type, entry) {
  if (store.IS_CONVEX) await store.convexMutation('chatLogs:add', { type, at: entry.at, data: JSON.stringify(entry) });
  else await appendCapped(CHATLOG_KV_KEY[type], entry, CHATLOG_KV_CAP[type]);
}
async function chatLogRecent(type, limit) {
  let rows = [];
  if (store.IS_CONVEX) {
    rows = (await store.convexQuery('chatLogs:recent', { type, limit }).catch(() => []))
      .map(r => { try { return JSON.parse(r.data); } catch { return null; } }).filter(Boolean);
  }
  if (rows.length < limit) {
    const legacy = (await kvGet(CHATLOG_KV_KEY[type])) || [];
    rows = [...rows, ...legacy].slice(0, limit);
  }
  return rows;
}

module.exports = {
  localPrefsLoad, localPrefsSave,
  kvGet, kvSet, kvGetCached,
  appendCapped,
  chatLog, chatLogRecent,
};
