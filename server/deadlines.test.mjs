/**
 * Unit tests for the deadline scraper's pure logic: HTML page parsing
 * (dates + prices), event-name token matching, and htmlToText. Run: npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
delete process.env.CONVEX_URL;

const routes = [];
const appStub = { get: (p) => routes.push(p), post: (p) => routes.push(p), put: (p) => routes.push(p) };
const registerDeadlines = require('./deadlines.js');
const { _test, scrapeTokens: exportedTokens } = registerDeadlines(appStub);
const { parsePage, scrapeTokens, matchScrapedEvents, htmlToText } = _test;

test('module registers all deadline routes and exports helpers', () => {
  for (const p of ['/api/admin/scrape-deadlines', '/api/deadlines', '/api/deadlines-coverage', '/api/deadlines/import', '/api/deadlines/:eventId'])
    assert.ok(routes.includes(p), `missing ${p}`);
  assert.equal(typeof exportedTokens, 'function');
});

test('scrapeTokens: strips years/stopwords, keeps distinctive words + session numbers', () => {
  const t = scrapeTokens('2026 Alexandria 3 on 3 Basketball League Session 1');
  assert.ok(t.includes('alexandria') && t.includes('session') && t.includes('1'));
  assert.ok(!t.includes('2026') && !t.includes('basketball') && !t.includes('league') && !t.includes('on'));
});

test('parsePage: extracts early-bird and final deadlines with prices (site wording)', () => {
  const html = `<html><head><title>Alexandria League — Midwest 3 on 3</title></head><body>
    <h1>2026 Alexandria 3 on 3 Basketball League</h1>
    <p>EARLY BIRD Registration ends at midnight on Wednesday, August 27</p>
    <p>Cost: $285/team (No spectator admission fees)</p>
    <p>FINAL Registration ends at midnight on Wednesday, September 9</p>
    <p>Cost: $300/team</p></body></html>`;
  const p = parsePage(html);
  assert.ok(p.earlyBird?.endsWith('-08-27'), `earlyBird parsed: ${p.earlyBird}`);
  assert.ok(p.finalDeadline?.endsWith('-09-09'), `final parsed: ${p.finalDeadline}`);
  assert.equal(p.earlyBirdPrice, 285);
  assert.equal(p.finalPrice, 300);
});

test('parsePage: page without deadlines yields no dates', () => {
  const p = parsePage('<html><head><title>About us</title></head><body>We love hoops.</body></html>');
  assert.ok(!p.earlyBird && !p.finalDeadline);
});

test('matchScrapedEvents: matches the right league and year, best score wins', () => {
  const events = [
    { id: 1, name: '2026 Alexandria 3 on 3 Basketball League' },
    { id: 2, name: '2026 Jordan 3 on 3 Basketball League' },
    { id: 3, name: '2025 Alexandria 3 on 3 Basketball League' },
  ];
  const hits = matchScrapedEvents({ title: 'Alexandria League', year: '2026' }, events);
  assert.deepEqual(hits.map(h => h.ev.id), [1], 'only 2026 Alexandria');
});

test('matchScrapedEvents: unrelated page title matches nothing', () => {
  const events = [{ id: 1, name: '2026 Alexandria 3 on 3 Basketball League' }];
  assert.equal(matchScrapedEvents({ title: 'Frequently Asked Questions' }, events).length, 0);
});

test('htmlToText: strips tags and scripts', () => {
  const t = htmlToText('<div><script>var x=1;</script><p>Hello <b>world</b></p></div>');
  assert.match(t, /Hello\s+world/);
  assert.ok(!t.includes('var x'));
});
