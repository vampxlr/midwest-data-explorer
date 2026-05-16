/**
 * Contact store — persists registrant contact details (email, name, phone, location).
 * All I/O is ASYNC via blobStorage (fs locally, Vercel Blob in prod).
 */
const blobStorage = require('./blobStorage');

const STORE_FILE = 'contacts.json';

function emptyStore() {
  return {
    meta: { lastUpdatedAt: null, totalContacts: 0 },
    events:   {},   // eventId → { id, name, status, fetchedAt, contactCount, resultsCompleted }
    contacts: [],
  };
}

async function load() {
  const data = await blobStorage.readJSON(STORE_FILE, null);
  return data || emptyStore();
}

async function save(db) {
  db.meta.totalContacts = db.contacts.length;
  await blobStorage.writeJSON(STORE_FILE, db);
}

function pendingEvents(db, allEvents) {
  return allEvents.filter(ev => {
    const saved = db.events[String(ev.id)];
    if (!saved) return true;
    if (ev.status === 1) return true; // open → may have new registrations
    return false;
  });
}

function upsertContacts(db, ev, contacts) {
  const eid = String(ev.id);
  db.contacts = db.contacts.filter(c => String(c.eventId) !== eid);
  const now = new Date().toISOString();
  for (const c of contacts) {
    db.contacts.push({
      resultId:         c.resultId,
      eventId:          eid,
      eventName:        ev.name,
      email:            c.email     || '',
      phone:            c.phone     || '',
      firstName:        c.firstName || '',
      lastName:         c.lastName  || '',
      zip:              c.zip       || '',
      city:             c.city      || '',
      state:            c.state     || '',
      gender:           c.gender    || '',
      gradYears:        c.gradYears || [],
      fetchedAt:        now,
    });
  }
  db.events[eid] = {
    id:               eid,
    name:             ev.name,
    status:           ev.status,
    fetchedAt:        new Date().toISOString(),
    contactCount:     contacts.length,
    resultsCompleted: ev.resultsCompleted ?? null,
  };
  db.meta.totalContacts  = db.contacts.length;
  db.meta.lastUpdatedAt  = new Date().toISOString();
  return contacts.length;
}

function purgeEvent(db, eventId) {
  const eid    = String(eventId);
  const before = db.contacts.length;
  db.contacts  = db.contacts.filter(c => String(c.eventId) !== eid);
  delete db.events[eid];
  db.meta.totalContacts = db.contacts.length;
  return before - db.contacts.length;
}

function filterContacts(db, { eventIds, gradYearFrom, gradYearTo, genders } = {}) {
  const eidSet    = eventIds ? new Set(eventIds.map(String)) : null;
  const genderSet = genders  ? new Set(genders.map(s => s.toLowerCase())) : null;
  return db.contacts.filter(c => {
    if (eidSet && !eidSet.has(String(c.eventId))) return false;
    if (gradYearFrom || gradYearTo) {
      const matching = (c.gradYears || []).filter(y => {
        if (gradYearFrom && y < gradYearFrom) return false;
        if (gradYearTo   && y > gradYearTo)   return false;
        return true;
      });
      if (!matching.length) return false;
    }
    if (genderSet) {
      const lc = (c.gender || '').toLowerCase();
      if (![...genderSet].some(g => lc.includes(g))) return false;
    }
    return true;
  });
}

function summarise(contacts) {
  const gyMap = {}, geMap = {};
  for (const c of contacts) {
    const g = c.gender?.trim(); if (g) geMap[g] = (geMap[g] || 0) + 1;
    for (const gy of (c.gradYears || [])) {
      if (/^\d{4}$/.test(gy)) gyMap[gy] = (gyMap[gy] || 0) + 1;
    }
  }
  const toArr = m => Object.entries(m).map(([name,count])=>({name,count})).sort((a,b)=>b.count-a.count);
  return {
    total:          contacts.length,
    withEmail:      contacts.filter(c => c.email).length,
    graduationYear: Object.entries(gyMap).map(([name,count])=>({name,count})).sort((a,b)=>a.name.localeCompare(b.name)),
    gender:         toArr(geMap),
  };
}

module.exports = { load, save, emptyStore, pendingEvents, upsertContacts, purgeEvent, filterContacts, summarise };
