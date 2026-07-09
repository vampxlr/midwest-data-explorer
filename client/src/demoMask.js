/**
 * Demo / stream mode — masks sensitive data for screen-recording client demos.
 *
 * Applied centrally in the axios response interceptor (api.jsx) and on the
 * boot-stream payload (App.jsx), so every page is covered without touching
 * individual components.
 *
 * Rules:
 *  - Event/league names: keep years, numbers, ordinals and generic sport words
 *    ("league", "tournament", "spring"…), blip everything else:
 *      "2026 Wayzata Spring League" → "2026 ******* Spring League"
 *  - Emails: keep first letter + domain:  john.doe@gmail.com → j*****@gmail.com
 *  - Phones: keep last two digits:        (612) 555-1234 → (***) ***-**34
 *  - Person names: first letter + stars:  Kamrul → K*****
 *  - City partially masked, zip keeps first two digits.
 */

const DEMO_KEY = 'mw3-demo-mode';

export function isDemoMode() {
  try { return localStorage.getItem(DEMO_KEY) === '1'; } catch { return false; }
}

export function setDemoMode(on) {
  try {
    if (on) localStorage.setItem(DEMO_KEY, '1');
    else localStorage.removeItem(DEMO_KEY);
  } catch {}
}

// Words that stay readable in event names — generic terms that don't identify
// the organization or location.
const KEEP_WORDS = new Set([
  'league', 'leagues', 'tournament', 'tourney', 'camp', 'camps', 'clinic',
  'session', 'sessions', 'basketball', 'spring', 'summer', 'fall', 'winter',
  'annual', 'boys', 'girls', 'grade', 'play', 'game', 'gameplay', 'skills',
  'shooting', 'scoring', 'training', 'academy', 'development', 'registration',
  'advanced', 'footwork', 'finishing', 'boot', 'day', 'post', 'waitlist',
  'august', 'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'september', 'october', 'november', 'december', 'thanksgiving', 'mea',
  'the', 'of', 'and', 'in', 'on', 'at', 'vs', 'v', 'a', 'an', 'or',
]);

export function maskEventName(v) {
  if (!v || typeof v !== 'string') return v;
  return v.split(/\s+/).map(w => {
    const bare = w.replace(/[^a-z0-9]/gi, '');
    if (!bare) return w;
    if (/^\d+(st|nd|rd|th)?$/i.test(bare)) return w;             // years, numbers, ordinals
    if (/^\d+v\d+$/i.test(bare) || /^\d+on\d+$/i.test(bare)) return w; // 3v3 / 3on3
    if (KEEP_WORDS.has(bare.toLowerCase())) return w;
    return '*'.repeat(Math.min(Math.max(w.length, 3), 8));
  }).join(' ');
}

export function maskEmail(v) {
  if (!v || typeof v !== 'string' || !v.includes('@')) return v;
  const [local, domain] = v.split('@');
  return `${(local[0] || '*')}${'*'.repeat(Math.min(Math.max(local.length - 1, 2), 6))}@${domain}`;
}

export function maskPhone(v) {
  if (!v) return v;
  const s = String(v);
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7) return s;
  let seen = 0, keepFrom = digits.length - 2;
  return s.replace(/\d/g, () => (seen++ >= keepFrom ? digits[seen - 1] : '*'));
}

export function maskPersonName(v) {
  if (!v || typeof v !== 'string') return v;
  return v.split(/\s+/).map(w =>
    w.length <= 1 ? w : `${w[0]}${'*'.repeat(Math.min(w.length - 1, 6))}`
  ).join(' ');
}

function maskCity(v) {
  if (!v || typeof v !== 'string') return v;
  return `${v[0] || '*'}${'*'.repeat(Math.min(Math.max(v.length - 1, 2), 8))}`;
}

function maskZip(v) {
  if (!v) return v;
  const s = String(v);
  return s.slice(0, 2) + '*'.repeat(Math.max(s.length - 2, 3));
}

// Free-text safety net — masks emails/phones inside any string (log lines etc.)
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_RE = /\+?1?[\s\-.(]*\d{3}[)\s\-.]*\d{3}[\s\-.]*\d{4}\b/g;
function maskFreeText(v) {
  return v.replace(EMAIL_RE, m => maskEmail(m)).replace(PHONE_RE, m => maskPhone(m));
}

// Does this look like a person row (vs an event/stat row)?
function looksLikePerson(obj) {
  return !!(obj && (obj.email || obj.emails || obj.phones || obj.firstName || obj.lastName));
}
function looksLikeEventName(v) {
  return /\b(19|20)\d{2}\b/.test(v) || /league|tournament|tourney|camp|clinic|session|basketball/i.test(v);
}
// Event-shaped objects (SE registrations) carry these fields even when the
// name itself has no year/sport keyword (e.g. "3 on 3 Hoops Hub - New Site").
function looksLikeEvent(obj) {
  return !!(obj && (
    obj.resultsCompleted !== undefined || obj.open !== undefined ||
    obj.close !== undefined || obj.sport !== undefined ||
    typeof obj.status === 'number'
  ));
}

/**
 * Recursively mask an API payload in place-safe (returns new structures).
 */
export function maskDeep(value, key = '', parent = null) {
  if (value == null) return value;
  if (Array.isArray(value)) return value.map(v => maskDeep(v, key, parent));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskDeep(v, k, value);
    return out;
  }
  if (typeof value !== 'string' || !value) return value;

  const k = key.toLowerCase();
  if (k === 'emails' || k === 'email' || k.endsWith('email')) return maskEmail(value);
  if (k === 'phones' || k === 'phone' || k.endsWith('phone'))  return maskPhone(value);
  if (k === 'firstname' || k === 'lastname')                   return maskPersonName(value);
  if (k === 'city')                                            return maskCity(value);
  if (k === 'zip' || k === 'postal')                           return maskZip(value);
  if (k === 'eventname' || k === 'orgname')                    return maskEventName(value);
  if (k === 'name') {
    if (looksLikePerson(parent))   return maskPersonName(value);
    if (looksLikeEventName(value) || looksLikeEvent(parent)) return maskEventName(value);
    return value; // stat labels like grad years, genders, states stay readable
  }
  return maskFreeText(value);
}
