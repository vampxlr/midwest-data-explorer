/**
 * DEADLINES — early-bird/final registration dates (see DEVELOPERS.md §1).
 * Scrapes midwest3on3.com league/tournament/camp pages, parses deadline +
 * price info, matches pages to SportsEngine events by name tokens (each
 * event keeps its BEST-scoring page; manual overrides always win), and
 * serves the deadlines CRUD + coverage + import/export.
 *
 * Registered by index.js via registerDeadlines(app). Returns the shared
 * site-scrape helpers (scrapeTokens/htmlToText/fetchSitePage/SITE_BASE)
 * consumed by the assistant and reminders modules. Code moved VERBATIM
 * (refactor step 4, DEVELOPERS.md §9).
 */

const axios = require('axios');
const auth = require('./auth');
const store = require('./store');
const { kvGet, kvSet } = require('./kv');

module.exports = function registerDeadlines(app) {

// ── Deadline scraper — midwest3on3.com early-bird/final registration dates ────
// Scrapes /leagues, /tournaments, /camps subpages for deadline + price info,
// matches each page to a SportsEngine event by name/year, and stores the lot
// as one KV blob. Manual overrides via PUT /api/deadlines/:eventId.

const SITE_BASE = 'https://www.midwest3on3.com';
const MONTHS = { january:1, february:2, march:3, april:4, may:5, june:6, july:7, august:8, september:9, october:10, november:11, december:12 };

function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');
}

// "midnight on Thursday, July 23" + a year → "2026-07-23"
function parseDeadlineDate(text, year) {
  const m = text.match(/(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})/i);
  if (!m || !year) return null;
  const mo = MONTHS[m[1].toLowerCase()], day = parseInt(m[2]);
  return `${year}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parsePage(html) {
  const text = htmlToText(html);
  // Title may contain periods ("St. Michael") — don't stop at sentence ends
  const title = (text.match(/\b(20\d{2})\b.{0,90}?\b(league|tournament|camp|clinic)\b/i) || [])[0] || null;
  const year  = title ? (title.match(/\b(20\d{2})\b/) || [])[1] : (text.match(/\b(20\d{2})\b/) || [])[1];

  // The site mixes two formats:
  //   "EARLY BIRD Registration ends at midnight on Thursday, July 23 … $285"
  //   "Early Bird - Ends at midnight Wednesday, July 22 $105 per team"
  //   "Registration - Ends at midnight Wednesday, August 5 $125 per team"
  // Walk every "ends at midnight" sentence; its prefix decides EB vs final.
  let earlyBird = null, finalDeadline = null, earlyBirdPrice = null, finalPrice = null;
  for (const m of text.matchAll(/.{0,45}ends\s+at\s+midnight.{0,60}/gi)) {
    const sentence = m[0];
    const midnightAt = sentence.toLowerCase().indexOf('midnight');
    const date = parseDeadlineDate(sentence.slice(midnightAt), year);
    if (!date) continue;
    // Price search starts AT the deadline (not the sentence prefix), so a
    // "$12/each t-shirt" mention just before doesn't win over "$125 per team"
    const priceM = text.slice(m.index + midnightAt, m.index + midnightAt + 200).match(/\$\s?(\d{2,4})/);
    const price = priceM ? parseInt(priceM[1]) : null;
    if (/early\s*bird/i.test(sentence)) {
      if (!earlyBird) { earlyBird = date; earlyBirdPrice = price; }
    } else if (!finalDeadline) {
      finalDeadline = date; finalPrice = price;
    }
  }
  return { title, year: year || null, earlyBird, finalDeadline, earlyBirdPrice, finalPrice };
}

// Scraped page title → SE event (same year, best token overlap)
const SCRAPE_STOP = new Set(['the','of','and','a','an','in','on','at','registration','league','leagues','basketball','annual']);
function scrapeTokens(n) {
  // Keep bare numbers — "Session 1" vs "Session 2" must not collapse
  return String(n || '').toLowerCase().replace(/\b(19|20)\d{2}\b/g, ' ').replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(w => w && !SCRAPE_STOP.has(w) && !/^\d+(st|nd|rd|th)$/.test(w));
}
// Returns ALL events tied at the best score — SportsEngine sometimes has
// duplicate events for the same league, and both deserve the deadlines.
function matchScrapedEvents(parsed, events) {
  if (!parsed.title) return [];
  const tA = new Set(scrapeTokens(parsed.title));
  let bs = 0;
  const scored = [];
  for (const ev of events) {
    const evYear = ((ev.name || '').match(/\b(20\d{2})\b/) || [])[1] || String(ev.close || ev.open || '').slice(0, 4);
    if (parsed.year && evYear !== parsed.year) continue;
    const tB = new Set(scrapeTokens(ev.name));
    let inter = 0; for (const t of tA) if (tB.has(t)) inter++;
    const s = inter / (new Set([...tA, ...tB]).size || 1);
    scored.push({ ev, s });
    if (s > bs) bs = s;
  }
  return bs >= 0.3 ? scored.filter(x => x.s >= bs - 0.001) : [];
}

async function fetchSitePage(url) {
  const r = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MW3-DataExplorer)' }, timeout: 15000 });
  return r.data;
}

app.post('/api/admin/scrape-deadlines', auth.requireRole('admin'), async (req, res) => {
  try {
    const listingPaths = ['/leagues', '/tournaments', '/camps'];
    const subpages = new Set();
    for (const p of listingPaths) {
      try {
        const html = await fetchSitePage(SITE_BASE + p);
        for (const m of String(html).matchAll(/href="([^"]+)"/gi)) {
          // Normalize the three formats the site mixes: absolute URLs,
          // /rooted paths, and hrefs missing the leading slash.
          let path = m[1].replace(/^https?:\/\/(www\.)?midwest3on3\.com/i, '');
          if (/^https?:/i.test(path)) continue;              // external site
          if (!path.startsWith('/')) path = '/' + path;
          path = path.split(/[#?]/)[0].replace(/\/$/, '');
          if (!path || listingPaths.includes(path)) continue;
          if (/^\/(leagues|tournaments|camps)\//.test(path) || /(league|tournament|camp|clinic)/.test(path)) {
            if (!/start-a-new/.test(path)) subpages.add(path);
          }
        }
      } catch (e) { console.warn('[scrape] listing failed:', p, e.message); }
    }

    const db = await store.load();
    const events = Object.values(db.events);
    const results = [];
    const paths = [...subpages];
    for (let i = 0; i < paths.length; i += 5) {
      const batch = await Promise.all(paths.slice(i, i + 5).map(async (path) => {
        try { return { path, ...parsePage(await fetchSitePage(SITE_BASE + path)) }; }
        catch { return { path, error: true }; }
      }));
      results.push(...batch);
    }

    const existing = (await kvGet('deadlines:all')) || {};
    // Two-pass: an event keeps only its BEST-scoring page. Last-writer-wins
    // let a weak generic match (Orono fall page → Wayzata event) overwrite a
    // strong correct one (Wayzata summer page) just by scrape order.
    const best = {};
    for (const r of results) {
      if (r.error || (!r.earlyBird && !r.finalDeadline)) continue;
      for (const { ev, s } of matchScrapedEvents(r, events)) {
        const id = String(ev.id);
        if (!best[id] || s > best[id].s) best[id] = { ev, r, s };
      }
    }
    let matched = 0;
    for (const [id, { ev, r }] of Object.entries(best)) {
      // Manual overrides always win — but only once they actually HOLD a
      // date. An empty stub from "+ Add manually" (nobody filled it in yet)
      // must not block the scraper from finding real data forever.
      if (existing[id]?.manual && (existing[id].earlyBird || existing[id].finalDeadline)) continue;
      existing[id] = {
        eventName: ev.name,
        earlyBird: r.earlyBird, finalDeadline: r.finalDeadline,
        earlyBirdPrice: r.earlyBirdPrice, finalPrice: r.finalPrice,
        source: r.path, scrapedAt: new Date().toISOString(),
      };
      matched++;
    }
    await kvSet('deadlines:all', existing);
    res.json({
      pagesScanned: paths.length, matched,
      withDeadlines: results.filter(r => r.earlyBird || r.finalDeadline).length,
      unmatched: results.filter(r => (r.earlyBird || r.finalDeadline) && matchScrapedEvents(r, events).length === 0).map(r => r.title || r.path),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/deadlines', async (req, res) => {
  res.json({ deadlines: (await kvGet('deadlines:all')) || {} });
});

// Coverage: which of this year's events have deadlines vs still missing
app.get('/api/deadlines-coverage', async (req, res) => {
  const year = req.query.year || String(new Date().getFullYear());
  try {
    const db = await store.load();
    const all = (await kvGet('deadlines:all')) || {};
    const yearOf = ev => ((ev.name || '').match(/\b(20\d{2})\b/) || [])[1] || String(ev.close || ev.open || '').slice(0, 4);
    const events = Object.values(db.events)
      .filter(ev => yearOf(ev) === String(year))
      .map(ev => {
        const d = all[String(ev.id)];
        return { id: String(ev.id), name: ev.name, has: !!(d && (d.earlyBird || d.finalDeadline)) };
      })
      .sort((a, b) => Number(a.has) - Number(b.has) || a.name.localeCompare(b.name));
    res.json({ year, total: events.length, covered: events.filter(e => e.has).length, events });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Export every deadline as a portable JSON file (e.g. move local → production)
app.get('/api/deadlines/export', auth.requireRole('admin'), async (req, res) => {
  const all = (await kvGet('deadlines:all')) || {};
  res.setHeader('Content-Disposition', `attachment; filename="deadlines-${new Date().toISOString().slice(0, 10)}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify({ kind: 'mw3-deadlines', exportedAt: new Date().toISOString(), count: Object.keys(all).length, deadlines: all }, null, 2));
});

// Import a previously exported file. mode=merge (default) keeps existing
// entries not present in the file; mode=replace swaps the whole set.
app.post('/api/deadlines/import', auth.requireRole('admin'), async (req, res) => {
  const body = req.body || {};
  const incoming = body.deadlines || (body.kind === 'mw3-deadlines' ? body.deadlines : null);
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return res.status(400).json({ error: 'Not a deadlines export file (missing "deadlines" object)' });
  }
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const clean = {};
  let skipped = 0;
  for (const [id, v] of Object.entries(incoming)) {
    if (!/^\d+$/.test(id) || typeof v !== 'object' || !v) { skipped++; continue; }
    const eb = v.earlyBird && DATE.test(v.earlyBird) ? v.earlyBird : null;
    const fr = v.finalDeadline && DATE.test(v.finalDeadline) ? v.finalDeadline : null;
    if (!eb && !fr) { skipped++; continue; }
    clean[id] = {
      eventName: v.eventName || undefined,
      earlyBird: eb, finalDeadline: fr,
      earlyBirdPrice: Number.isFinite(v.earlyBirdPrice) ? v.earlyBirdPrice : null,
      finalPrice: Number.isFinite(v.finalPrice) ? v.finalPrice : null,
      manual: !!v.manual, source: v.source || undefined,
      importedAt: new Date().toISOString(),
    };
  }
  const existing = body.mode === 'replace' ? {} : ((await kvGet('deadlines:all')) || {});
  const merged = { ...existing, ...clean };
  await kvSet('deadlines:all', merged);
  res.json({ ok: true, imported: Object.keys(clean).length, skipped, total: Object.keys(merged).length, mode: body.mode === 'replace' ? 'replace' : 'merge' });
});

app.put('/api/deadlines/:eventId', auth.requireRole('admin'), async (req, res) => {
  const { earlyBird, finalDeadline, earlyBirdPrice, finalPrice, eventName, source } = req.body || {};
  const all = (await kvGet('deadlines:all')) || {};
  all[String(req.params.eventId)] = {
    ...(all[String(req.params.eventId)] || {}),
    eventName: eventName || all[String(req.params.eventId)]?.eventName,
    earlyBird: earlyBird || null, finalDeadline: finalDeadline || null,
    earlyBirdPrice: earlyBirdPrice ?? null, finalPrice: finalPrice ?? null,
    source: source !== undefined ? (String(source).trim() || null) : (all[String(req.params.eventId)]?.source ?? null),
    manual: true, updatedAt: new Date().toISOString(),
  };
  await kvSet('deadlines:all', all);
  res.json({ ok: true });
});


  return {
    scrapeTokens, htmlToText, fetchSitePage, SITE_BASE,
    _test: { parsePage, scrapeTokens, matchScrapedEvents, htmlToText },
  };
};
