/**
 * Unit tests for Sarah's pure answer logic (matching, intents) via the
 * module's _test exports. No HTTP, no Convex — a stub app collects routes.
 * Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
delete process.env.CONVEX_URL; // local mode

// stub Express app: records registrations, never serves
const routes = [];
const appStub = { get: (p) => routes.push(['GET', p]), post: (p) => routes.push(['POST', p]), put: (p) => routes.push(['PUT', p]) };
const deps = {
  encryptSecret: (x) => x, decryptSecret: (x) => x,
  capiSend: async () => {}, sendEmail: async () => false,
  EMAIL_RE: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  htmlToText: (h) => String(h), fetchSitePage: async () => '', SITE_BASE: 'https://www.midwest3on3.com',
};
const registerAssistant = require('./assistant.js');
const { _test } = registerAssistant(appStub, deps);
const { matchFaq, faqTokens, builtinAnswer, faqEventMention } = _test;

const S = { greeting: 'Hi! I am Sarah.', name: 'Sarah' };
const OPEN = [
  { name: '2026 Andover 3 on 3 Basketball League', d: { earlyBird: '2026-08-20', earlyBirdPrice: 285, finalDeadline: '2026-09-02', finalPrice: 300 } },
  { name: '2026 Jordan 3 on 3 Basketball League', d: { earlyBird: '2026-08-27', finalDeadline: '2026-09-09' } },
];

test('module registers Sarah routes on the app', () => {
  const paths = routes.map(([, p]) => p);
  for (const p of ['/api/assistant/chat', '/api/widget.js', '/api/messenger/webhook', '/api/admin/assistant'])
    assert.ok(paths.includes(p), `missing route ${p}`);
});

test('builtin: bare greeting returns the configured greeting', () => {
  assert.equal(builtinAnswer('hi', S, OPEN), S.greeting);
  assert.equal(builtinAnswer('Hello!', S, OPEN), S.greeting);
});

test('builtin: greeting words inside a real question do NOT hijack it', () => {
  assert.notEqual(builtinAnswer('hi can you tell me the andover deadline', S, OPEN), S.greeting);
});

test('builtin: email in message is acknowledged as a lead', () => {
  const r = builtinAnswer('my email is parent@example.com', S, OPEN);
  assert.match(r, /parent@example\.com/);
});

test('builtin: league mention answers with live, human-readable deadlines', () => {
  const r = builtinAnswer('jordan league details?', S, OPEN);
  assert.match(r, /Jordan/);
  assert.match(r, /September 9/, `dates must be humanized, got: ${r}`);
  assert.doesNotMatch(r, /2026-09-09/, 'no ISO dates in visitor-facing answers');
});

test('builtin: open-leagues intent lists open leagues (typo tolerated)', () => {
  const r = builtinAnswer('is there any openning for registration ? i mean leagues?', S, OPEN);
  assert.match(r, /Andover/);
  assert.match(r, /Jordan/);
});

test('builtin: unknown question returns null (falls through to FAQ/LLM)', () => {
  assert.equal(builtinAnswer('do referees call carrying strictly?', S, OPEN), null);
});

test('faqEventMention: generic season words do not match events', () => {
  const open = [{ name: '2026 Prior Lake Summer 3 on 3 Basketball League', d: {} }];
  assert.equal(faqEventMention('what do you do in summer?', open).length, 0);
  assert.equal(faqEventMention('prior lake info please', open).length, 1);
});

test('matchFaq: paraphrases match, unrelated questions do not', () => {
  // Contract: needs >=2 significant overlapping tokens (or an exact tiny
  // match) — which is why the FAQ generator writes 4-8 alts per question.
  const bank = [{ q: 'Are there practices?', alts: ['do you have weekly practices', 'practice schedule commitment'], a: 'No practices!' }];
  assert.equal(matchFaq(bank, 'do you have weekly practices during the season?')?.a, 'No practices!');
  assert.equal(matchFaq(bank, 'what shirt colors exist?'), null);
  // a single-word question fully contained in a paraphrase DOES match
  // (that's how bare "cost?" style questions hit the bank)
  assert.equal(matchFaq(bank, 'practices?')?.a, 'No practices!');
  // …but an unrelated single word does not
  assert.equal(matchFaq(bank, 'shirts?'), null);
});

test('faqTokens: stopwords removed, short words dropped', () => {
  const t = faqTokens('What are the leagues about?');
  assert.ok(!t.includes('the') && !t.includes('what') && !t.includes('leagues'));
});
