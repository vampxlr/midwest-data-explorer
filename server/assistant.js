/**
 * SARAH — the AI registration assistant (see DEVELOPERS.md §1 "Sarah").
 * Everything Sarah lives here: settings, knowledge base, FAQ bank, the
 * built-in intent layer, the public chat endpoint, the embeddable widget,
 * the Facebook Messenger channel, and the LLM rate-limit queue.
 *
 * Registered by index.js via registerAssistant(app, deps). deps carries the
 * few index-local helpers Sarah needs (crypto/email/CAPI/site-scrape); node
 * and project modules are required directly. All code inside the factory was
 * moved VERBATIM from index.js (refactor step 2, DEVELOPERS.md §9) — the
 * factory's destructured names reproduce the original scope exactly.
 */

const axios = require('axios');
const cryptoLib = require('crypto');
const auth = require('./auth');
const store = require('./store');
const { kvGet, kvSet, kvGetCached, appendCapped, chatLog, chatLogRecent } = require('./kv');

module.exports = function registerAssistant(app, deps) {
  const { encryptSecret, decryptSecret, capiSend, sendEmail, EMAIL_RE, htmlToText, fetchSitePage, SITE_BASE } = deps;

// ══════════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════
// SARAH — AI registration assistant. An embeddable chat widget for the org's
// public website that answers from (a) a scraped site knowledge base and
// (b) LIVE Data Explorer facts (open leagues, EB/final deadlines, prices),
// captures visitor contact info as leads, and fires Meta CAPI Lead events so
// the ads that drove the conversation get attribution. Dormant-safe: without
// an Anthropic API key the widget politely says the assistant is offline.
// ═══════════════════════════════════════════════════════════════════════════════

async function assistantSettings() {
  const s = (await kvGetCached('assistant:settings')) || {};
  return {
    apiKey: s.apiKeyEnc ? decryptSecret(s.apiKeyEnc) : (process.env.ANTHROPIC_API_KEY || null),
    hasApiKey: !!(s.apiKeyEnc || process.env.ANTHROPIC_API_KEY),
    geminiKey: s.geminiKeyEnc ? decryptSecret(s.geminiKeyEnc) : (process.env.GEMINI_API_KEY || null),
    hasGeminiKey: !!(s.geminiKeyEnc || process.env.GEMINI_API_KEY),
    model: s.model || 'claude-haiku-4-5-20251001',
    name: s.name || 'Sarah',
    greeting: s.greeting || "Hi! I'm Sarah 👋 I can answer anything about our leagues, tournaments and camps — dates, prices, deadlines, how it all works. What would you like to know?",
    extraInstructions: s.extraInstructions || '',
    accent: s.accent || '#f97316',
    answerMode: s.answerMode || 'hybrid', // 'hybrid' | 'llm' | 'faq' (no-LLM)
    kbDocUrl: s.kbDocUrl || '',
    leadNotifyEmail: s.leadNotifyEmail || '',
    mailchimpKey: s.mailchimpKeyEnc ? decryptSecret(s.mailchimpKeyEnc) : null,
    hasMailchimp: !!s.mailchimpKeyEnc,
    mailchimpListId: s.mailchimpListId || '',
    messengerPageToken: s.messengerPageTokenEnc ? decryptSecret(s.messengerPageTokenEnc) : null,
    hasMessenger: !!s.messengerPageTokenEnc,
    messengerVerifyToken: s.messengerVerifyToken || 'mw3-sarah-2026',
    widgetKey: s.widgetKey || null,
  };
}

// Chat-path DB cache: events/deadlines change rarely; 5-min staleness is fine
// for Sarah and saves a Convex events read on every single chat message.
let chatDbMemo = { at: 0, v: null };
async function loadDbCachedForChat() {
  if (chatDbMemo.v && Date.now() - chatDbMemo.at < 300000) return chatDbMemo.v;
  chatDbMemo.v = await store.load();
  chatDbMemo.at = Date.now();
  return chatDbMemo.v;
}

// Live facts the model can quote: currently-open events with their deadlines
// and prices — the thing a static chatbot can never get right.
async function assistantLiveContext() {
  try {
    const [db, deadlines] = await Promise.all([loadDbCachedForChat(), kvGetCached('deadlines:all')]);
    const dl = deadlines || {};
    const today = store.todayCDT();
    const lines = [];
    const events = Object.values(db.events)
      .filter(e => e.status === 1)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    for (const e of events.slice(0, 80)) {
      const d = dl[String(e.id)];
      let extra = '';
      const closed = !!(d?.finalDeadline && d.finalDeadline < today);
      if (d) {
        const parts = [];
        if (d.earlyBird)     parts.push(`early-bird deadline ${d.earlyBird}${d.earlyBirdPrice ? ` ($${d.earlyBirdPrice})` : ''}${d.earlyBird < today ? ' (PASSED)' : ''}`);
        if (d.finalDeadline) parts.push(`final registration deadline ${d.finalDeadline}${d.finalPrice ? ` ($${d.finalPrice})` : ''}${closed ? ' (PASSED)' : ''}`);
        if (d.eventDates)    parts.push(`game dates: ${d.eventDates}${d.eventTimes ? ` (times ${d.eventTimes})` : ''}`);
        if (parts.length) extra = ` — ${parts.join(', ')}`;
      }
      lines.push(`- ${e.name}: ${closed ? 'registration CLOSED (final deadline has passed — do NOT tell visitors this one is open; suggest a similar open league instead)' : 'OPEN for registration'}${extra}`);
    }
    return `Today's date: ${today}\nCurrently open for registration (${lines.length} events):\n${lines.join('\n')}`;
  } catch { return ''; }
}

// Scrape the org's public site into the knowledge base the model answers from
app.post('/api/admin/assistant/rebuild-kb', auth.requireRole('admin'), async (req, res) => {
  try {
    const listingPaths = ['/', '/leagues', '/tournaments', '/camps', '/about-midwest-3-on-3', '/faqs', '/contact-us'];
    const subpages = new Set(listingPaths);
    for (const p of ['/leagues', '/tournaments', '/camps', '/']) {
      try {
        const html = await fetchSitePage(SITE_BASE + p);
        for (const m of String(html).matchAll(/href="([^"]+)"/gi)) {
          let path = m[1].replace(/^https?:\/\/(www\.)?midwest3on3\.com/i, '');
          if (/^https?:|^mailto:|^tel:|^#/i.test(path)) continue;
          if (!path.startsWith('/')) path = '/' + path;
          path = path.split(/[#?]/)[0].replace(/\/$/, '');
          if (!path) continue;
          if (/league|tournament|camp|clinic|faq|about|contact|rules|philosoph|waiver|start-a-new/i.test(path)) subpages.add(path);
        }
      } catch {}
    }
    const pages = [];
    const paths = [...subpages].slice(0, 60);
    for (let i = 0; i < paths.length; i += 5) {
      const batch = await Promise.all(paths.slice(i, i + 5).map(async (path) => {
        try {
          const html = await fetchSitePage(SITE_BASE + (path === '/' ? '' : path));
          const title = (String(html).match(/<title>([^<]*)<\/title>/i) || [])[1]?.replace(/\s*&mdash;.*$/, '').trim() || path;
          let text = htmlToText(html);
          // strip the repeated nav/menu boilerplate that pads every Squarespace page
          const bodyStart = text.search(/Open Menu Close Menu(?!.*Open Menu Close Menu)/s);
          if (bodyStart > 0) text = text.slice(bodyStart + 'Open Menu Close Menu'.length);
          text = text.replace(/\s+/g, ' ').trim().slice(0, 4500);
          return text.length > 200 ? { path, url: SITE_BASE + path, title, text } : null;
        } catch { return null; }
      }));
      pages.push(...batch.filter(Boolean));
    }
    // Owner-authored knowledge doc (Google Doc): fetch the latest text export
    // every rebuild so the owner keeps editing in Docs and Sarah stays current.
    let doc = null;
    const settings = await assistantSettings();
    if (settings.kbDocUrl) {
      const m = String(settings.kbDocUrl).match(/docs\.google\.com\/document\/d\/([\w-]+)/);
      const exportUrl = m ? `https://docs.google.com/document/d/${m[1]}/export?format=txt` : settings.kbDocUrl;
      const r = await axios.get(exportUrl, { timeout: 20000, maxContentLength: 2000000, responseType: 'text' });
      const text = String(r.data || '').replace(/^﻿/, '').replace(/\r\n/g, '\n').trim().slice(0, 90000);
      if (text.length > 500) doc = { url: settings.kbDocUrl, text, chars: text.length };
      else throw new Error('knowledge doc fetched but looks empty — is link sharing set to "Anyone with the link"?');
    }
    const kb = { builtAt: new Date().toISOString(), pages, doc, chars: pages.reduce((s, p) => s + p.text.length, 0) + (doc ? doc.chars : 0) };
    await kvSet('assistant:kb', kb);
    res.json({ ok: true, pages: pages.length, chars: kb.chars, docChars: doc ? doc.chars : 0, paths: pages.map(p => p.path) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: settings + status + the copy-paste embed snippet
app.get('/api/admin/assistant', auth.requireRole('admin'), async (req, res) => {
  const cur = (await kvGet('assistant:settings')) || {};
  if (!cur.widgetKey) {
    cur.widgetKey = cryptoLib.randomBytes(12).toString('base64url');
    await kvSet('assistant:settings', cur);
  }
  const s = await assistantSettings();
  const kb = (await kvGet('assistant:kb')) || null;
  const host = process.env.VERCEL === '1' ? `https://${req.headers['x-forwarded-host'] || req.headers.host}` : 'http://localhost:3001';
  res.json({
    hasApiKey: s.hasApiKey, hasGeminiKey: s.hasGeminiKey, model: s.model, name: s.name, greeting: s.greeting,
    extraInstructions: s.extraInstructions, accent: s.accent, kbDocUrl: s.kbDocUrl,
    leadNotifyEmail: s.leadNotifyEmail, emailConfigured: !!process.env.RESEND_API_KEY,
    hasMailchimp: s.hasMailchimp, mailchimpListId: s.mailchimpListId,
    abuse: ((await kvGet('assistant:abuse')) || []).slice(0, 20),
    answerMode: s.answerMode,
    faq: await kvGet('assistant:faq').then(f => f ? { builtAt: f.builtAt, count: f.items.length } : null).catch(() => null),
    kb: kb ? { builtAt: kb.builtAt, pages: kb.pages.length, chars: kb.chars, docChars: kb.doc ? kb.doc.chars : 0, paths: kb.pages.map(p => p.path) } : null,
    embed: `<script src="${host}/api/widget.js?key=${cur.widgetKey}" async></script>`,
  });
});
app.put('/api/admin/assistant', auth.requireRole('admin'), async (req, res) => {
  const b = req.body || {};
  const cur = (await kvGet('assistant:settings')) || {};
  for (const k of ['model', 'name', 'greeting', 'extraInstructions', 'accent', 'kbDocUrl', 'leadNotifyEmail', 'mailchimpListId', 'answerMode']) {
    if (b[k] !== undefined) cur[k] = String(b[k]);
  }
  if (b.apiKey && !/^•+$/.test(b.apiKey)) cur.apiKeyEnc = encryptSecret(String(b.apiKey).trim());
  if (b.geminiKey && !/^•+$/.test(b.geminiKey)) cur.geminiKeyEnc = encryptSecret(String(b.geminiKey).trim());
  if (b.mailchimpKey && !/^•+$/.test(b.mailchimpKey)) cur.mailchimpKeyEnc = encryptSecret(String(b.mailchimpKey).trim());
  if (b.messengerPageToken && !/^•+$/.test(b.messengerPageToken)) cur.messengerPageTokenEnc = encryptSecret(String(b.messengerPageToken).trim());
  if (!cur.widgetKey) cur.widgetKey = cryptoLib.randomBytes(12).toString('base64url');
  await kvSet('assistant:settings', cur);
  res.json({ ok: true });
});
app.get('/api/admin/assistant/convos', auth.requireRole('admin'), async (req, res) => {
  const [convos, leads, unanswered] = await Promise.all([chatLogRecent('convo', 150), kvGet('assistant:leads'), chatLogRecent('unanswered', 200)]);
  res.json({ convos, leads: leads || [], unanswered });
});

// ── FAQ bank: pre-generated answers with live-data placeholders ──────────────
// Generated ONCE from the knowledge base by the LLM (admin button). Static
// facts are baked into the answers; anything that changes (open leagues,
// deadlines, prices) is a {{PLACEHOLDER}} rendered from live data at answer
// time. Matched FAQ questions cost zero AI tokens.
const FAQ_STOPWORDS = new Set(['the', 'and', 'for', 'are', 'can', 'you', 'your', 'our', 'what', 'how', 'when', 'where', 'why', 'who', 'does', 'this', 'that', 'with', 'have', 'get', 'about', 'basketball', 'league', 'leagues']);
const faqTokens = (str) => normQuestion(str).split(' ').filter(w => w.length > 2 && !FAQ_STOPWORDS.has(w));
function matchFaq(items, question) {
  const qt = new Set(faqTokens(question));
  if (qt.size === 0) return null;
  let best = null, bs = 0;
  for (const it of items) {
    for (const cand of [it.q, ...(it.alts || [])]) {
      const ct = new Set(faqTokens(cand));
      if (!ct.size) continue;
      let inter = 0; for (const t of qt) if (ct.has(t)) inter++;
      const score = inter / Math.min(qt.size, ct.size);
      if (inter >= 2 && score >= 0.65 && score > bs) { bs = score; best = it; }
      else if (inter >= 1 && qt.size <= 2 && score >= 0.99 && score > bs) { bs = score; best = it; }
    }
  }
  return best;
}
async function assistantOpenDeadlines() {
  const [db, deadlines] = await Promise.all([loadDbCachedForChat(), kvGetCached('deadlines:all')]);
  const dl = deadlines || {};
  const today = store.todayCDT();
  return Object.values(db.events)
    .filter(e => e.status === 1)
    .map(e => ({ name: e.name, d: dl[String(e.id)] || {} }))
    .filter(x => !(x.d.finalDeadline && x.d.finalDeadline < today))
    .sort((a, b) => String(a.d.finalDeadline || '9999').localeCompare(String(b.d.finalDeadline || '9999')));
}
const faqShortName = (n) => String(n).replace(/^20\d\d\s*/, '').replace(/\s*3 on 3.*$/i, '').trim();
const faqDlLine = (x) => {
  const p = [];
  if (x.d.earlyBird) p.push(`early-bird deadline ${x.d.earlyBird}${x.d.earlyBirdPrice ? ` ($${x.d.earlyBirdPrice}/team)` : ''}`);
  if (x.d.finalDeadline) p.push(`final registration deadline ${x.d.finalDeadline}${x.d.finalPrice ? ` ($${x.d.finalPrice}/team)` : ''}`);
  return `${faqShortName(x.name)}: ${p.join(', ') || 'see the league page for deadlines'}`;
};
// Words too generic to identify a specific event by name (seasons, event types)
const FAQ_GENERIC_EVENT_WORDS = new Set(['summer', 'fall', 'winter', 'spring', 'august', 'september', 'october', 'november', 'december', 'holiday', 'clinic', 'camp', 'camps', 'shooting', 'skills', 'skill', 'game', 'play', 'program', 'list', 'building', 'boot', 'mea', 'advanced', 'footwork', 'finishing', 'scoring', 'thanksgiving', 'registration']);
const faqEventMention = (question, open) => {
  const qt = new Set(faqTokens(question));
  return open.filter(x => faqTokens(faqShortName(x.name)).some(t => qt.has(t) && !FAQ_GENERIC_EVENT_WORDS.has(t)));
};
async function renderFaqAnswer(answer, questionText) {
  if (!/\{\{/.test(answer)) return answer;
  const open = await assistantOpenDeadlines();
  const mentioned = faqEventMention(questionText, open);
  const chosen = mentioned.length ? mentioned : open.filter(x => x.d.finalDeadline).slice(0, 3);
  return answer
    .replaceAll('{{OPEN_LEAGUES}}', [...new Set(open.map(x => faqShortName(x.name)).filter(Boolean))].join(', ') || 'several events — see https://www.midwest3on3.com/leagues')
    .replaceAll('{{LEAGUE_DEADLINES}}', chosen.map(faqDlLine).join('. ') || 'see https://www.midwest3on3.com/leagues for current deadlines');
}

// Rule-based answers that need no LLM and no FAQ bank: greetings, contact
// capture, specific-league lookups, open/cost/reminder intents. All dynamic
// values come from live registration data.
function builtinAnswer(qRaw, s, open) {
  const q = normQuestion(qRaw);
  const t = new Set(q.split(' ').filter(Boolean));
  const has = (...ws) => ws.some(w => t.has(w));
  const email = qRaw.match(/[^\s@]+@[^\s@]+\.[^\s@]{2,}/);
  const phone = qRaw.match(/\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  if (email || phone) return `Perfect, got it! We'll follow up at ${email ? email[0] : phone[0]} with registration info and a reminder before the deadline. Anything else I can help with?`;
  if (/^(hi+|hey+|hello+|yo|sup|howdy|good (morning|afternoon|evening))\b/.test(q) && t.size <= 3) return s.greeting;
  if (/\bthank/.test(q)) return `You're welcome! Anything else about our leagues, tournaments or camps?`;
  const mentioned = faqEventMention(qRaw, open);
  if (/remind/.test(q)) {
    const which = mentioned.length ? faqShortName(mentioned[0].name) : 'registration';
    return `Happy to set that up! Just type your email here and we'll remind you before the ${which} deadline.`;
  }
  if (mentioned.length) {
    // Schedule-type question but no scraped schedule data → let the LLM
    // answer from the knowledge base (league pages include dates/times).
    const wantsSchedule = has('date', 'dates', 'when', 'day', 'days', 'time', 'times', 'timing', 'schedule', 'start', 'starts', 'location', 'where', 'address', 'venue');
    if (wantsSchedule && !mentioned.some(x => x.d.eventDates)) return null;
    const schedLine = (x) => x.d.eventDates
      ? ` ${faqShortName(x.name)} plays ${x.d.eventDates}${x.d.eventTimes ? `, roughly ${x.d.eventTimes}` : ''}.`
      : '';
    return `Here's the latest on ${[...new Set(mentioned.map(x => faqShortName(x.name)))].join(' and ')}: ${mentioned.map(faqDlLine).join('. ')}.${mentioned.map(schedLine).join('')} You can register at https://www.midwest3on3.com/leagues — want to leave your email for a reminder before the deadline?`;
  }
  const leagues = open.filter(x => /league/i.test(x.name));
  if (has('open', 'opening', 'openning', 'openings', 'available', 'active', 'current', 'ongoing') && has('league', 'leagues', 'register', 'registration', 'registrations', 'signup', 'event', 'events', 'spot', 'spots', 'team', 'teams')) {
    const names = [...new Set(leagues.map(x => faqShortName(x.name)).filter(Boolean))];
    return `Right now ${names.length} leagues are open for registration: ${names.join(', ')}. See dates, locations and divisions at https://www.midwest3on3.com/leagues`;
  }
  if (has('cost', 'costs', 'price', 'prices', 'pricing', 'fee', 'fees', 'much')) {
    const lines = leagues.filter(x => x.d.finalDeadline).slice(0, 3).map(faqDlLine).join('. ');
    return `Here are current prices and deadlines: ${lines || 'see each event page for pricing'}. Registering before the early-bird deadline saves you money! Full details at https://www.midwest3on3.com/leagues`;
  }
  return null;
}

// Admin: LLM reads the knowledge base once and writes the FAQ bank
app.post('/api/admin/assistant/generate-faq', auth.requireRole('admin'), async (req, res) => {
  try {
    const s = await assistantSettings();
    const kb = (await kvGet('assistant:kb')) || { pages: [] };
    const kbText = (kb.doc ? kb.doc.text.slice(0, 55000) + '\n\n' : '') +
      kb.pages.map(p => `### ${p.title} (${p.url})\n${p.text}`).join('\n\n').slice(0, 25000);
    if (kbText.length < 1000) return res.status(400).json({ error: 'Knowledge base is empty — rebuild it first' });
    const prompt = `You are preparing the pre-written FAQ answer bank for ${s.name}, the chat assistant of Midwest 3 on 3 Basketball (midwest3on3.com). Read the knowledge base below and produce the 45-60 questions visitors most likely ask, each with an answer.

RULES:
- Answers: warm, conversational plain text, 1-4 short sentences, no markdown, bare URLs only. Include the relevant page URL when one exists.
- NEVER bake in anything that changes over time — specific dates, deadlines, prices, or which leagues/camps are currently open. Where such info belongs, use EXACTLY these placeholders instead: {{OPEN_LEAGUES}} (replaced with the list of currently-open events) or {{LEAGUE_DEADLINES}} (replaced with current deadline + price info).
- Static policies ARE safe to bake in: team sizes, no practices, no standings, free-agent process, escalation email, formats, philosophy, shirt info, weather policy, etc.
- "alts": 4-8 alternative phrasings of the same question, the varied ways real parents type it (short, misspelled-ish, casual).
Return ONLY a JSON array, no prose: [{"q":"...","alts":["...",...],"a":"..."}]
${await chatLogRecent('unanswered', 40).then(u => u.length ? '\nREAL VISITOR QUESTIONS THAT HAD NO ANSWER — make sure the bank covers each of these (answer from the knowledge base; use the placeholders for anything dynamic):\n' + [...new Set(u.map(x => '- ' + x.q))].join('\n') + '\n' : '').catch(() => '')}
=== KNOWLEDGE BASE ===
${kbText}`;
    let raw;
    if (String(s.model).startsWith('gemini')) {
      if (!s.geminiKey) return res.status(400).json({ error: 'No Gemini key saved' });
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(s.model)}:generateContent`;
      const opts = { headers: { 'x-goog-api-key': s.geminiKey, 'content-type': 'application/json' }, timeout: 120000 };
      const body = (cfg) => ({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: cfg });
      let r;
      try { r = await axios.post(url, body({ maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 }, responseMimeType: 'application/json' }), opts); }
      catch (e1) {
        if (e1.response?.status !== 400) throw e1;
        r = await axios.post(url, body({ maxOutputTokens: 8192 }), opts);
      }
      raw = (r.data?.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
    } else {
      if (!s.apiKey) return res.status(400).json({ error: 'No Anthropic key saved' });
      const r = await axios.post('https://api.anthropic.com/v1/messages',
        { model: s.model, max_tokens: 16000, messages: [{ role: 'user', content: prompt }] },
        { headers: { 'x-api-key': s.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 120000 });
      raw = (r.data?.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    }
    const jsonText = raw.replace(/^```(json)?/m, '').replace(/```\s*$/m, '').trim();
    const items = JSON.parse(jsonText.slice(jsonText.indexOf('['), jsonText.lastIndexOf(']') + 1))
      .filter(x => x && x.q && x.a).map(x => ({ q: String(x.q), alts: (x.alts || []).map(String).slice(0, 8), a: String(x.a) }));
    if (!items.length) return res.status(500).json({ error: 'Model returned no usable FAQ items — try again' });
    await kvSet('assistant:faq', { builtAt: new Date().toISOString(), items });
    res.json({ ok: true, count: items.length });
  } catch (err) { res.status(500).json({ error: err.response?.data?.error?.message || err.message }); }
});

// Public chat endpoint the widget calls. Stateless per call — the widget
// sends its own trimmed history. Keyed + rate limited per IP.
const chatRate = new Map();

// ── Abuse guard + reply cache ────────────────────────────────────────────────
// Cache: normalized question → reply. Serves repeat questions without an AI
// call (saves tokens), and is the graceful fallback once limits trip. Only
// opening questions (no prior context) are cached — follow-ups depend on the
// conversation. 6h TTL keeps cached deadlines/prices fresh enough.
const chatCache = new Map();
const CHAT_CACHE_TTL = 6 * 3600 * 1000, CHAT_CACHE_MAX = 500;
const normQuestion = (q) => String(q).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
function cacheGet(q) {
  const hit = chatCache.get(normQuestion(q));
  return hit && Date.now() - hit.at < CHAT_CACHE_TTL ? hit.reply : null;
}
function cachePut(q, reply) {
  if (chatCache.size >= CHAT_CACHE_MAX) chatCache.delete(chatCache.keys().next().value);
  chatCache.set(normQuestion(q), { reply, at: Date.now() });
}
// Flood detection: total requests across ALL IPs per minute (a distributed
// flood never trips a per-IP limit), plus a per-IP burst limit. Note: counters
// are per serverless instance, so treat them as best-effort tripwires.
let chatGlobalWin = { start: 0, n: 0 };
let lastAbuseAlertAt = 0;
async function flagChatAbuse(kind, ip, detail, s) {
  appendCapped('assistant:abuse', { at: new Date().toISOString(), kind, ip, detail }, 200).catch(() => {});
  const now = Date.now();
  if (now - lastAbuseAlertAt < 6 * 3600 * 1000) return; // at most one alert email / 6h
  lastAbuseAlertAt = now;
  const to = s?.leadNotifyEmail || process.env.SUPER_ADMIN_EMAIL;
  if (to) sendEmail(to, `⚠ Sarah chat abuse detected: ${kind}`,
    `The assistant chat endpoint tripped a safety limit.\n\nType: ${kind}\nIP: ${ip}\nDetail: ${detail}\nTime: ${new Date().toISOString()}\n\nSarah has switched to cached/limited replies for the affected traffic — no action needed unless this keeps happening. Recent events are listed on the Site Assistant page.`
  ).catch(() => {});
}
app.post('/api/assistant/chat', async (req, res) => {
  try {
    const { key, sessionId, messages, page } = req.body || {};
    const cur = (await kvGet('assistant:settings')) || {};
    if (!cur.widgetKey || key !== cur.widgetKey) return res.status(401).json({ error: 'bad key' });

    const ip = req.ip || 'x';
    const now = Date.now();
    const s = await assistantSettings();
    const lastUserMsg = Array.isArray(messages) ? [...messages].reverse().find(m => m?.role === 'user')?.content : '';
    const cachedFallback = () => cacheGet(lastUserMsg || '');

    // Per-IP limits: 40/hour + a 10/minute burst guard
    const rl = chatRate.get(ip) || { n: 0, reset: now + 3600000, bn: 0, breset: now + 60000 };
    if (now > rl.reset) { rl.n = 0; rl.reset = now + 3600000; }
    if (now > rl.breset) { rl.bn = 0; rl.breset = now + 60000; }
    rl.n++; rl.bn++;
    chatRate.set(ip, rl);
    if (rl.n > 40 || rl.bn > 10) {
      if (rl.n === 41 || rl.bn === 11) flagChatAbuse(rl.bn > 10 ? 'per-ip burst (>10/min)' : 'per-ip hourly limit (>40/h)', ip, `${rl.n} msgs this hour, ${rl.bn} this minute`, s);
      const c = cachedFallback();
      if (c) return res.json({ reply: c, cached: true });
      return res.status(429).json({ reply: "You've sent quite a few messages — give me a short break and try again in a bit!" });
    }

    // Global flood guard: >60 chats/min across all visitors ≈ not organic
    if (now - chatGlobalWin.start > 60000) chatGlobalWin = { start: now, n: 0 };
    if (++chatGlobalWin.n > 60) {
      if (chatGlobalWin.n === 61) flagChatAbuse('global flood (>60 chats/min)', ip, `${chatGlobalWin.n} chats in the current minute`, s);
      const c = cachedFallback();
      if (c) return res.json({ reply: c, cached: true });
      return res.status(429).json({ reply: "I'm getting a lot of questions right now! Give me a minute and ask again — or check https://www.midwest3on3.com/leagues in the meantime." });
    }
    const isGemini = String(s.model).startsWith('gemini');
    // no-LLM mode needs no API key at all — only block keyless chats when a model call would be required
    if ((s.answerMode || 'hybrid') !== 'faq' && (isGemini ? !s.geminiKey : !s.apiKey)) return res.json({ reply: `${s.name} is offline right now — please check the website pages for details, or reach out through the contact page. We'll be back shortly!`, offline: true });

    const history = (Array.isArray(messages) ? messages : [])
      .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-12)
      .map(m => ({ role: m.role, content: String(m.content).slice(0, 600) }));
    if (!history.length || history[history.length - 1].role !== 'user') return res.status(400).json({ error: 'last message must be from user' });

    // Repeat opening questions (no conversation context) are answered from
    // cache — zero AI tokens. Follow-ups always go to the model.
    const cacheable = history.length === 1;
    let cachedReply = cacheable ? cacheGet(history[0].content) : null;

    // Token-free answer layers, in order: built-in intent rules (greetings,
    // contact capture, league lookups, open/cost/reminder) → FAQ bank
    // (pre-written answers, live placeholders rendered fresh). 'hybrid' falls
    // through to the LLM on a miss; 'faq' runs with no LLM at all.
    const mode = s.answerMode || 'hybrid';
    let answerSrc = cachedReply ? 'cache' : 'llm';
    if (!cachedReply && mode !== 'llm') {
      const q = history[history.length - 1].content;
      const open = await assistantOpenDeadlines().catch(() => []);
      const builtin = builtinAnswer(q, s, open);
      if (builtin) { cachedReply = builtin; answerSrc = 'builtin'; }
      else {
        const bank = (await kvGetCached('assistant:faq'))?.items || [];
        const hit = matchFaq(bank, q);
        if (hit) { cachedReply = await renderFaqAnswer(hit.a, q); answerSrc = 'faq'; }
        else if (mode === 'faq') {
          cachedReply = `Great question — I don't have that one handy! You'll find everything at https://www.midwest3on3.com, or reach out through https://www.midwest3on3.com/contact-us and the team will get you an answer. Want to leave your email so someone follows up with you?`;
          answerSrc = 'unanswered';
        }
      }
    }

    const kb = (await kvGetCached('assistant:kb')) || { pages: [] };
    const kbText = kb.pages.map(p => `### ${p.title} (${p.url})\n${p.text}`).join('\n\n').slice(0, 38000);
    const live = await assistantLiveContext();

    const system = `You are ${s.name}, the friendly registration assistant for Midwest 3 on 3 Basketball (midwest3on3.com) — youth 3-on-3 basketball leagues, tournaments and camps in Minnesota and Wisconsin.

STYLE: Warm, concise, conversational — 1-4 short sentences per reply, like texting a helpful friend. Never invent facts. If you don't know, say so and point to the contact page. When a specific league/camp is discussed, include its page link from the knowledge base so they can register.

FORMAT: Plain conversational text ONLY — never use markdown (no asterisks, no ** bold, no bullet lists, no [text](url) syntax). When sharing a link, write the bare URL like https://www.midwest3on3.com/leagues — the chat window makes bare URLs clickable automatically. Always finish your sentences completely.

GOALS, in order: (1) answer accurately from LIVE DATA and the KNOWLEDGE BASE below — LIVE DATA wins if they conflict (it's real-time); (2) guide interested visitors toward registering, mentioning early-bird pricing when a deadline is coming up; (3) if someone seems interested but not ready, naturally offer: "want to leave your email so we can send you the registration link / remind you before the deadline?" — never pushy, ask at most once.
${s.extraInstructions ? '\nOWNER INSTRUCTIONS: ' + s.extraInstructions + '\n' : ''}
=== LIVE DATA (real-time from our registration system) ===
${live}
${kb.doc ? `\n=== OFFICIAL KNOWLEDGE BASE DOCUMENT (written by the league owner — follow its policies, tone guidance and escalation rules; for dates/costs/deadlines LIVE DATA above still wins) ===\n${kb.doc.text}\n` : ''}
=== SITE CONTENT (from midwest3on3.com) ===
${kbText}`;

    const callAnthropic = async (model) => {
      const r = await axios.post('https://api.anthropic.com/v1/messages', {
        model, max_tokens: 600, system, messages: history,
      }, { headers: { 'x-api-key': s.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 30000 });
      return (r.data?.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    };

    // Internal callers (Messenger queue) can ask for zero-token layers only:
    // if the answer would need the LLM, say so instead of spending budget.
    if (!cachedReply && req.body.zeroTokenOnly) return res.json({ needsLlm: true });

    let reply = cachedReply;
    if (!reply && isGemini) {
      // Gemini Flash "thinks" internally by default and those thoughts eat the
      // output-token budget, truncating replies mid-sentence. Disable thinking
      // (a short Q&A widget doesn't need it — faster and cheaper); if a model
      // rejects thinkingConfig, retry once without it.
      const geminiBody = (withThinkingOff) => ({
        systemInstruction: { parts: [{ text: system }] },
        contents: history.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: { maxOutputTokens: 2500, ...(withThinkingOff ? { thinkingConfig: { thinkingBudget: 0 } } : {}) },
      });
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(s.model)}:generateContent`;
      const geminiHeaders = { headers: { 'x-goog-api-key': s.geminiKey, 'content-type': 'application/json' }, timeout: 30000 };
      let r;
      try { r = await axios.post(geminiUrl, geminiBody(true), geminiHeaders); }
      catch (err) {
        if (err.response?.status === 400) r = await axios.post(geminiUrl, geminiBody(false), geminiHeaders);
        else if (err.response?.status === 429 && s.apiKey) {
          // Gemini quota exhausted (free tier is tiny) — fall back to Claude
          reply = await callAnthropic('claude-haiku-4-5-20251001');
        }
        else if (err.response?.status === 429) return res.json({ reply: `I'm getting a lot of questions right now! Give me a minute and ask again — or check https://www.midwest3on3.com/leagues in the meantime.` });
        else throw err;
      }
      if (r) reply = (r.data?.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
    } else if (!reply) {
      reply = await callAnthropic(s.model);
    }
    reply = reply || "Sorry — I didn't catch that. Could you rephrase?";
    if (cacheable && !cachedReply) cachePut(history[0].content, reply);

    // Log the exchange + capture leads (email/phone in the user's message →
    // lead record + Meta CAPI Lead so the driving ad gets credit)
    const userMsg = history[history.length - 1].content;
    await chatLog('convo', {
      at: new Date().toISOString(), sessionId: String(sessionId || '').slice(0, 40),
      page: String(page || '').slice(0, 200), q: userMsg.slice(0, 400), a: reply.slice(0, 600), src: answerSrc,
    }).catch(() => {});
    // Every question is kept for analysis (what do people actually ask?), and
    // FAQ misses go to a dedicated list — raw material for the next FAQ bank.
    await chatLog('question', { at: new Date().toISOString(), q: userMsg.slice(0, 300), src: answerSrc }).catch(() => {});
    if (answerSrc === 'unanswered') await chatLog('unanswered', { at: new Date().toISOString(), q: userMsg.slice(0, 300) }).catch(() => {});
    const email = (userMsg.match(/[^\s@]+@[^\s@]+\.[^\s@]{2,}/) || [])[0] || null;
    const phone = !email ? ((userMsg.match(/\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/) || [])[0] || null) : null;
    if (email || phone) {
      appendCapped('assistant:leads', {
        at: new Date().toISOString(), email, phone, page: String(page || '').slice(0, 200),
        context: history.slice(-4).map(m => `${m.role}: ${m.content.slice(0, 120)}`).join(' | '),
      }, 300).catch(() => {});
      const cfg = ((await kvGetCached('tracking:orgs')) || {})['midwest-3on3'];
      const override = cfg?.metaPixelId && cfg?.capiTokenEnc ? { pixelId: cfg.metaPixelId, token: decryptSecret(cfg.capiTokenEnc) } : {};
      // NOTE: these must be awaited — Vercel freezes the function the moment
      // the response is sent, so fire-and-forget work silently dies in prod.
      await capiSend('Lead', { email, phone, ip: req.ip, ua: req.headers['user-agent'], sourceUrl: page, ...override }).catch(() => {});
      // Mailchimp: upsert the lead into the audience tagged "Sarah Lead" —
      // a Mailchimp Customer Journey triggered by that tag sends the actual
      // email from the org's verified domain. Datacenter comes from the key
      // suffix (e.g. "...-us21").
      if (email && s.mailchimpKey && s.mailchimpListId) {
        await (async () => {
          const dc = (s.mailchimpKey.match(/-(\w+)$/) || [])[1];
          if (!dc) return;
          const hash = cryptoLib.createHash('md5').update(email.toLowerCase()).digest('hex');
          const mcAuth = { auth: { username: 'any', password: s.mailchimpKey }, timeout: 15000 };
          await axios.put(`https://${dc}.api.mailchimp.com/3.0/lists/${s.mailchimpListId}/members/${hash}`,
            { email_address: email, status_if_new: 'subscribed' }, mcAuth);
          await axios.post(`https://${dc}.api.mailchimp.com/3.0/lists/${s.mailchimpListId}/members/${hash}/tags`,
            { tags: [{ name: 'Sarah Lead', status: 'active' }] }, mcAuth);
        })().catch(e => console.warn('[assistant] mailchimp lead failed:', e.response?.data?.detail || e.message));
      }
      // Email follow-ups (no-ops until RESEND_API_KEY is configured):
      // the visitor gets the registration link, the owner gets the lead.
      if (email && !(s.mailchimpKey && s.mailchimpListId)) {
        await sendEmail(email, 'Your Midwest 3 on 3 registration link 🏀',
          `Hi! Thanks for chatting with ${s.name} at Midwest 3 on 3 Basketball.\n\nHere's the registration page you asked about:\nhttps://www.midwest3on3.com/leagues\n\nSpots and early-bird prices are first come, first served — don't wait too long!\n\nQuestions? Just reply to this email or write to Christy@3on3HoopsHub.com.\n\n— Midwest 3 on 3 Basketball`
        ).catch(() => {});
      }
      if (s.leadNotifyEmail) {
        await sendEmail(s.leadNotifyEmail, `New lead from ${s.name}: ${email || phone}`,
          `${s.name} captured a new lead on ${page || 'the website'}:\n\n${email ? 'Email: ' + email + '\n' : ''}${phone ? 'Phone: ' + phone + '\n' : ''}\nRecent conversation:\n${history.slice(-4).map(m => `${m.role === 'user' ? 'Visitor' : s.name}: ${m.content.slice(0, 200)}`).join('\n')}`
        ).catch(() => {});
      }
    }
    res.json({ reply });
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    console.warn('[assistant] chat failed:', detail);
    res.status(500).json({ reply: 'Sorry, something hiccuped on my end — try that again in a moment!', error: detail });
  }
});


// Admin: Messenger conversations grouped into per-person threads. Names are
// fetched from the Graph API best-effort (cached — may be unavailable before
// App Review approves profile access; PSID shown otherwise).
app.get('/api/admin/assistant/messenger', auth.requireRole('admin'), async (req, res) => {
  try {
    const convos = (await chatLogRecent('convo', 500)).filter(c => String(c.sessionId || '').startsWith('fb:'));
    const s = await assistantSettings();
    const names = (await kvGet('msgr:names')) || {};
    const threads = {};
    for (const c of convos) {
      const psid = c.sessionId.slice(3);
      const t = threads[psid] = threads[psid] || { psid, messages: [], last: c.at };
      t.messages.push({ at: c.at, q: c.q, a: c.a, src: c.src });
      if (c.at > t.last) t.last = c.at;
    }
    // resolve up to 5 unknown names per load (keeps Graph calls bounded)
    if (s.messengerPageToken) {
      const unknown = Object.keys(threads).filter(p => !(p in names)).slice(0, 5);
      await Promise.all(unknown.map(async (p) => {
        try {
          const r = await axios.get(`https://graph.facebook.com/v21.0/${p}?fields=first_name,last_name&access_token=${encodeURIComponent(s.messengerPageToken)}`, { timeout: 8000 });
          names[p] = [r.data.first_name, r.data.last_name].filter(Boolean).join(' ') || null;
        } catch { names[p] = null; }
      }));
      if (unknown.length) await kvSet('msgr:names', names).catch(() => {});
    }
    const list = Object.values(threads)
      .map(t => ({ ...t, name: names[t.psid] || null, messages: t.messages.sort((a, b) => a.at.localeCompare(b.at)) }))
      .sort((a, b) => b.last.localeCompare(a.last));
    res.json({ threads: list });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Facebook Messenger channel ───────────────────────────────────────────────
// Meta POSTs page messages here; Sarah answers through the same chat pipeline
// (KB, live deadlines, FAQ bank, lead capture, rate limits) and replies via
// the Graph API. Dormant-safe: without a saved Page token, the webhook still
// verifies and 200s so Meta setup can complete before the token is pasted.
app.get('/api/messenger/webhook', async (req, res) => {
  const s = await assistantSettings();
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === s.messengerVerifyToken) {
    return res.send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});
// LLM rate budget: shared per-minute counter in KV (approximate across
// serverless instances — 12 of the 15/min free-tier limit leaves headroom).
const LLM_PER_MINUTE = 12;
async function llmBudgetTake() {
  const minute = new Date().toISOString().slice(0, 16);
  const b = (await kvGet('llm:rpm')) || {};
  if (b.minute !== minute) { b.minute = minute; b.n = 0; }
  if (b.n >= LLM_PER_MINUTE) return false;
  b.n++;
  await kvSet('llm:rpm', b);
  return true;
}

async function sendMessengerText(s, psid, text) {
  if (!s.messengerPageToken) return;
  await axios.post(`https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(s.messengerPageToken)}`,
    { recipient: { id: psid }, message: { text: String(text).slice(0, 1900) }, messaging_type: 'RESPONSE' },
    { timeout: 15000 }
  ).catch(e => console.warn('[messenger] send failed:', e.response?.data?.error?.message || e.message));
}

// Run one Messenger question through the chat pipeline and deliver the reply.
// With zeroTokenOnly, returns {needsLlm:true} instead of spending LLM budget.
async function messengerAnswerAndSend(req, s, psid, hist, opts = {}) {
  let reply, needsLlm = false;
  try {
    const cur = (await kvGet('assistant:settings')) || {};
    const host = process.env.VERCEL === '1' ? `https://${req.headers['x-forwarded-host'] || req.headers.host}` : 'http://localhost:3001';
    const r = await axios.post(`${host}/api/assistant/chat`, {
      key: cur.widgetKey, sessionId: `fb:${psid}`, page: 'facebook-messenger', messages: hist,
      ...(opts.zeroTokenOnly ? { zeroTokenOnly: true } : {}),
    }, { timeout: 45000 });
    if (r.data.needsLlm) return { needsLlm: true };
    reply = r.data.reply;
  } catch { reply = `Sorry, I hit a snag — try again in a moment, or visit https://www.midwest3on3.com`; }
  hist.push({ role: 'assistant', content: String(reply).slice(0, 600) });
  await kvSet(`msgr:sess:${psid}`, hist.slice(-12)).catch(() => {});
  await sendMessengerText(s, psid, reply);
  return { sent: true };
}

// Drain queued LLM-needing questions, oldest first, within the minute budget.
// Called by the per-minute cron and opportunistically by webhook traffic.
async function drainMessengerQueue(req) {
  const queue = (await kvGet('msgr:queue')) || [];
  if (!queue.length) return { drained: 0, waiting: 0 };
  const s = await assistantSettings();
  let drained = 0;
  while (queue.length) {
    if (!(await llmBudgetTake())) break;
    const job = queue.shift();
    await messengerAnswerAndSend(req, s, job.psid, job.hist);
    drained++;
  }
  await kvSet('msgr:queue', queue);
  return { drained, waiting: queue.length };
}

// Deliberately unauthenticated: Vercel Hobby only allows daily crons, so an
// external pinger (GitHub Actions, cron-job.org…) drives this. Safe to expose
// — it's idempotent, returns only counts, and does nothing beyond answering
// already-queued questions within the same LLM budget they'd use anyway.
app.get('/api/cron/minute', async (req, res) => {
  try { res.json(await drainMessengerQueue(req)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/messenger/webhook', async (req, res) => {
  // NOTE: the work MUST happen before the ack — Vercel freezes the function
  // as soon as the response is sent (DEVELOPERS.md §8.1). Meta allows ~20s.
  try {
    const s = await assistantSettings();
    for (const entry of req.body?.entry || []) {
      for (const ev of entry.messaging || []) {
        const psid = ev.sender?.id;
        const text = ev.message?.text;
        if (!psid || !text || ev.message?.is_echo) continue;
        // short per-sender history so follow-up questions have context
        const sessKey = `msgr:sess:${psid}`;
        const hist = ((await kvGet(sessKey)) || []).slice(-10);
        hist.push({ role: 'user', content: String(text).slice(0, 600) });
        // 1) zero-token layers (greetings, FAQ bank, league lookups) → instant
        const r1 = await messengerAnswerAndSend(req, s, psid, hist, { zeroTokenOnly: true });
        if (!r1.needsLlm) continue;
        // 2) LLM needed — answer immediately if the minute budget allows…
        if (await llmBudgetTake()) {
          await messengerAnswerAndSend(req, s, psid, hist);
          continue;
        }
        // 3) …otherwise queue FIFO (a newer message replaces the same
        // person's pending job) and let them know we're on it
        const queue = (await kvGet('msgr:queue')) || [];
        const mine = queue.findIndex(j => j.psid === psid);
        if (mine >= 0) queue[mine] = { psid, hist, at: new Date().toISOString() };
        else queue.push({ psid, hist, at: new Date().toISOString() });
        await kvSet('msgr:queue', queue.slice(0, 200));
        await kvSet(sessKey, hist.slice(-12)).catch(() => {});
        if (mine < 0) await sendMessengerText(s, psid, `Great question! I'm pulling that information for you — give me a minute and I'll get right back to you 🏀`);
      }
    }
    // opportunistic drain: any webhook traffic helps clear the backlog
    await drainMessengerQueue(req).catch(() => {});
  } catch (e) { console.warn('[messenger] webhook error:', e.message); }
  res.sendStatus(200);
});

// The embeddable widget — one <script> tag on the public site renders the
// bubble + chat panel and talks back to this server. Vanilla JS, all styles
// inline, no dependencies, safe on any page.
app.get('/api/widget.js', async (req, res) => {
  const s = await assistantSettings();
  const cfg = JSON.stringify({ name: s.name, greeting: s.greeting, accent: s.accent, key: String(req.query.key || '') });
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(`(function(){
var CFG=${cfg};
var API=(document.currentScript&&document.currentScript.src?new URL(document.currentScript.src).origin:'')+ '/api/assistant/chat';
if(!CFG.key||document.getElementById('mw3-chat-bubble'))return;
var open=false,busy=false,hist=[];
try{hist=JSON.parse(sessionStorage.getItem('mw3-chat')||'[]')}catch(e){}
var sid=sessionStorage.getItem('mw3-sid')||(Date.now().toString(36)+Math.random().toString(36).slice(2,8));
sessionStorage.setItem('mw3-sid',sid);
function el(t,st,parent){var e=document.createElement(t);if(st)e.setAttribute('style',st);if(parent)parent.appendChild(e);return e}
var Z='2147483000';
var bubble=el('button','position:fixed;bottom:22px;right:22px;width:60px;height:60px;border-radius:50%;border:none;cursor:pointer;z-index:'+Z+';background:'+CFG.accent+';color:#fff;font-size:28px;box-shadow:0 6px 24px rgba(0,0,0,.35);transition:transform .15s;line-height:1',document.body);
bubble.id='mw3-chat-bubble';bubble.textContent='🏀';bubble.title='Chat with '+CFG.name;
bubble.onmouseenter=function(){bubble.style.transform='scale(1.08)'};bubble.onmouseleave=function(){bubble.style.transform=''};
var panel=el('div','position:fixed;bottom:94px;right:22px;width:min(370px,calc(100vw - 32px));height:min(540px,calc(100vh - 120px));z-index:'+Z+';background:#fff;border-radius:16px;box-shadow:0 12px 48px rgba(0,0,0,.35);display:none;flex-direction:column;overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,sans-serif',document.body);
var head=el('div','background:'+CFG.accent+';color:#fff;padding:14px 16px;font-weight:700;font-size:15px;display:flex;align-items:center;gap:8px',panel);
head.innerHTML='<span style="font-size:20px">🏀</span><span>'+CFG.name+' · Midwest 3 on 3</span><span style="margin-left:auto;font-size:10px;font-weight:400;opacity:.85">online</span>';
var msgs=el('div','flex:1;overflow-y:auto;padding:14px;background:#f6f7f9;display:flex;flex-direction:column;gap:8px',panel);
var form=el('form','display:flex;gap:8px;padding:10px;background:#fff;border-top:1px solid #e5e7eb',panel);
var input=el('input','flex:1;border:1px solid #d1d5db;border-radius:20px;padding:9px 14px;font-size:14px;outline:none',form);
input.placeholder='Ask about leagues, prices, dates…';input.maxLength=500;
var send=el('button','border:none;background:'+CFG.accent+';color:#fff;border-radius:50%;width:38px;height:38px;cursor:pointer;font-size:16px;flex-shrink:0',form);
send.type='submit';send.textContent='➤';
function add(role,text){var b=el('div','max-width:82%;padding:9px 13px;border-radius:14px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-break:break-word;'+(role==='user'?'align-self:flex-end;background:'+CFG.accent+';color:#fff;border-bottom-right-radius:4px':'align-self:flex-start;background:#fff;color:#111;border:1px solid #e5e7eb;border-bottom-left-radius:4px'),msgs);
b.innerHTML=String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/(https?:\\/\\/[^\\s<]+)/g,'<a href="$1" target="_blank" rel="noopener" style="color:'+(role==='user'?'#fff':CFG.accent)+';text-decoration:underline">$1</a>');
msgs.scrollTop=msgs.scrollHeight;return b}
function save(){try{sessionStorage.setItem('mw3-chat',JSON.stringify(hist.slice(-20)))}catch(e){}}
function render(){msgs.innerHTML='';add('assistant',CFG.greeting);hist.forEach(function(m){add(m.role,m.content)})}
bubble.onclick=function(){open=!open;panel.style.display=open?'flex':'none';bubble.textContent=open?'✕':'🏀';if(open){render();input.focus()}};
form.onsubmit=function(ev){ev.preventDefault();var q=input.value.trim();if(!q||busy)return;input.value='';
hist.push({role:'user',content:q});add('user',q);save();busy=true;
var t=add('assistant','…');var dots=setInterval(function(){t.textContent=t.textContent.length>=3?'.':t.textContent+'.'},350);
fetch(API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:CFG.key,sessionId:sid,page:location.href,messages:hist.slice(-12)})})
.then(function(r){return r.json()}).then(function(d){clearInterval(dots);t.remove();var a=d.reply||'Sorry, something went wrong — try again!';hist.push({role:'assistant',content:a});add('assistant',a);save()})
.catch(function(){clearInterval(dots);t.remove();add('assistant','Hmm, I could not connect — please try again in a moment.')})
.finally(function(){busy=false;input.focus()})};
})();`);
});


  // Exports: assistantSettings is used by the Reminders section (Mailchimp
  // creds live in assistant settings); _test exposes pure helpers for unit
  // tests without going through HTTP.
  return {
    assistantSettings,
    _test: { matchFaq, faqTokens, builtinAnswer, faqEventMention, renderFaqAnswer, normQuestion },
  };
};
