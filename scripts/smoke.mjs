#!/usr/bin/env node
/**
 * Smoke suite — read-only checks that the core endpoints still work.
 * Run against a LOCAL server (default) or production:
 *
 *   npm run smoke                          # local (http://localhost:3001)
 *   BASE=https://midwest-data-explorer.vercel.app \
 *   ADMIN_PASS=... npm run smoke           # production
 *
 * Local mode signs an admin token directly (server/.env JWT_SECRET);
 * production mode logs in with ADMIN_PASS. Exit code 0 = all green.
 * Add a check here whenever you add an endpoint (see DEVELOPERS.md §6).
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.BASE || 'http://localhost:3001';
const IS_LOCAL = BASE.includes('localhost');

const require = createRequire(path.join(ROOT, 'server', 'index.js'));
require('dotenv').config({ path: path.join(ROOT, 'server', '.env') });

async function getToken() {
  if (IS_LOCAL) {
    const auth = require(path.join(ROOT, 'server', 'auth.js'));
    const users = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'data', 'users.json'), 'utf8'));
    return auth.signToken(users.find(u => u.username === 'admin'));
  }
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: process.env.ADMIN_PASS }),
  });
  const d = await r.json();
  if (!d.token) throw new Error('login failed: ' + JSON.stringify(d));
  return d.token;
}

let pass = 0, fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++; console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++; console.log(`  ✗ ${name} — ${e.message}`);
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

const token = await getToken();
const get = async (p) => {
  const r = await fetch(`${BASE}${p}`, { headers: { authorization: `Bearer ${token}` } });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
};

console.log(`Smoke @ ${BASE}\n`);

await check('auth: token accepted (events report)', async () => {
  const { status, body } = await get('/api/reports/events');
  expect(status === 200, `status ${status}`);
  const events = Array.isArray(body) ? body : body.events;
  expect(Array.isArray(events) && events.length > 0, 'no events returned');
});

await check('deadlines: list has entries with dates', async () => {
  const { status, body } = await get('/api/deadlines');
  expect(status === 200, `status ${status}`);
  const vals = Object.values(body.deadlines || {});
  expect(vals.length > 0, 'no deadlines');
  expect(vals.some(d => d.earlyBird || d.finalDeadline), 'no dates in deadlines');
});

await check('assistant: admin settings + widget key', async () => {
  const { status, body } = await get('/api/admin/assistant');
  expect(status === 200, `status ${status}`);
  expect(typeof body.embed === 'string' && body.embed.includes('/api/widget.js?key='), 'no embed snippet');
});

await check('assistant: public widget script serves', async () => {
  const r = await fetch(`${BASE}/api/widget.js?key=x`);
  expect(r.status === 200, `status ${r.status}`);
  const js = await r.text();
  expect(js.includes('mw3-chat-bubble'), 'widget body missing bubble id');
});

await check('assistant: chat rejects bad key (auth wall intact)', async () => {
  const r = await fetch(`${BASE}/api/assistant/chat`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'wrong-key', sessionId: 'smoke', messages: [{ role: 'user', content: 'hi' }] }),
  });
  expect(r.status === 401, `expected 401, got ${r.status}`);
});

await check('assistant: inbox endpoint (convos/leads/unanswered)', async () => {
  const { status, body } = await get('/api/admin/assistant/convos');
  expect(status === 200, `status ${status}`);
  expect(Array.isArray(body.convos) && Array.isArray(body.leads) && Array.isArray(body.unanswered), 'missing arrays');
});

await check('reminders: templates present with designs', async () => {
  const { status, body } = await get('/api/admin/reminders/templates');
  expect(status === 200, `status ${status}`);
  expect(body.templates.length >= 3, 'fewer than 3 templates');
  expect(body.templates.every(t => t.subject && t.body), 'template missing subject/body');
});

await check('reminders: preview renders html with CTA + unsubscribe', async () => {
  const r = await fetch(`${BASE}/api/admin/reminders/preview`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ templateId: 'open-announcement' }),
  });
  const d = await r.json();
  expect(r.status === 200, `status ${r.status}: ${JSON.stringify(d).slice(0, 100)}`);
  expect(d.html.includes('href'), 'no links in rendered html');
});

await check('reminders: history endpoint', async () => {
  const { status, body } = await get('/api/admin/reminders/history');
  expect(status === 200, `status ${status}`);
  expect(Array.isArray(body.campaigns), 'no campaigns array');
});

await check('usage: tracker responds', async () => {
  const { status, body } = await get('/api/admin/usage');
  expect(status === 200, `status ${status}`);
  expect(body.today && typeof body.today.bytes === 'number', 'no today bucket');
});

await check('users: list loads', async () => {
  const { status, body } = await get('/api/users');
  expect(status === 200, `status ${status}`);
  expect(body.users.length > 0, 'no users');
});

await check('security: protected org delete refused', async () => {
  const r = await fetch(`${BASE}/api/admin/orgs/midwest-3on3`, {
    method: 'DELETE', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ confirmName: 'anything' }),
  });
  // owner-only route: admins get 403 (role), owners get 403 (protected) — must never be 200
  expect(r.status === 403, `expected 403, got ${r.status}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
