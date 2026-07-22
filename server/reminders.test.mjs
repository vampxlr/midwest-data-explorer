/**
 * Unit tests for the Reminders module's pure logic: past-edition matching,
 * template rendering (placeholders, dates, register URL), and email designs.
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
delete process.env.CONVEX_URL;

const routes = [];
const appStub = { get: (p) => routes.push(p), post: (p) => routes.push(p), put: (p) => routes.push(p) };
const deps = {
  assistantSettings: async () => ({}),
  loadContactResults: async () => [],
  // mirror of index.js's scrapeTokens (years stripped, stopwords removed) —
  // the stopword list matters: without it "3 on 3 Basketball League" tokens
  // would make every league match every other league
  scrapeTokens: (s) => {
    const STOP = new Set(['the', 'of', 'and', 'a', 'an', 'in', 'on', 'at', 'registration', 'league', 'leagues', 'basketball', 'annual']);
    return String(s || '').toLowerCase().replace(/\b(19|20)\d{2}\b/g, ' ').replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/).filter(w => w && !STOP.has(w) && !/^\d+(st|nd|rd|th)$/.test(w));
  },
  EMAIL_RE: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
};
const registerReminders = require('./reminders.js');
const { _test } = registerReminders(appStub, deps);
const { pastEditionsOf, renderReminderTemplate, buildReminderHtml, REMINDER_DESIGNS, reminderTemplates } = _test;

test('module registers all reminders routes', () => {
  for (const p of ['/api/admin/reminders/templates', '/api/admin/reminders/audiences', '/api/admin/reminders/send', '/api/admin/reminders/preview', '/api/admin/reminders/history'])
    assert.ok(routes.includes(p), `missing ${p}`);
});

const EVENTS = [
  { id: '1', name: '2026 Alexandria 3 on 3 Basketball League' },
  { id: '2', name: '2025 Alexandria 3 on 3 Basketball League' },
  { id: '3', name: '2024 Alexandria 3 on 3 Basketball League' },
  { id: '4', name: '2025 Jordan 3 on 3 Basketball League' },
  { id: '5', name: '2027 Alexandria 3 on 3 Basketball League' },
];

test('pastEditionsOf: finds earlier same-name editions, newest first', () => {
  const past = pastEditionsOf(EVENTS[0], EVENTS);
  assert.deepEqual(past.map(p => p.id), ['2', '3'], 'only earlier Alexandria years');
});

test('pastEditionsOf: different league never matches; future years excluded', () => {
  const past = pastEditionsOf(EVENTS[0], EVENTS);
  assert.ok(!past.some(p => p.id === '4'), 'Jordan must not match Alexandria');
  assert.ok(!past.some(p => p.id === '5'), '2027 is not a past edition of 2026');
});

test('renderReminderTemplate: fills league-level values, maps per-person to merge tags', () => {
  const tpl = { subject: '{{TARGET_LEAGUE}} open!', body: 'Hi {{FIRST_NAME}}, you played {{PAST_LEAGUE}}. EB {{EB_DATE}}{{EB_PRICE}}, final {{FR_DATE}}. Go: {{REGISTER_URL}}' };
  const ev = { name: '2026 Alexandria 3 on 3 Basketball League' };
  const d = { earlyBird: '2026-08-27', earlyBirdPrice: 285, finalDeadline: '2026-09-09', source: '/leagues/fall/alexandria-league' };
  const { subject, body } = renderReminderTemplate(tpl, ev, d);
  assert.match(subject, /2026 Alexandria/);
  assert.match(body, /\*\|FNAME\|\*/, 'FIRST_NAME becomes Mailchimp merge tag');
  assert.match(body, /\*\|PASTLG\|\*/, 'PAST_LEAGUE becomes Mailchimp merge tag');
  assert.match(body, /August 27, 2026/, 'dates humanized');
  assert.match(body, /\(\$285\/team\)/);
  assert.match(body, /https:\/\/www\.midwest3on3\.com\/leagues\/fall\/alexandria-league/, 'register URL from deadline source');
});

test('renderReminderTemplate: no deadline data degrades gracefully', () => {
  const { body } = renderReminderTemplate({ subject: 's', body: 'EB {{EB_DATE}} at {{REGISTER_URL}}' }, { name: '2026 X League' }, null);
  assert.match(body, /soon/, 'missing date says "soon"');
  assert.match(body, /midwest3on3\.com\/leagues/, 'falls back to the leagues page');
});

test('buildReminderHtml: every design renders CTA link + unsubscribe tag', () => {
  const ev = { name: '2026 Alexandria 3 on 3 Basketball League' };
  const d = { earlyBird: '2026-08-27', finalDeadline: '2026-09-09', source: '/leagues/fall/alexandria-league' };
  for (const design of Object.keys(REMINDER_DESIGNS)) {
    const { html } = buildReminderHtml({ subject: 's', body: 'Hello {{FIRST_NAME}}', design }, ev, d);
    assert.match(html, /alexandria-league/, `${design}: CTA links the league page`);
    assert.match(html, /\*\|UNSUB\|\*/, `${design}: unsubscribe merge tag present`);
  }
});

test('reminderTemplates: seeds 3 defaults when KV is empty-ish', async () => {
  const t = await reminderTemplates();
  assert.ok(t.length >= 3);
  assert.ok(t.every(x => x.subject && x.body));
});
