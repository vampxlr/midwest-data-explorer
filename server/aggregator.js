/**
 * Rate-limited, incremental aggregator with detailed SSE telemetry.
 * Every significant action is broadcast so the UI can show a live terminal.
 */
const store = require('./store');

// ── SSE client registry ────────────────────────────────────────────────────────

const clients = new Set();
function addClient(res)    { clients.add(res); }
function removeClient(res) { clients.delete(res); }

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    try { c.write(payload); } catch { clients.delete(c); }
  }
}

// ── Aggregation state ──────────────────────────────────────────────────────────

const MAX_LOG = 200;

let state = {
  running:      false,
  phase:        'idle',
  current:      0,          // events processed (fetched + skipped)
  total:        0,          // events that need work
  totalEvents:  0,          // all 2025+ events discovered
  cachedClosed: 0,          // closed events skipped (already in store)
  currentId:    null,
  currentName:  '',
  skipped:      0,
  newResults:   0,
  storedResults:0,          // total in store at last check
  errors:       0,
  log:          [],
  startedAt:    null,
  finishedAt:   null,
  lastError:    null,
  currentCall:  null,       // {method, url, startedAt} – the live API call
};

function getState() { return { ...state, connectedClients: clients.size }; }

// ── Logging helper ─────────────────────────────────────────────────────────────

function log(msg, level = 'info', extra = {}) {
  const entry = {
    ts:    new Date().toISOString(),
    tsShort: new Date().toLocaleTimeString('en-US', { hour12: false }),
    msg,
    level,   // info | ok | warn | error | call | response | save | skip | wait
    ...extra,
  };
  state.log = [entry, ...state.log].slice(0, MAX_LOG);
  broadcast('log', entry);
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function extractAnswers(answers) {
  const lower = keys => {
    const k = keys.map(x => x.toLowerCase());
    return a => k.some(kk => (a.name || '').toLowerCase().includes(kk));
  };
  const val = a =>
    a.strValue  !== undefined && a.strValue  !== null ? String(a.strValue)  :
    a.numValue  !== undefined && a.numValue  !== null ? String(a.numValue)  :
    a.arrValue  !== undefined && a.arrValue  !== null
      ? (Array.isArray(a.arrValue) ? a.arrValue[0] : String(a.arrValue))
      : null;

  const gradYears = answers
    .filter(lower(['graduation year', 'grad year']))
    .map(val)
    .filter(v => v && /^\d{4}$/.test(v.trim()))
    .map(v => v.trim());

  if (!gradYears.length) {
    const div = answers.find(lower(['desired division', 'division of play']));
    if (div) { const y = (val(div) || '').replace(/\D/g, ''); if (y.length === 4) gradYears.push(y); }
  }

  const pick = (...keys) => {
    const m = answers.find(lower(keys)); return m ? val(m) : null;
  };

  return {
    gradYears,
    gender: pick('gender of team', 'gender'),
    city:   pick('city')?.trim() || null,
    state:  pick('state/province', 'state')?.trim() || null,
    zip:    pick('zip', 'postal') ? String(pick('zip', 'postal')).trim().slice(0, 5) : null,
  };
}

// ── Main aggregation ───────────────────────────────────────────────────────────

/**
 * filterEvents: array of full event objects {id,name,status,open,close,sport,resultsCompleted}
 *               provided by the client from recentRegs. When non-empty = selective mode.
 * purgeFirst:   wipe stored results for selected events before re-fetching.
 */
async function run(graphqlFn, orgId, delayMs = 1200, filterEvents = [], purgeFirst = false) {
  if (state.running) {
    log('Aggregation already running — ignoring duplicate start', 'warn');
    return;
  }

  const selective = filterEvents.length > 0;
  const db = await store.load();

  state = {
    running: true, phase: selective ? 'fetching' : 'discovering',
    current: 0, total: 0, totalEvents: 0, cachedClosed: 0,
    currentId: null, currentName: '',
    skipped: 0, newResults: 0, storedResults: db.results.length,
    errors: 0, log: [],
    startedAt: new Date().toISOString(), finishedAt: null,
    lastError: null, currentCall: null,
  };
  broadcast('state', getState());

  log(`════════════════════════════════════════════`, 'info');
  log(selective ? ` SELECTIVE AGGREGATION STARTED` : ` MIDWEST 3ON3 AGGREGATION STARTED`, 'ok');
  log(`════════════════════════════════════════════`, 'info');
  log(`Organisation ID : ${orgId}`, 'info');
  log(`Delay between   : ${delayMs}ms`, 'info');
  log(`Store has       : ${db.results.length} saved results`, 'info');

  let toFetch, cachedCount;

  if (selective) {
    // ── SELECTIVE MODE: skip full discovery, use events from client ────────────
    log(`────────────────────────────────────────────`, 'info');
    log(`Mode            : SELECTIVE — ${filterEvents.length} league${filterEvents.length>1?'s':''} chosen`, 'info');
    log(`Purge first     : ${purgeFirst ? 'YES — fresh re-fetch' : 'no — incremental'}`, purgeFirst?'warn':'info');
    log(`────────────────────────────────────────────`, 'info');

    if (purgeFirst) {
      for (const ev of filterEvents) {
        const deleted = store.purgeEvent(db, ev.id);
        log(`  ✓ Purged ${deleted} result${deleted!==1?'s':''} from "${ev.name}"`, deleted>0?'ok':'skip');
      }
      await store.save(db);
      toFetch = filterEvents; // always fetch all after purge
    } else {
      toFetch = store.pendingEvents(db, filterEvents);
    }

    cachedCount = filterEvents.length - toFetch.length;
    state.totalEvents  = filterEvents.length;
    state.cachedClosed = cachedCount;
    state.total        = toFetch.length;
    broadcast('state', getState());

    if (cachedCount > 0) log(`  ${cachedCount} already up-to-date (closed + cached) — skipping`, 'skip');
    log(`  Need to fetch : ${toFetch.length}`, 'info');
    log(`  Est. time     : ~${Math.ceil(toFetch.length * delayMs / 1000)}s`, 'info');

  } else {
    // ── FULL MODE: discover all events ────────────────────────────────────────
    log(`────────────────────────────────────────────`, 'info');
    log(`PHASE 1 — Discovering all registrations`, 'ok');

    let allEvents = [], page = 1, totalAllPages = 1, totalAllCount = 0;
    do {
      state.currentCall = { method:'GraphQL', action:`registrations(page:${page})`, startedAt:Date.now() };
      broadcast('state', getState());
      log(`  → GraphQL: registrations(page:${page}, perPage:100)`, 'call');
      try {
        const t0 = Date.now();
        const d = await graphqlFn(`query($orgId: Int!, $page: Int, $perPage: Int!) {
          registrations(organizationId: $orgId, page: $page, perPage: $perPage) {
            pageInformation { pages count }
            results { id name open close status sport resultsCompleted }
          }
        }`, { orgId: parseInt(orgId), page, perPage: 100 });
        const r = d?.data?.registrations;
        if (!r) break;
        totalAllPages = r.pageInformation?.pages || 1;
        totalAllCount = r.pageInformation?.count || totalAllCount;
        allEvents = allEvents.concat(r.results || []);
        log(`  ← page ${page}/${totalAllPages}: ${r.results?.length || 0} events (${Date.now()-t0}ms) — ${allEvents.length}/${totalAllCount} total`, 'response');
        state.currentCall = null;
      } catch (err) {
        log(`  ✗ Page ${page} failed: ${err.message}`, 'error');
        state.currentCall = null;
        break;
      }
      page++;
      if (page <= totalAllPages) {
        log(`  ⏱ 200ms before next page…`, 'wait');
        await sleep(200);
      }
    } while (page <= totalAllPages);

    log(`  Total events discovered : ${allEvents.length}`, 'ok');

    toFetch     = store.pendingEvents(db, allEvents);
    cachedCount = allEvents.length - toFetch.length;

    state.totalEvents  = allEvents.length;
    state.cachedClosed = cachedCount;
    state.total        = toFetch.length;
    state.phase        = 'fetching';
    broadcast('state', getState());

    log(`────────────────────────────────────────────`, 'info');
    log(` DISCOVERY SUMMARY`, 'ok');
    log(`  Total events               : ${allEvents.length}`, 'info');
    log(`  Already cached (skipping)  : ${cachedCount}`, 'skip');
    log(`  Need to fetch              : ${toFetch.length}`, 'info');
    log(`  Stored results so far      : ${db.results.length}`, 'info');
    log(`  Est. time                  : ~${Math.ceil(toFetch.length * delayMs / 1000)}s at ${delayMs}ms/event`, 'info');
  }

  log(`────────────────────────────────────────────`, 'info');
  log(`PHASE 2 — Fetching registration results`, 'ok');
  log(`  (${delayMs}ms delay between each event to respect API rate limits)`, 'info');

  // ── PHASE 2: Fetch event by event ─────────────────────────────────────────

  for (let i = 0; i < toFetch.length; i++) {
    const ev = toFetch[i];
    state.currentId   = ev.id;
    state.currentName = ev.name;
    broadcast('state', getState());

    const eventNum = `[${i + 1}/${toFetch.length}]`;
    log(`────────────────────────────────────────────`, 'info');
    log(`${eventNum} Event: "${ev.name}"`, 'info');
    log(`         ID: ${ev.id} | Status: ${ev.status === 1 ? 'OPEN' : 'CLOSED'} | Completions: ${ev.resultsCompleted ?? '?'}`, 'info');

    const PER_PAGE = 25;

    // ── Count-based skip / incremental-fetch optimisation ──────────────────
    // Compare the API's current resultsCompleted with what we stored last time.
    // Closed events are never in toFetch (pendingEvents filters them out), so
    // this only runs for open events and explicit selective runs.
    const storedEvent      = db.events[String(ev.id)];
    const storedCompleted  = storedEvent?.resultsCompleted ?? null;   // stored last run
    const currentCompleted = ev.resultsCompleted ?? 0;                // from discovery

    // Zero completions — skip (but never in selective mode)
    if (!selective && currentCompleted === 0) {
      log(`${eventNum} ↷ SKIP — 0 completions reported`, 'skip');
      store.upsertEventMeta(db, ev, { fetchedAt: new Date().toISOString(), resultCount: 0, resultsCompleted: 0 });
      await store.save(db);
      state.current++;
      state.skipped++;
      broadcast('progress', { current: state.current, total: state.total, eventId: ev.id, name: ev.name, added: 0, skipped: true });
      continue;
    }

    // Count unchanged — nothing new to fetch
    if (!selective && storedCompleted !== null && currentCompleted === storedCompleted) {
      log(`${eventNum} ↷ SKIP — count unchanged (${currentCompleted} completions, already up-to-date)`, 'skip');
      store.upsertEventMeta(db, ev, {
        fetchedAt:        new Date().toISOString(),
        resultCount:      storedEvent.resultCount || storedCompleted,
        resultsCompleted: currentCompleted,
      });
      await store.save(db);
      state.current++;
      state.skipped++;
      broadcast('progress', { current: state.current, total: state.total, eventId: ev.id, name: ev.name, added: 0, skipped: true });
      continue;
    }

    // Incremental fetch — count increased, only fetch the new pages
    // storedCount is how many results we already have on disk.
    // New records appear on pages after floor(storedCount / PER_PAGE).
    // We start one page earlier to catch any edge-case stragglers, and
    // upsertResults deduplicates anything we already have.
    const storedCount = storedEvent?.resultCount || 0;
    const startPage   = (!selective && storedCompleted !== null && currentCompleted > storedCompleted && storedCount > 0)
      ? Math.max(1, Math.floor(storedCount / PER_PAGE))   // one page back to be safe
      : 1;

    if (startPage > 1) {
      log(`${eventNum} ↑ Incremental: ${storedCompleted} → ${currentCompleted} completions — skipping to page ${startPage}`, 'info');
    }

    // Attempt fetch with retries — paginate through registrationResults
    const ANSWERS_QUERY_AGG = `query($regId:ID!,$orgId:Int!,$page:Int,$perPage:Int!){
      registration(id:$regId,organizationId:$orgId){
        id name resultsCompleted
        registrationResults(page:$page,perPage:$perPage){
          id profileId completed status created
          answers{
            name
            ...on StringRegistrationResultAnswer{strValue:value}
            ...on NumberRegistrationResultAnswer{numValue:value}
            ...on ArrayRegistrationResultAnswer{arrValue:value}
          }
        }
      }
    }`;

    let regData = null;
    let retries = 0;
    while (retries < 3 && !regData) {
      const t0 = Date.now();
      state.currentCall = {
        method: 'GraphQL',
        action: `registration(id:"${ev.id}", organizationId:${orgId}) [paginated]`,
        startedAt: t0,
      };
      broadcast('state', getState());

      const attempt = retries > 0 ? ` (retry ${retries}/3)` : '';
      log(`${eventNum} → GraphQL: registration(id:"${ev.id}")${startPage > 1 ? ` [incremental, page ${startPage}+]` : ''}${attempt}`, 'call');

      try {
        let allResults = [], regMeta = null, page = startPage;
        do {
          const d = await graphqlFn(ANSWERS_QUERY_AGG, { regId: ev.id, orgId: parseInt(orgId), page, perPage: PER_PAGE });
          const r = d?.data?.registration;
          if (!r) break;
          regMeta = r;
          const batch = r.registrationResults || [];
          allResults = allResults.concat(batch);
          const pct = r.resultsCompleted > 0 ? Math.round((storedCount + allResults.length) / r.resultsCompleted * 100) : '?';
          log(`${eventNum}   page ${page}: +${batch.length} results (${storedCount + allResults.length}/${r.resultsCompleted} — ${pct}%)`, 'response');
          if (batch.length < PER_PAGE) break;
          page++;
          await sleep(300);
        } while (true);

        if (regMeta) {
          regData = { ...regMeta, registrationResults: allResults };
          const elapsed = Date.now() - t0;
          log(`${eventNum} ← Done (${elapsed}ms) — fetched ${allResults.length} result(s) from page ${startPage}+ (resultsCompleted: ${regMeta.resultsCompleted})`, 'response');
        }
      } catch (err) {
        const elapsed = Date.now() - t0;
        retries++;
        const waitMs = 2000 * retries;
        state.errors++;
        log(`${eventNum} ✗ Request FAILED (${elapsed}ms): ${err.message}`, 'error');
        if (retries < 3) {
          log(`${eventNum} ⏱ Backing off ${waitMs}ms before retry ${retries}/3…`, 'wait');
          state.currentCall = null;
          broadcast('state', getState());
          await sleep(waitMs);
        }
      }
    }

    state.currentCall = null;
    broadcast('state', getState());

    if (!regData) {
      log(`${eventNum} ✗ GIVING UP after 3 retries — event skipped`, 'error');
      state.current++;
      broadcast('progress', { current: state.current, total: state.total, eventId: ev.id, name: ev.name, added: 0, error: true });
      if (i < toFetch.length - 1) {
        log(`${eventNum} ⏱ Waiting ${delayMs}ms…`, 'wait');
        await sleep(delayMs);
      }
      continue;
    }

    // Parse & save
    const rawResults = regData.registrationResults || [];
    log(`${eventNum} Processing ${rawResults.length} results…`, 'info');

    const compact = rawResults.map(r => {
      const parsed = extractAnswers(r.answers || []);
      return { id: r.id, eventId: ev.id, eventName: ev.name, created: r.created || null, completed: r.completed, ...parsed };
    });

    const added     = store.upsertResults(db, ev.id, ev.name, compact);
    const duplicate = rawResults.length - added;

    store.upsertEventMeta(db, ev, {
      fetchedAt:        new Date().toISOString(),
      // resultCount = total records now in store (existing + newly added)
      resultCount:      storedCount + added,
      // resultsCompleted from the API — used for count-change detection next run
      resultsCompleted: regData.resultsCompleted ?? currentCompleted,
    });
    await store.save(db);

    state.current++;
    state.newResults   += added;
    state.storedResults = db.results.length;

    if (added > 0) {
      log(`${eventNum} ✓ SAVED ${added} new results  (${duplicate} already in store, ${duplicate + added} total for this event)`, 'ok');
    } else {
      log(`${eventNum} ✓ No new results — all ${duplicate} already in store`, 'skip');
    }

    broadcast('progress', {
      current: state.current, total: state.total,
      eventId: ev.id, name: ev.name,
      added, duplicate, totalStored: db.results.length,
    });

    // Rate-limit delay (skip after last event)
    if (i < toFetch.length - 1) {
      log(`${eventNum} ⏱ Rate-limit delay: ${delayMs}ms before next request…`, 'wait');
      await sleep(delayMs);
    }
  }

  // ── DONE ────────────────────────────────────────────────────────────────────

  db.meta.lastRunAt     = new Date().toISOString();
  db.meta.totalResults  = db.results.length;
  await store.save(db);

  state.running     = false;
  state.phase       = 'done';
  state.finishedAt  = new Date().toISOString();
  state.currentCall = null;
  broadcast('state', getState());

  const elapsed = Math.round((Date.now() - new Date(state.startedAt).getTime()) / 1000);
  log(`════════════════════════════════════════════`, 'info');
  log(` AGGREGATION COMPLETE`, 'ok');
  log(`════════════════════════════════════════════`, 'info');
  log(`  New results saved   : ${state.newResults}`, 'ok');
  log(`  Total in store      : ${db.results.length}`, 'ok');
  log(`  Events fetched      : ${state.current}`, 'ok');
  log(`  Events skipped      : ${state.skipped}  (closed + already cached)`, 'info');
  log(`  Errors              : ${state.errors}`, state.errors > 0 ? 'error' : 'info');
  log(`  Time elapsed        : ${elapsed}s`, 'info');

  broadcast('complete', {
    newResults:     state.newResults,
    total:          db.results.length,
    eventsProcessed:state.current,
    skipped:        state.skipped,
    errors:         state.errors,
    elapsedSec:     elapsed,
  });
}

module.exports = { run, addClient, removeClient, getState, broadcast, log, extractAnswers };
