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
const { kvGet, kvSet, appendCapped, chatLog, chatLogRecent } = require('./kv');

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
    id: 'open-announcement', name: '📣 Registration is open', subject: '{{TARGET_LEAGUE}} is open!',
    design: 'court',
    preheader: 'No practices, no long weekends — just games. Early-bird pricing is live.',
    body: `Hi {{FIRST_NAME}},\n\nGood news — {{TARGET_LEAGUE}} just opened up, and we'd love to see your player back on the court.\n\nYou were with us for {{PAST_LEAGUE}}, so you know how it goes: no practices, no long weekends. Just games, way more touches, and every kid actually plays.\n\nEarly-bird pricing is live until {{EB_DATE}}, and registration closes for good on {{FR_DATE}}.\n\n{{EVENT_DETAILS}}\n\nSee you on the court,\nMidwest 3 on 3 Basketball`,
  },
  {
    id: 'early-bird-week', name: '⏰ Early-bird — 1 week left', subject: 'One week left for {{TARGET_LEAGUE}} early-bird pricing',
    design: 'court',
    preheader: 'Early-bird ends {{EB_DATE}}. After that the price goes up.',
    body: `Hi {{FIRST_NAME}},\n\nQuick heads-up: early-bird pricing for {{TARGET_LEAGUE}} ends {{EB_DATE}} — one week from today. After that the price goes up, and registration closes for good on {{FR_DATE}}.\n\nYour player was with us for {{PAST_LEAGUE}}, so you already know the format: no practices, just games, and everybody plays.\n\nGrabbing your team's spot takes about two minutes.\n\n{{EVENT_DETAILS}}\n\nMidwest 3 on 3 Basketball`,
  },
  {
    id: 'deadline-2-days', name: '🚨 Deadline — 2 days left', subject: 'Last chance: {{TARGET_LEAGUE}} closes in 2 days',
    design: 'court', showPrices: false,
    preheader: 'Registration closes {{FR_DATE}} — after that we build the schedule.',
    body: `Hi {{FIRST_NAME}},\n\nLast call — registration for {{TARGET_LEAGUE}} closes {{FR_DATE}}, just two days out. Once it closes we start building the schedule, and we can't squeeze teams in after that.\n\nYou were with us for {{PAST_LEAGUE}}, and we'd hate for your player to sit this season out.\n\nIf you've been meaning to sign up, now's the moment.\n\n{{EVENT_DETAILS}}\n\nMidwest 3 on 3 Basketball`,
  },

  // ── A/B/C/D test variants ──────────────────────────────────────────────────
  // Same offer, four points on the designed→personal spectrum, to find out
  // which actually gets opened rather than arguing about it. Delete the losers
  // once the numbers are in.
  {
    id: 'var-a-designed', name: 'A · Designed (Court)', subject: 'One week left for {{TARGET_LEAGUE}} early-bird pricing',
    design: 'court',
    preheader: 'Early-bird ends {{EB_DATE}}. After that the price goes up.',
    body: `Hi {{FIRST_NAME}},\n\nQuick heads-up: early-bird pricing for {{TARGET_LEAGUE}} ends {{EB_DATE}} — one week from today. After that the price goes up, and registration closes for good on {{FR_DATE}}.\n\nYour player was with us for {{PAST_LEAGUE}}, so you already know the format: no practices, just games, and everybody plays.\n\n{{EVENT_DETAILS}}\n\nMidwest 3 on 3 Basketball`,
  },
  {
    id: 'var-b-simple', name: 'B · Simple card, no price box', subject: '{{TARGET_LEAGUE}} — early-bird ends {{EB_DATE}}',
    design: 'classic', showPrices: false,
    preheader: 'A quick reminder before the price changes.',
    body: `Hi {{FIRST_NAME}},\n\nA quick reminder that early-bird pricing for {{TARGET_LEAGUE}} ends {{EB_DATE}}, and registration closes {{FR_DATE}}.\n\nYour player was with us for {{PAST_LEAGUE}} — we'd love to have them back.\n\n{{EVENT_DETAILS}}\n\nMidwest 3 on 3 Basketball`,
  },
  {
    id: 'var-c-note', name: 'C · Short personal note', subject: 'Are you playing again this year?',
    design: 'plain', showPrices: false, fromName: 'Christy at Midwest 3 on 3',
    preheader: 'Just checking before early-bird pricing ends.',
    body: `Hi {{FIRST_NAME}},\n\nI was going through our {{PAST_LEAGUE}} teams and noticed you haven't signed up for this year yet.\n\nEarly-bird pricing ends {{EB_DATE}} and registration closes {{FR_DATE}}, so I wanted to check before the price goes up. If you're in, you can {{REGISTER_LINK}}.\n\nIf you're not playing this year, no problem at all — just ignore this.\n\nChristy\nMidwest 3 on 3 Basketball`,
  },
  {
    id: 'var-d-casual', name: 'D · Least promo — casual check-in', subject: "hey, didn't hear from you this year",
    design: 'plain', showPrices: false, fromName: 'Sarah at Midwest 3 on 3',
    preheader: 'Early-bird ends {{EB_DATE}} — thought I would check in.',
    body: `Hey {{FIRST_NAME}},\n\nYou played with us last year in {{PAST_LEAGUE}}, but I didn't see your name on this year's list — so I thought I'd check in.\n\nEarly-bird pricing runs out {{EB_DATE}} (about a week out), and after that it goes up a bit. Registration shuts {{FR_DATE}}.\n\nSame as always — no practices, just games. If you want back in, you can {{REGISTER_LINK}}. Takes two minutes.\n\nAnd if your player's moved on to other things, totally fine — just let me know and I'll stop bugging you.\n\nSarah\nMidwest 3 on 3`,
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

function renderReminderTemplate(tpl, ev, d, utmTplId, opts = {}) {
  const rawUrl = d?.source ? (String(d.source).startsWith('http') ? d.source : `https://www.midwest3on3.com${d.source}`) : 'https://www.midwest3on3.com/leagues';
  const url = utmTplId ? utmTag(rawUrl, utmTplId, ev.name) : rawUrl;
  const fmt = (iso) => iso ? new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'soon';
  // "When / Where" block, emitted only for the facts we actually scraped —
  // a half-filled details block reads worse than none.
  const times = /^[\d:apm\s.-]+$/i.test(String(d?.eventTimes || '')) ? d.eventTimes.trim() : '';
  const details = [
    d?.eventDates ? `When: ${d.eventDates}${times ? `, ${times}` : ''}` : '',
    d?.eventLocation ? `Where: ${d.eventLocation}` : '',
  ].filter(Boolean).join('\n');
  const fill = (s) => String(s)
    .replaceAll('{{TARGET_LEAGUE}}', ev.name)
    .replaceAll('{{EB_DATE}}', fmt(d?.earlyBird))
    .replaceAll('{{FR_DATE}}', fmt(d?.finalDeadline))
    .replaceAll('{{EB_PRICE}}', d?.earlyBirdPrice ? ` ($${d.earlyBirdPrice}/team)` : '')
    .replaceAll('{{FR_PRICE}}', d?.finalPrice ? ` ($${d.finalPrice}/team)` : '')
    // Both link forms go through the click tracker. REGISTER_LINK is an
    // anchor with friendly text — a bare tracked URL in a personal-sounding
    // email looks like phishing, which is the opposite of the intended effect.
    .replaceAll('{{REGISTER_URL}}', trackedUrl(url, { c: '*|CAMPAIGN_UID|*', ev: ev.id, t: utmTplId }))
    .replaceAll('{{REGISTER_LINK}}', `<a href="${trackedUrl(url, { c: '*|CAMPAIGN_UID|*', ev: ev.id, t: utmTplId })}">sign up here</a>`)
    // Scraped event facts. The times field is often cut mid-sentence by the
    // source page ("3:30 - 9:00 PM (we accept"), so only emit it when it looks
    // like a complete range — a truncated time in a customer email is worse
    // than no time at all.
    .replaceAll('{{EVENT_DATES}}', d?.eventDates || '')
    .replaceAll('{{EVENT_LOCATION}}', d?.eventLocation || '')
    .replaceAll('{{EVENT_TIMES}}', times)
    // Designs that render their own "When / Where" card suppress the inline
    // text version, so the facts never appear twice.
    .replaceAll('{{EVENT_DETAILS}}', opts.ownsDetails ? '' : details)
    .replaceAll('{{FIRST_NAME}}', '*|FNAME|*')
    .replaceAll('{{PAST_LEAGUE}}', '*|PASTLG|*')
    .replace(/\n{3,}/g, '\n\n');   // an empty {{EVENT_DETAILS}} must not leave a gap
  const detailRows = [
    d?.eventDates ? { label: 'When', value: d.eventDates + (times ? `, ${times}` : '') } : null,
    d?.eventLocation ? { label: 'Where', value: d.eventLocation } : null,
  ].filter(Boolean);
  return { subject: fill(tpl.subject), body: fill(tpl.body), preheader: fill(tpl.preheader || ''), detailRows, url, fmt };
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
  // The default. Table-based and image-free on purpose: most clients block
  // remote images until the reader clicks "show images", so anything carrying
  // meaning (price, dates, the button) is built from text and background
  // colours and always renders. `ownsDetails` means this design draws its own
  // When/Where card, so the template body must not repeat it.
  court: {
    name: 'Court — designed, scannable, casual (default)',
    ownsDetails: true,
    render: ({ bodyHtml, title, url, unsub, details = [], ebPrice, frPrice, ebDate, preheader }) => `
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${preheader || ''}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f6;margin:0;padding:0">
 <tr><td align="center" style="padding:26px 12px">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:16px;overflow:hidden;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">

   <tr><td style="background:#ea580c;padding:26px 32px 24px">
    <div style="color:#ffe8d9;font-size:11px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase">Midwest 3 on 3 Basketball</div>
    <div style="color:#ffffff;font-size:26px;font-weight:800;line-height:1.25;margin-top:8px">${title}</div>
   </td></tr>

   <tr><td style="padding:30px 32px 4px;font-size:16px;line-height:1.65;color:#20242b">${bodyHtml}</td></tr>

   ${ebPrice && frPrice ? `<tr><td style="padding:22px 32px 4px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius:12px;overflow:hidden;border:1px solid #e3e7ee">
     <tr>
      <td width="50%" style="background:#fff7ed;padding:16px 18px;text-align:center;border-right:1px solid #e3e7ee">
       <div style="font-size:10px;font-weight:800;letter-spacing:1.5px;color:#c2410c;text-transform:uppercase">Register by ${ebDate}</div>
       <div style="font-size:30px;font-weight:800;color:#ea580c;line-height:1.1;margin-top:6px">$${ebPrice}</div>
       <div style="font-size:11px;color:#9a6b4f;margin-top:3px">per team</div>
      </td>
      <td width="50%" style="background:#f7f8fa;padding:16px 18px;text-align:center">
       <div style="font-size:10px;font-weight:800;letter-spacing:1.5px;color:#8a919e;text-transform:uppercase">After that</div>
       <div style="font-size:30px;font-weight:800;color:#aab1bd;line-height:1.1;margin-top:6px;text-decoration:line-through">$${frPrice}</div>
       <div style="font-size:11px;color:#a8afba;margin-top:3px">per team</div>
      </td>
     </tr>
    </table>
   </td></tr>` : ''}

   ${details.length ? `<tr><td style="padding:22px 32px 4px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f8fa;border-left:4px solid #ea580c;border-radius:0 10px 10px 0">
     <tr><td style="padding:16px 18px">
      ${details.map((r, i) => `<div style="${i ? 'margin-top:12px;' : ''}">
       <div style="font-size:10px;font-weight:800;letter-spacing:1.5px;color:#8a919e;text-transform:uppercase">${r.label}</div>
       <div style="font-size:15px;color:#20242b;margin-top:2px;line-height:1.5">${r.value}</div>
      </div>`).join('')}
     </td></tr>
    </table>
   </td></tr>` : ''}

   <tr><td align="center" style="padding:28px 32px 8px">
    <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${url}" style="height:52px;v-text-anchor:middle;width:280px" arcsize="16%" fillcolor="#ea580c" stroke="f"><w:anchorlock/><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:17px;font-weight:bold">Grab our spot →</center></v:roundrect><![endif]-->
    <!--[if !mso]><!-- -->
    <a href="${url}" style="background:#ea580c;color:#ffffff;text-decoration:none;font-weight:800;font-size:17px;padding:16px 44px;border-radius:10px;display:inline-block">Grab our spot →</a>
    <!--<![endif]-->
   </td></tr>

   <tr><td style="padding:18px 32px 26px;text-align:center;font-size:13px;color:#8a919e;line-height:1.6">
    Questions? Just reply to this email — a real person reads it.
   </td></tr>

   <tr><td style="background:#f7f8fa;padding:18px 32px;text-align:center;font-size:11px;color:#98a0ac;line-height:1.7;border-top:1px solid #e9edf3">
    You're getting this because your family played in a Midwest 3 on 3 league.<br>
    <a href="${unsub}" style="color:#98a0ac;text-decoration:underline">Unsubscribe</a>
   </td></tr>

  </table>
 </td></tr>
</table>`,
  },
  // No chrome at all: no card, no header, no button. This is what a person
  // typing in Gmail actually produces, and it is the variant most likely to
  // land in the Primary tab — because it genuinely isn't a designed promotion.
  plain: {
    name: 'Plain — reads like a normal typed email',
    render: ({ bodyHtml, unsub, preheader }) => `
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${preheader || ''}</div>
<div style="font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#222222;max-width:560px;padding:10px 4px">
${bodyHtml}
<div style="font-size:11px;color:#999999;margin-top:28px">
 Midwest 3 on 3 Basketball · <a href="${unsub}" style="color:#999999">unsubscribe</a>
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
// GA4 attribution: every reminder link carries UTM tags so Google
// Analytics shows exactly how many sessions each league's reminder drove
// (source=reminders, campaign=<template>-<league-slug>).
function utmTag(url, tplId, evName) {
  const slug = String(evName || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const sep = url.includes('?') ? '&' : '?';
  return url + sep + 'utm_source=reminders&utm_medium=email&utm_campaign=' + encodeURIComponent((tplId || 'reminder') + '-' + slug);
}

/**
 * Wrap a destination in the click tracker.
 *
 * `*|EMAIL|*` and `*|CAMPAIGN_UID|*` are Mailchimp merge tags: Mailchimp
 * substitutes each recipient's own address at send time, so the click that
 * arrives back identifies the family. They are intentionally NOT
 * url-encoded — Mailchimp only substitutes tags it can still recognise.
 * A test/preview render (no Mailchimp) just logs a null email.
 */
function trackedUrl(dest, { c, ev, t }) {
  const base = (process.env.PUBLIC_BASE_URL || 'https://midwest-data-explorer.vercel.app').replace(/\/$/, '');
  const q = new URLSearchParams({ u: dest, ev: String(ev || ''), t: String(t || '') });
  return `${base}/api/r?${q.toString()}&e=*|EMAIL|*&c=${c}`;
}

function buildReminderHtml(tpl, ev, d) {
  const design = REMINDER_DESIGNS[tpl.design] || REMINDER_DESIGNS.court;
  const { subject, body, preheader: rawPre, detailRows } = renderReminderTemplate(tpl, ev, d, tpl.id, { ownsDetails: !!design.ownsDetails });
  const rawUrl = d?.source ? (String(d.source).startsWith('http') ? d.source : `https://www.midwest3on3.com${d.source}`) : 'https://www.midwest3on3.com/leagues';
  const url = trackedUrl(utmTag(rawUrl, tpl.id, ev.name), { c: '*|CAMPAIGN_UID|*', ev: ev.id, t: tpl.id });
  const shortDate = (iso) => iso ? new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  // Preheader = the grey line inboxes show next to the subject. Left empty it
  // leaks the first words of the body, so set it deliberately.
  const preheader = String(rawPre || body).replace(/\s+/g, ' ').replace('*|FNAME|*', 'there').trim().slice(0, 110);
  const html = design.render({
    bodyHtml: body.replace(/\n/g, '<br>'),
    title: ev.name.replace(/^20\d\d\s*/, ''),
    url, unsub: '*|UNSUB|*', preheader,
    details: detailRows,
    // The early-bird/full-price strip is meaningless once early-bird has
    // passed, so the final-deadline template opts out (showPrices: false).
    ebPrice: tpl.showPrices === false ? null : (d?.earlyBirdPrice || null),
    frPrice: tpl.showPrices === false ? null : (d?.finalPrice || null),
    ebDate: shortDate(d?.earlyBird),
    frDate: shortDate(d?.finalDeadline),
  });
  // Explicit plain-text alternative. Mailchimp auto-generates one by
  // flattening the HTML, which silently drops anything living in a table —
  // i.e. the price strip and the When/Where card, the two most useful facts in
  // the email. Rendered again with details inline so nothing is lost.
  const inline = renderReminderTemplate(tpl, ev, d, tpl.id, { ownsDetails: false });
  const priceLine = (tpl.showPrices !== false && d?.earlyBirdPrice && d?.finalPrice)
    ? `Register by ${shortDate(d.earlyBird)}: $${d.earlyBirdPrice}/team (then $${d.finalPrice}/team)` : '';
  const plainText = [inline.body.replace(/<a [^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g, '$2: $1').replace(/<[^>]+>/g, ''),
    priceLine, `Register: ${url}`, 'Unsubscribe: *|UNSUB|*']
    .filter(Boolean).join('\n\n');
  return { subject, html, plainText, fromName: tpl.fromName || null };
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
    .map(t => ({
      id: String(t.id).slice(0, 60), name: String(t.name).slice(0, 80),
      subject: String(t.subject).slice(0, 200), body: String(t.body).slice(0, 8000),
      // Keep every field the renderer reads — anything omitted here is
      // silently lost the first time an admin saves a template.
      preheader: String(t.preheader || '').slice(0, 200),
      showPrices: t.showPrices !== false,
      fromName: String(t.fromName || '').slice(0, 80) || undefined,
      design: REMINDER_DESIGNS[t.design] ? t.design : 'court',
    }));
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
    const { subject, html, plainText, fromName } = buildReminderHtml(tpl, ev, d);
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
    // Segment names must be unique in Mailchimp: without the clock suffix a
    // second send of the same template/league on the same day fails with
    // "Sorry, that tag already exists." — which is exactly what a retry after
    // a partial failure looks like. Test segments are labelled so they are
    // obvious in the Mailchimp UI.
    const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
    const segName = `${testEmail ? 'TEST ' : ''}${tpl.id} · ${short} ${year} · ${store.todayCDT()} ${stamp}`;
    const seg = await axios.post(`${base}/lists/${list}/segments`, { name: segName, static_segment: batch.map(c => c.email) }, mcAuth);
    const camp = await axios.post(`${base}/campaigns`, {
      type: 'regular',
      recipients: { list_id: list, segment_opts: { saved_segment_id: seg.data.id } },
      settings: { subject_line: subject, title: `${tpl.name} — ${short} ${year}`, from_name: fromName || 'Midwest 3 on 3 Basketball', reply_to: (await axios.get(`${base}/lists/${list}`, mcAuth)).data.campaign_defaults.from_email },
    }, mcAuth);
    // Mailchimp does not reliably expand merge tags on *test* sends, so a test
    // click would arrive with a literal "*|EMAIL|*" and be logged anonymously —
    // making click tracking look broken exactly when you're checking it. For a
    // test we bake the address straight into the tracked link, and mark it so
    // the dashboard can separate test clicks from real ones.
    const firstTest = testEmail ? String(testEmail).split(/[,;\s]+/)[0].trim().toLowerCase() : '';
    const contentHtml = testEmail
      ? html.replaceAll('*|EMAIL|*', encodeURIComponent(firstTest)).replaceAll('*|CAMPAIGN_UID|*', 'test') + ''
      : html;
    await axios.put(`${base}/campaigns/${camp.data.id}/content`, { html: contentHtml, plain_text: plainText }, mcAuth);
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

// Deliverability posture: the things that actually decide inbox vs Promotions.
// Domain authentication is the big one and it needs DNS records on the
// sending domain, so it has to be reported rather than fixed in code.
app.get('/api/admin/reminders/deliverability', auth.requireRole('admin'), async (req, res) => {
  try {
    const s = await assistantSettings();
    if (!s.mailchimpKey || !s.mailchimpListId) return res.status(400).json({ error: 'Mailchimp not configured' });
    const { base, auth: mcAuth, list } = mcApi(s);
    const [vd, l, acct, lists, camps] = await Promise.all([
      axios.get(`${base}/verified-domains`, mcAuth).catch(() => ({ data: { domains: [] } })),
      axios.get(`${base}/lists/${list}`, mcAuth),
      axios.get(`${base}/`, mcAuth).catch(() => ({ data: {} })),
      axios.get(`${base}/lists?count=50`, mcAuth).catch(() => ({ data: { lists: [] } })),
      // How the org's own past emails actually performed — the only honest
      // baseline for "are people responding?".
      axios.get(`${base}/campaigns?count=25&status=sent&sort_field=send_time&sort_dir=DESC`, mcAuth)
        .catch(() => ({ data: { campaigns: [] } })),
    ]);
    const fromEmail = l.data.campaign_defaults?.from_email || '';
    const fromDomain = (fromEmail.split('@')[1] || '').toLowerCase();
    const domains = (vd.data.domains || []).map(d => ({
      domain: d.domain, verified: !!d.verified, authenticated: !!d.authenticated,
    }));
    const match = domains.find(d => d.domain.toLowerCase() === fromDomain);
    res.json({
      fromEmail, fromName: l.data.campaign_defaults?.from_name || '',
      members: l.data.stats?.member_count ?? null,
      domains,
      account: {
        name: acct.data?.account_name || null,
        plan: acct.data?.pricing_plan_type || null,   // free | monthly | pay_as_you_go
        totalSubscribers: acct.data?.total_subscribers ?? null,
      },
      audiences: (lists.data.lists || []).map(x => ({
        id: x.id, name: x.name, members: x.stats?.member_count ?? 0,
        avgOpenRate: x.stats?.open_rate ?? null, avgClickRate: x.stats?.click_rate ?? null,
      })),
      smsProbe: req.query.sms === '1' ? await (async () => {
        try {
          const m = await axios.get(base + '/lists/' + list + '/members?count=1', mcAuth);
          const one = (m.data.members || [])[0] || {};
          const mf = await axios.get(base + '/lists/' + list + '/merge-fields?count=50', mcAuth);
          return { hasSmsFields: 'sms_subscription_status' in one || 'sms_phone_number' in one, memberKeys: Object.keys(one).filter(k => /sms|phone/i.test(k)), mergeFields: (mf.data.merge_fields || []).map(f => f.tag + ':' + f.type) };
        } catch (e) { return { error: e.response?.status || e.message }; }
      })() : undefined,
      pastCampaigns: (camps.data.campaigns || []).map(c => ({
        title: c.settings?.title || c.settings?.subject_line || '(untitled)',
        subject: c.settings?.subject_line || '',
        sentAt: c.send_time || null,
        emails: c.emails_sent ?? null,
        openRate: c.report_summary?.open_rate ?? null,
        clickRate: c.report_summary?.click_rate ?? null,
      })),
      dkimAuthenticated: !!match?.authenticated,
      domainVerified: !!match?.verified,
      // Plain-language checklist for the UI.
      checks: [
        { id: 'auth', ok: !!match?.authenticated, label: 'Sending domain authenticated (DKIM/SPF)',
          detail: match?.authenticated
            ? `${fromDomain} is authenticated — mail is signed as you.`
            : `${fromDomain || 'the from-address domain'} is NOT authenticated. Mailchimp sends "via mailchimpapp.net", which Gmail treats as bulk marketing. Fix in Mailchimp → Website → Domains → Authenticate (adds DNS records).` },
        { id: 'reply', ok: /@/.test(fromEmail) && !/no-?reply/i.test(fromEmail), label: 'Replyable from-address',
          detail: /no-?reply/i.test(fromEmail) ? 'A no-reply address is a promotions signal.' : `Replies go to ${fromEmail}.` },
      ],
    });
  } catch (err) { res.status(500).json({ error: err.response?.data?.detail || err.message }); }
});

// ── Click tracking ───────────────────────────────────────────────────────────
// Mailchimp reports *how many* people clicked; it does not readily tell us
// *who*. Every CTA is rewritten to point here with the recipient's address
// carried in Mailchimp's *|EMAIL|* merge tag, so we record the identity, then
// 302 on to the real page. That turns "412 clicks" into a named warm list we
// can cross-reference against who actually registered.
//
// Destination is validated against an allowlist: an open redirector on our
// own domain would be a gift to phishers, who would send "midwest…/api/r?u=
// <malicious>" links that look like ours.
const CLICK_ALLOWED_HOSTS = [
  'midwest3on3.com', 'www.midwest3on3.com',
  'sportsengine.com', 'www.sportsengine.com',
  'midwest3on3.sportngin.com', 'sportngin.com',
];
function clickDestinationOk(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const h = u.hostname.toLowerCase();
    return CLICK_ALLOWED_HOSTS.some(a => h === a || h.endsWith('.' + a));
  } catch { return false; }
}

app.get('/api/r', async (req, res) => {
  const dest = String(req.query.u || '');
  const fallback = 'https://www.midwest3on3.com/leagues';
  const target = clickDestinationOk(dest) ? dest : fallback;
  try {
    // Serverless kills fire-and-forget work, so the log is awaited before the
    // redirect goes out (DEVELOPERS.md §8).
    const email = String(req.query.e || '').toLowerCase().trim();
    await chatLog('reminder-click', {
      at: new Date().toISOString(),
      email: EMAIL_RE.test(email) ? email : null,
      campaignId: String(req.query.c || '') || null,
      eventId: String(req.query.ev || '') || null,
      templateId: String(req.query.t || '') || null,
      dest: target,
      blocked: target !== dest && !!dest,     // someone tried an off-allowlist URL
      ua: String(req.get('user-agent') || '').slice(0, 180),
    });
  } catch { /* never let logging break the parent's click-through */ }
  res.redirect(302, target);
});

// Who clicked — joined against this year's registrants so the office can see
// the warm-but-not-registered families, which is the actionable list.
app.get('/api/admin/reminders/clicks', auth.requireRole('admin'), async (req, res) => {
  try {
    const rows = await chatLogRecent('reminder-click', 500);
    const db = await store.load();
    // Who is already registered for the event each click came from. Same
    // helper the audience math uses, so "registered" means the same thing in
    // both places.
    const registeredFor = {};
    for (const evId of [...new Set(rows.map(r => r.eventId).filter(Boolean))]) {
      const regRows = (await loadContactResults(db, [String(evId)])).filter(r => String(r.eventId) === String(evId));
      const set = new Set();
      for (const r of regRows) {
        for (const e of (r.emails?.length ? r.emails : (r.email ? [r.email] : []))) set.add(String(e).toLowerCase().trim());
      }
      registeredFor[evId] = set;
    }
    const byEmail = new Map();
    for (const r of rows) {
      if (!r.email) continue;
      const k = r.email + '|' + (r.campaignId || '');
      const prev = byEmail.get(k);
      if (prev) { prev.clicks++; if (r.at > prev.lastAt) prev.lastAt = r.at; continue; }
      byEmail.set(k, {
        email: r.email, campaignId: r.campaignId, eventId: r.eventId,
        templateId: r.templateId, firstAt: r.at, lastAt: r.at, clicks: 1,
        registered: registeredFor[r.eventId]?.has(r.email) || false,
      });
    }
    const clicks = [...byEmail.values()].sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
    res.json({
      clicks,
      totals: {
        uniqueClickers: clicks.length,
        totalClicks: rows.filter(r => r.email).length,
        // Clicks we could not attribute (forwarded email, a client that
        // stripped the tag). Reported rather than dropped — a silent zero
        // looks identical to "tracking is broken".
        unidentifiedClicks: rows.filter(r => !r.email).length,
        testClicks: rows.filter(r => r.campaignId === 'test').length,
        registeredAfterClick: clicks.filter(c => c.registered).length,
        warmNotRegistered: clicks.filter(c => !c.registered).length,
        blockedRedirects: rows.filter(r => r.blocked).length,
      },
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
