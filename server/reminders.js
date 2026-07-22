/**
 * REMINDERS — lapsed-registrant win-back campaigns via Mailchimp
 * (see DEVELOPERS.md §1 "Reminders"). Templates + email designs, past-edition
 * matching, lapsed-audience math (grad-year aware), send/test/preview, and
 * Mailchimp report stats.
 *
 * Registered by index.js via registerReminders(app, deps). All code inside
 * the factory was moved VERBATIM from index.js (refactor step 3,
 * DEVELOPERS.md §9) — destructured deps reproduce the original scope.
 */

const axios = require('axios');
const cryptoLib = require('crypto');
const auth = require('./auth');
const store = require('./store');
const { kvGet, kvSet, appendCapped } = require('./kv');

module.exports = function registerReminders(app, deps) {
  const { assistantSettings, loadContactResults, scrapeTokens, EMAIL_RE } = deps;

// ══════════════════════════════════════════════════════════════════════════════
// REMINDERS — re-engagement campaigns for lapsed registrants, sent via
// Mailchimp into the dedicated "Midwest Data Explorer" audience.
// Flow: map each open event to its past-year editions by name similarity →
// lapsed = past attendees (not yet graduated) minus this year's registrants →
// render a stored template (league-level placeholders filled app-side,
// per-person ones as Mailchimp merge tags) → static segment → campaign.
// ══════════════════════════════════════════════════════════════════════════════

const REMINDER_DEFAULT_TEMPLATES = [
  {
    id: 'open-announcement', name: '📣 Registration is open', subject: '{{TARGET_LEAGUE}} is open for registration!',
    body: `Hi {{FIRST_NAME}},\n\nGreat news — {{TARGET_LEAGUE}} is officially open for registration! You were part of {{PAST_LEAGUE}}, and we'd love to have your player back on the court this year.\n\nSame format families love: more touches, more involvement, more fun — no practices, just games.\n\nEarly-bird pricing{{EB_PRICE}} runs until {{EB_DATE}}, and final registration closes {{FR_DATE}}.\n\nRegister here: {{REGISTER_URL}}\n\nSee you on the court!\nMidwest 3 on 3 Basketball`,
  },
  {
    id: 'early-bird-week', name: '⏰ Early-bird — 1 week left', subject: 'One week left for {{TARGET_LEAGUE}} early-bird pricing',
    body: `Hi {{FIRST_NAME}},\n\nJust a heads-up — early-bird pricing{{EB_PRICE}} for {{TARGET_LEAGUE}} ends {{EB_DATE}}, one week from now. After that the price goes up{{FR_PRICE}} until final registration closes {{FR_DATE}}.\n\nYour player was part of {{PAST_LEAGUE}} — grab your team's spot before the price changes: {{REGISTER_URL}}\n\nMidwest 3 on 3 Basketball`,
  },
  {
    id: 'deadline-2-days', name: '🚨 Deadline — 2 days left', subject: 'Last chance: {{TARGET_LEAGUE}} registration closes in 2 days',
    body: `Hi {{FIRST_NAME}},\n\nThis is the final reminder — registration for {{TARGET_LEAGUE}} closes {{FR_DATE}}, just 2 days away. After that we can't add teams.\n\nYou were with us for {{PAST_LEAGUE}} — don't miss this year: {{REGISTER_URL}}\n\nMidwest 3 on 3 Basketball`,
  },
];
async function reminderTemplates() {
  const t = await kvGet('reminders:templates');
  return (t && t.length) ? t : REMINDER_DEFAULT_TEMPLATES;
}

// Name-similarity match: same event in earlier years ("2026 Alexandria …" ↔
// "2025 Alexandria …"). Tokens minus the year must overlap strongly.
function pastEditionsOf(ev, allEvents) {
  const yearOf = (e) => ((e.name || '').match(/\b(20\d{2})\b/) || [])[1];
  const toks = (e) => new Set(scrapeTokens(String(e.name).replace(/\b20\d{2}\b/, '')));
  const y = yearOf(ev);
  if (!y) return [];
  const a = toks(ev);
  return allEvents.filter(o => {
    const oy = yearOf(o);
    if (!oy || oy >= y || String(o.id) === String(ev.id)) return false;
    const b = toks(o);
    let inter = 0; for (const t of a) if (b.has(t)) inter++;
    return inter / (Math.min(a.size, b.size) || 1) >= 0.75;
  }).sort((x, z) => (yearOf(z) || '').localeCompare(yearOf(x) || ''));
}

// Lapsed contacts for one open event: everyone from its past editions (who
// hasn't graduated) with an email, minus everyone already registered this year.
async function lapsedContactsFor(ev, past, db) {
  const thisYear = Number(store.todayCDT().slice(0, 4));
  // loadContactResults returns per-event rows on Convex but ALL rows locally —
  // filter by eventId either way.
  const rowsFor = async (id) => (await loadContactResults(db, [String(id)])).filter(r => String(r.eventId) === String(id));
  const registered = new Set();
  for (const r of await rowsFor(ev.id)) for (const e of (r.emails?.length ? r.emails : (r.email ? [r.email] : []))) registered.add(String(e).toLowerCase().trim());
  const out = new Map(); // email -> contact
  for (const p of past) {
    const rows = await rowsFor(p.id);
    for (const r of rows) {
      const gys = (r.gradYears || []).map(Number).filter(Boolean);
      if (gys.length && Math.max(...gys) < thisYear) continue; // already graduated
      const emails = r.emails?.length ? r.emails : (r.email ? [r.email] : []);
      for (const e of emails) {
        const em = String(e || '').toLowerCase().trim();
        if (!em || !EMAIL_RE.test(em) || registered.has(em) || out.has(em)) continue;
        out.set(em, { email: em, fn: r.firstName || '', ln: r.lastName || '', pastLeague: db.events[String(p.id)]?.name || p.name });
      }
    }
  }
  return [...out.values()];
}

function renderReminderTemplate(tpl, ev, d) {
  const url = d?.source ? (String(d.source).startsWith('http') ? d.source : `https://www.midwest3on3.com${d.source}`) : 'https://www.midwest3on3.com/leagues';
  const fmt = (iso) => iso ? new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'soon';
  const fill = (s) => String(s)
    .replaceAll('{{TARGET_LEAGUE}}', ev.name)
    .replaceAll('{{EB_DATE}}', fmt(d?.earlyBird))
    .replaceAll('{{FR_DATE}}', fmt(d?.finalDeadline))
    .replaceAll('{{EB_PRICE}}', d?.earlyBirdPrice ? ` ($${d.earlyBirdPrice}/team)` : '')
    .replaceAll('{{FR_PRICE}}', d?.finalPrice ? ` ($${d.finalPrice}/team)` : '')
    .replaceAll('{{REGISTER_URL}}', url)
    .replaceAll('{{FIRST_NAME}}', '*|FNAME|*')
    .replaceAll('{{PAST_LEAGUE}}', '*|PASTLG|*');
  return { subject: fill(tpl.subject), body: fill(tpl.body) };
}

// ── Email designs: email-safe HTML wrappers (inline CSS, 600px, table-free
// enough for Gmail/Outlook). The template's plain-text body flows into the
// chosen design; the CTA button always points at the league's register page.
const REMINDER_DESIGNS = {
  classic: {
    name: 'Classic — clean white card, orange header',
    render: ({ bodyHtml, title, url, unsub }) => `
<div style="background:#dfe4ea;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">
 <div style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #c3cad4;box-shadow:0 2px 8px rgba(0,0,0,0.12)">
  <div style="background:#ea580c;padding:22px 28px">
   <div style="color:#ffffff;font-size:13px;font-weight:700;letter-spacing:2px">MIDWEST 3 ON 3 BASKETBALL</div>
   <div style="color:#ffffff;font-size:22px;font-weight:800;margin-top:6px;line-height:1.3">${title}</div>
  </div>
  <div style="padding:26px 28px;font-size:16px;line-height:1.7;color:#111827">${bodyHtml}
   <div style="text-align:center;margin:28px 0 8px">
    <a href="${url}" style="background:#ea580c;color:#ffffff;text-decoration:none;font-weight:800;font-size:16px;padding:14px 36px;border-radius:8px;display:inline-block">Register now →</a>
   </div>
  </div>
  <div style="padding:16px 28px;border-top:1px solid #d7dce3;font-size:11px;color:#6b7280;text-align:center">
   You're receiving this because your family took part in a Midwest 3 on 3 event.<br><a href="${unsub}" style="color:#9ca3af">Unsubscribe</a>
  </div>
 </div>
</div>`,
  },
  bold: {
    name: 'Bold — dark header, big energy',
    render: ({ bodyHtml, title, url, unsub }) => `
<div style="background:#111827;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">
 <div style="max-width:600px;margin:0 auto;background:#1f2937;border-radius:14px;overflow:hidden">
  <div style="padding:30px 28px;text-align:center;background:linear-gradient(135deg,#1f2937,#111827)">
   <div style="font-size:38px;line-height:1">🏀</div>
   <div style="color:#f97316;font-size:12px;font-weight:800;letter-spacing:3px;margin-top:10px">MIDWEST 3 ON 3</div>
   <div style="color:#ffffff;font-size:24px;font-weight:800;margin-top:8px;line-height:1.3">${title}</div>
  </div>
  <div style="background:#ffffff;padding:26px 28px;font-size:15px;line-height:1.65;color:#1f2937">${bodyHtml}
   <div style="text-align:center;margin:28px 0 8px">
    <a href="${url}" style="background:#111827;color:#ffffff;text-decoration:none;font-weight:800;font-size:15px;padding:14px 36px;border-radius:999px;display:inline-block">🏀 Grab your spot</a>
   </div>
  </div>
  <div style="padding:16px 28px;font-size:11px;color:#6b7280;text-align:center">
   More touches. More involvement. More fun.<br><a href="${unsub}" style="color:#6b7280">Unsubscribe</a>
  </div>
 </div>
</div>`,
  },
  minimal: {
    name: 'Minimal — personal, looks hand-written',
    render: ({ bodyHtml, url, unsub }) => `
<div style="background:#ffffff;padding:28px 16px;font-family:Georgia,'Times New Roman',serif">
 <div style="max-width:560px;margin:0 auto;font-size:17px;line-height:1.75;color:#111111">${bodyHtml}
  <p style="margin:24px 0"><a href="${url}" style="color:#c2410c;font-weight:700;font-size:17px">Register here →</a></p>
  <hr style="border:none;border-top:1px solid #d1d5db;margin:28px 0 12px">
  <p style="font-size:12px;color:#6b7280">Midwest 3 on 3 Basketball · <a href="${unsub}" style="color:#6b7280">Unsubscribe</a></p>
 </div>
</div>`,
  },
};
function buildReminderHtml(tpl, ev, d) {
  const { subject, body } = renderReminderTemplate(tpl, ev, d);
  const url = d?.source ? (String(d.source).startsWith('http') ? d.source : `https://www.midwest3on3.com${d.source}`) : 'https://www.midwest3on3.com/leagues';
  const design = REMINDER_DESIGNS[tpl.design] || REMINDER_DESIGNS.classic;
  const html = design.render({ bodyHtml: body.replace(/\n/g, '<br>'), title: ev.name.replace(/^20\d\d\s*/, ''), url, unsub: '*|UNSUB|*' });
  return { subject, html };
}

function mcApi(s) {
  const dc = (String(s.mailchimpKey).match(/-(\w+)$/) || [])[1];
  const base = `https://${dc}.api.mailchimp.com/3.0`;
  const auth = { auth: { username: 'any', password: s.mailchimpKey }, timeout: 30000 };
  return { base, auth, list: s.mailchimpListId };
}

app.get('/api/admin/reminders/templates', auth.requireRole('admin'), async (req, res) => {
  res.json({ templates: await reminderTemplates() });
});
app.put('/api/admin/reminders/templates', auth.requireRole('admin'), async (req, res) => {
  const list = (req.body?.templates || []).filter(t => t && t.id && t.name && t.subject && t.body)
    .map(t => ({ id: String(t.id).slice(0, 60), name: String(t.name).slice(0, 80), subject: String(t.subject).slice(0, 200), body: String(t.body).slice(0, 8000), design: REMINDER_DESIGNS[t.design] ? t.design : 'classic' }));
  if (!list.length) return res.status(400).json({ error: 'templates array required' });
  await kvSet('reminders:templates', list);
  res.json({ ok: true, count: list.length });
});

// Audience overview: every open event with its past editions + lapsed count.
// Computing this reads every matched event's full result rows — expensive on
// Convex bandwidth — so it's cached for the day; ?refresh=1 forces a recompute.
app.get('/api/admin/reminders/audiences', auth.requireRole('admin'), async (req, res) => {
  try {
    const today0 = store.todayCDT();
    const cached = await kvGet('reminders:audience-cache');
    if (cached && cached.day === today0 && req.query.refresh !== '1') {
      return res.json({ audiences: cached.audiences, cachedAt: cached.at });
    }
    const db = await store.load();
    const dl = (await kvGet('deadlines:all')) || {};
    const all = Object.values(db.events);
    const today = store.todayCDT();
    // Registration open/closed is determined by the site's deadline dates —
    // open while the final deadline (or early-bird, if that's all we know) is
    // today or later. SE status is only the fallback when no deadlines exist.
    const open = all.filter(e => {
      const d = dl[String(e.id)];
      const last = d?.finalDeadline || d?.earlyBird;
      return last ? last >= today : e.status === 1;
    });
    const out = [];
    for (const ev of open) {
      const past = pastEditionsOf(ev, all).filter(p => (db.events[String(p.id)]?.resultCount ?? p.resultCount ?? 0) > 0);
      if (!past.length) continue;
      const lapsed = req.query.counts === '0' ? null : await lapsedContactsFor(ev, past.slice(0, 3), db);
      out.push({
        eventId: String(ev.id), name: ev.name, deadlines: dl[String(ev.id)] || null,
        registered: ev.resultCount || 0,
        past: past.slice(0, 3).map(p => ({ id: String(p.id), name: p.name, registered: db.events[String(p.id)]?.resultCount ?? p.resultCount ?? 0 })),
        lapsed: lapsed ? lapsed.length : null,
      });
    }
    out.sort((a, b) => String(a.deadlines?.finalDeadline || '9999').localeCompare(String(b.deadlines?.finalDeadline || '9999')));
    await kvSet('reminders:audience-cache', { day: today0, at: new Date().toISOString(), audiences: out });
    res.json({ audiences: out });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Send (or test-send) one reminder: template × event → Mailchimp campaign
app.post('/api/admin/reminders/send', auth.requireRole('admin'), async (req, res) => {
  try {
    const { eventId, templateId, testEmail } = req.body || {};
    const s = await assistantSettings();
    if (!s.mailchimpKey || !s.mailchimpListId) return res.status(400).json({ error: 'Mailchimp key/audience not configured on the Site Assistant page' });
    const db = await store.load();
    const ev = db.events[String(eventId)];
    if (!ev) return res.status(404).json({ error: 'event not found' });
    const tpl = (await reminderTemplates()).find(t => t.id === templateId);
    if (!tpl) return res.status(404).json({ error: 'template not found' });
    const d = ((await kvGet('deadlines:all')) || {})[String(eventId)] || null;
    const past = pastEditionsOf(ev, Object.values(db.events)).slice(0, 3);
    const contacts = await lapsedContactsFor(ev, past, db);
    if (!contacts.length) return res.status(400).json({ error: 'no lapsed contacts for this event' });
    const { base, auth: mcAuth, list } = mcApi(s);
    const { subject, html } = buildReminderHtml(tpl, ev, d);
    // ensure the per-person merge field exists (FNAME is built in)
    await axios.post(`${base}/lists/${list}/merge-fields`, { tag: 'PASTLG', name: 'Past League', type: 'text' }, mcAuth).catch(() => {});
    const short = ev.name.replace(/^20\d\d\s*/, '').replace(/\s*3 on 3.*$/i, '').trim();
    const year = (ev.name.match(/\b20\d\d\b/) || [])[0] || '';
    // Test mode: only the test address is touched — real contacts are NOT
    // pushed to Mailchimp until an actual send.
    const batch = testEmail
      ? [{ email: String(testEmail).toLowerCase().trim(), fn: 'Test', ln: 'Preview', pastLeague: contacts[0].pastLeague }]
      : contacts.slice(0, 2000);
    for (let i = 0; i < batch.length; i += 10) {
      await Promise.all(batch.slice(i, i + 10).map(c => {
        const hash = cryptoLib.createHash('md5').update(c.email).digest('hex');
        return axios.put(`${base}/lists/${list}/members/${hash}`, {
          email_address: c.email, status_if_new: 'subscribed',
          merge_fields: { FNAME: c.fn, LNAME: c.ln, PASTLG: c.pastLeague },
        }, mcAuth).then(() => testEmail ? null : axios.post(`${base}/lists/${list}/members/${hash}/tags`, { tags: [{ name: `Lapsed: ${short} ${year}`, status: 'active' }] }, mcAuth)).catch(() => null);
      }));
    }
    // static segment → campaign → content → send
    const seg = await axios.post(`${base}/lists/${list}/segments`, { name: `${tpl.id} · ${short} ${year} · ${store.todayCDT()}`, static_segment: batch.map(c => c.email) }, mcAuth);
    const camp = await axios.post(`${base}/campaigns`, {
      type: 'regular',
      recipients: { list_id: list, segment_opts: { saved_segment_id: seg.data.id } },
      settings: { subject_line: subject, title: `${tpl.name} — ${short} ${year}`, from_name: 'Midwest 3 on 3 Basketball', reply_to: (await axios.get(`${base}/lists/${list}`, mcAuth)).data.campaign_defaults.from_email },
    }, mcAuth);
    await axios.put(`${base}/campaigns/${camp.data.id}/content`, { html }, mcAuth);
    if (testEmail) {
      const addrs = String(testEmail).split(/[,;\s]+/).map(x => x.trim()).filter(x => EMAIL_RE.test(x)).slice(0, 10);
      if (!addrs.length) return res.status(400).json({ error: 'no valid test email addresses' });
      await axios.post(`${base}/campaigns/${camp.data.id}/actions/test`, { test_emails: addrs, send_type: 'html' }, mcAuth);
      return res.json({ ok: true, test: true, to: addrs.join(', '), recipients: contacts.length, campaignId: camp.data.id });
    }
    await axios.post(`${base}/campaigns/${camp.data.id}/actions/send`, {}, mcAuth);
    await appendCapped('reminders:campaigns', {
      at: new Date().toISOString(), campaignId: camp.data.id, eventId: String(eventId), eventName: ev.name,
      templateId: tpl.id, templateName: tpl.name, recipients: batch.length, subject,
    }, 200);
    res.json({ ok: true, sent: batch.length, campaignId: camp.data.id });
  } catch (err) { res.status(500).json({ error: err.response?.data?.detail || err.message }); }
});

// Rendered preview of a template in its chosen design, using a real event's
// live data and a sample recipient — shown in an iframe on the Reminders page.
app.post('/api/admin/reminders/preview', auth.requireRole('admin'), async (req, res) => {
  try {
    const { templateId, eventId, design, template } = req.body || {};
    // inline template = live preview of unsaved edits from the editor
    const tpl = template?.subject && template?.body
      ? { id: 'inline', ...template }
      : { ...((await reminderTemplates()).find(t => t.id === templateId) || {}) };
    if (!tpl.id) return res.status(404).json({ error: 'template not found' });
    if (design) tpl.design = design;
    const db = await store.load();
    const dl = (await kvGet('deadlines:all')) || {};
    const ev = db.events[String(eventId)] || Object.values(db.events).find(e => e.status === 1 && dl[String(e.id)]) || Object.values(db.events)[0];
    const { subject, html } = buildReminderHtml(tpl, ev, dl[String(ev.id)] || null);
    res.json({
      subject: subject.replaceAll('*|FNAME|*', 'Jamie'),
      html: html.replaceAll('*|FNAME|*', 'Jamie').replaceAll('*|PASTLG|*', ev.name.replace(/\b20\d\d\b/, (y) => String(Number(y) - 1))).replaceAll('*|UNSUB|*', '#'),
      designs: Object.entries(REMINDER_DESIGNS).map(([id, dsn]) => ({ id, name: dsn.name })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Sent history + open/click stats pulled from Mailchimp Reports
app.get('/api/admin/reminders/history', auth.requireRole('admin'), async (req, res) => {
  try {
    const log = (await kvGet('reminders:campaigns')) || [];
    const s = await assistantSettings();
    if (s.mailchimpKey && req.query.stats === '1') {
      const { base, auth: mcAuth } = mcApi(s);
      await Promise.all(log.slice(0, 25).map(async (c) => {
        try {
          const r = await axios.get(`${base}/reports/${c.campaignId}`, mcAuth);
          c.stats = { sent: r.data.emails_sent, opens: r.data.opens?.unique_opens, openRate: r.data.opens?.open_rate, clicks: r.data.clicks?.unique_clicks, unsubs: r.data.unsubscribed };
        } catch {}
      }));
    }
    res.json({ campaigns: log });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


  return {
    _test: { pastEditionsOf, renderReminderTemplate, buildReminderHtml, REMINDER_DESIGNS, reminderTemplates },
  };
};
