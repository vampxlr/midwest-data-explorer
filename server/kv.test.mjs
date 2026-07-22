/**
 * Unit tests for the KV layer (local-JSON mode). Run: npm test
 * Uses throwaway `test:*` keys and removes them afterwards, so the real
 * prefs.json contents are untouched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
delete process.env.CONVEX_URL; // force local-JSON mode
const kv = require('./kv.js');

const K = `test:kv-${Date.now().toString(36)}`;
const cleanup = async () => {
  const all = kv.localPrefsLoad();
  for (const key of Object.keys(all)) if (key.includes('test:kv-')) delete all[key];
  kv.localPrefsSave(all);
};

test('kvSet/kvGet round-trip preserves objects', async () => {
  await kv.kvSet(K, { a: 1, nested: { b: 'x' }, list: [1, 2] });
  assert.deepEqual(await kv.kvGet(K), { a: 1, nested: { b: 'x' }, list: [1, 2] });
});

test('kvGet returns null for missing keys', async () => {
  assert.equal(await kv.kvGet(`${K}-missing`), null);
});

test('kvGetCached serves cached value, kvSet invalidates', async () => {
  await kv.kvSet(K, { v: 1 });
  assert.deepEqual(await kv.kvGetCached(K), { v: 1 });
  // write behind the cache's back via kvSet — must invalidate
  await kv.kvSet(K, { v: 2 });
  assert.deepEqual(await kv.kvGetCached(K), { v: 2 }, 'kvSet must invalidate the memo');
});

test('appendCapped prepends and enforces the cap', async () => {
  const key = `${K}-cap`;
  for (let i = 1; i <= 5; i++) await kv.appendCapped(key, { i }, 3);
  const list = await kv.kvGet(key);
  assert.equal(list.length, 3, 'cap enforced');
  assert.deepEqual(list.map(x => x.i), [5, 4, 3], 'newest first');
});

test('chatLog/chatLogRecent round-trip (local mode uses capped KV)', async () => {
  // local mode maps type→assistant:* keys; use the unanswered type and restore
  const before = await kv.kvGet('assistant:unanswered');
  try {
    await kv.chatLog('unanswered', { at: new Date().toISOString(), q: 'test-question-xyz' });
    const recent = await kv.chatLogRecent('unanswered', 5);
    assert.ok(recent.some(r => r.q === 'test-question-xyz'), 'logged entry is readable');
  } finally {
    await kv.kvSet('assistant:unanswered', before || []);
  }
});

test.after(cleanup);
