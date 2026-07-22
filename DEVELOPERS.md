# Developer Guide — Midwest 3on3 Data Explorer

A practical manual for humans (and AI assistants) editing this app without
breaking it. Read this before touching code. For a plain-language architecture
overview, also see `graphify-out/GRAPH_REPORT.md`.

---

## 1. What this app is

A registration analytics + marketing platform for youth 3-on-3 basketball
leagues (SportsEngine data), being productized into multi-tenant SaaS.
Main capabilities:

| Area | What it does | Where |
|---|---|---|
| Dashboard / reports | YoY charts, stats, event explorer | `client/src/pages/*`, report endpoints in `server/index.js` |
| Smart Update | Incremental sync from SportsEngine GraphQL | `server/index.js` (sync section), `server/convexSync.js` |
| Deadlines | Scrape EB/final deadlines from midwest3on3.com, manual overrides | `server/index.js` (`scrape-deadlines`, `/api/deadlines`), `client/src/components/DeadlinesCard.jsx` |
| Sarah (Site Assistant) | Embeddable AI chat widget for midwest3on3.com — live prices/deadlines, FAQ bank, lead capture → Mailchimp + Meta CAPI | `server/index.js` (SARAH section), `client/src/pages/Assistant.jsx`, widget served at `GET /api/widget.js` |
| Reminders | Lapsed-registrant win-back email campaigns via Mailchimp | `server/index.js` (REMINDERS section), `client/src/pages/Reminders.jsx` |
| FB Audiences | Contact preview/export CSVs for Meta Custom Audiences | `/api/contacts/*` in `server/index.js` |
| Meta ads / tracking | CAPI events, webhook inspector, ads reporting | tracking sections in `server/index.js` |
| Platform / SaaS | Orgs, companies, users, roles, Stripe-ready billing, landing page | auth/org sections in `server/index.js`, `server/auth.js`, `server/userStore.js` |

## 2. Topology

```
client/  React 18 + Vite SPA. All API calls via client/src/api.jsx (axios).
server/  Express app being modularized (see §9 for progress):
         index.js     — routes not yet extracted + app assembly (~5.5k lines)
         assistant.js — SARAH: settings, KB, FAQ bank, intent layer, chat,
                        widget, Messenger channel, LLM queue (+ .test.mjs)
         kv.js        — KV blobs, cache, capped lists, chat logs (+ .test.mjs)
         auth.js (JWT), userStore.js (users), store.js (data store + Convex
         HTTP + usage meter), convexSync.js, aggregator.js, blobStorage.js.
api/     Vercel entry — wraps server/index.js as a serverless function.
convex/  Convex schema + functions (events, results, prefs KV, users,
         chatLogs, serverSync…). See convex/_generated/ai/guidelines.md.
```

Module pattern (established in refactor steps 1-2): each extracted module
requires node/project modules directly and receives index-local helpers via a
deps object — `require('./assistant')(app, deps)` — so moved code stays
verbatim. Pure logic is exposed through a `_test` export for unit tests
(`npm test` runs `server/*.test.mjs` with node:test). New features go IN the
module that owns the area, with a test; only wiring goes in index.js.

Deploy pipeline: **push to `main` on GitHub → Vercel auto-builds and deploys**
(midwest-data-explorer.vercel.app). Convex functions deploy separately with
`npx convex deploy` (prod deployment: trustworthy-reindeer-582).
**A git push does NOT deploy Convex, and `npx convex deploy` does not deploy
the server** — schema/function changes need both.

## 3. Dual-mode storage — the most important concept

Every persistence path has two modes, switched by `CONVEX_URL` env:

- **Local dev** (no `CONVEX_URL`): JSON files in `server/data/`
  (`store.json`, `users.json`, `prefs.json`).
- **Production** (Vercel): Convex tables via HTTP (`store.convexQuery` /
  `convexMutation` in `server/store.js`).

Rules that follow from this:

1. `store.load()` in Convex mode returns `results: []` **by design** (never
   load 30k rows). Per-event rows come from `reports:resultsByEvent`
   (see `loadContactResults()`); locally you must filter `db.results` by
   eventId yourself.
2. Small config/state lives in the **KV layer**: `kvGet(key)` / `kvSet(key, obj)`
   → one JSON blob per key in the Convex `preferences` table under userId
   `__platform` (locally: `prefs.json`). `appendCapped(key, item, cap)` is
   read-modify-write of a whole array — fine for low-volume lists (leads,
   abuse), **forbidden for high-volume logging** (see chatLogs below).
3. High-volume logs use the insert-only Convex `chatLogs` table via
   `chatLog(type, entry)` / `chatLogRecent(type, n)` (~1KB per write). The
   daily cron prunes it. If you add a new high-frequency log, add a type here
   — do NOT create a new appendCapped array.
4. Test in BOTH modes when you touch storage. Most historical bugs were
   "works locally, broken on Vercel" (see §8 gotchas).

## 4. Conventions & building blocks

- **Auth**: JWT (HS256) via `server/auth.js`. Roles: `editor < admin <
  superadmin < owner`; platform roles pass all normal gates. Guards:
  `auth.requireAuth`, `auth.requireRole('admin')`, `auth.requireAdmin`,
  `auth.requireOwner`. The role is **baked into the token at login** — role
  changes require sign-out/in. Public endpoints must be listed in
  `PUBLIC_API_PATHS` in `server/index.js`.
- **Secrets at rest**: `encryptSecret` / `decryptSecret` (AES-256-GCM, blob
  format `iv:tag:data` colon-separated hex, key = `ENCRYPTION_KEY` env hex).
  API keys are write-only in the UI (masked placeholder; only overwrite when
  the user types a new value — see the `/^•+$/` pattern).
- **Caching** (added after Convex bandwidth incidents — keep these healthy):
  - `kvGetCached(key, ttl=5min)` — in-instance memo for hot KV blobs
    (assistant KB/FAQ/settings, deadlines). `kvSet` invalidates same-instance.
  - `loadDbCachedForChat()` — 5-min events snapshot for the chat path only.
    Everything else calls `store.load()` fresh (write flows depend on it).
  - `reminders:audience-cache` — lapsed audiences computed once/day
    (`?refresh=1` forces).
- **Usage metering**: `server/store.js` measures every Convex round-trip;
  flushed to `usage:convex:YYYY-MM-DD` KV buckets (max once/min);
  `GET /api/admin/usage` aggregates; card on the Data Mgmt page. If you add a
  heavy feature, check its cost there afterwards.
- **External sends** (Mailchimp, Meta CAPI, Resend emails): helper functions
  exist (`capiSend`, `sendEmail`, Mailchimp via `mcApi(settings)`) and are
  **dormant-safe** — without keys they no-op or return friendly fallbacks.
  Keep new integrations dormant-safe too.
- **Protected org**: `PROTECTED_ORG_KEYS` (`midwest-3on3`) can never be
  deleted, before any other guard. Do not weaken this.
- **Client**: pages in `client/src/pages/`, registered in `App.jsx` (import +
  nav link + route — nav gating by role). ALL server calls go through
  `client/src/api.jsx`; never call axios directly from a page.

## 5. How to add a feature (checklist)

1. **Server**: add endpoint(s) in the relevant section of `server/index.js`
   (sections have banner comments — search `══`). Pick the right auth guard.
   Public? Add to `PUBLIC_API_PATHS`.
2. **Convex** (only if new tables/functions needed): edit `convex/schema.ts`
   + add `convex/<module>.ts`. Read `convex/_generated/ai/guidelines.md`
   first. Deploy with `npx convex deploy`. New indexes are additive and safe;
   removing/renaming fields is a migration — see convex-migration-helper.
3. **Client**: add the api.jsx method → page/component → App.jsx import,
   nav link (role-gated), route.
4. **Verify** (§6), then commit with a descriptive message and push (= deploy).
5. If the feature stores config → use kvGet/kvSet. High-volume log → chatLog.
   Heavy reads → cache (daily KV bucket or kvGetCached) and check the usage
   card afterwards.

**Removing a feature**: delete route + api method + page + nav/route entries;
leave Convex tables in place (data is cheap, migrations are not) unless
they're large. **Never** delete Convex functions still referenced by deployed
server code — deploy order: server first, then Convex cleanup.

## 6. Testing & verification

- **Static pass** (always): `node --check server/index.js` and
  `cd client && npx vite build`.
- **Smoke suite**: `npm run smoke` (see `scripts/smoke.mjs`) — read-only
  checks against a running local server (start with `npm run dev:server`):
  auth, events, deadlines, assistant health, reminders templates, usage.
  Run it before every push; add a check when you add an endpoint.
- **Local server restart**: the dev server does NOT hot-reload `index.js`
  unless run with `--watch`; after edits, restart it (kill port 3001).
- **Admin API testing without a browser**: sign a token directly —
  ```js
  require('dotenv').config(); const auth = require('./auth');
  const users = JSON.parse(fs.readFileSync('./data/users.json'));
  const tok = auth.signToken(users.find(u => u.username === 'admin'));
  ```
  (works locally only — production has a different JWT_SECRET).
- **Browser flows**: Playwright (see `mcp playwright` or the npx-cache
  createRequire pattern in git history). Login flow: landing → "Sign in" →
  `#login-username` / `#login-password` → wait for dashboard text.
- **Production verification**: after Vercel deploys (~60-90s after push), hit
  the real endpoints (`/api/auth/login` → Bearer token → the feature) and the
  public chat (`POST /api/assistant/chat`). Never assume the deploy worked.

## 7. Environment variables

Server (`server/.env` locally, Vercel project env in prod):
`SE_CLIENT_ID/SECRET` (SportsEngine), `JWT_SECRET`, `ENCRYPTION_KEY` (hex),
`CONVEX_URL` (prod only — presence flips storage mode), `GOOGLE_CLIENT_ID/SECRET`,
`RESEND_API_KEY` + `EMAIL_FROM` (email; dormant until set), `CRON_SECRET`,
`PLATFORM_DELETES_ENABLED` (=1 enables guarded deletes), `STRIPE_*` (dormant),
`GA4_MEASUREMENT_ID`, Meta CAPI tokens (KV-stored, encrypted).
Root `.env` holds integration keys used by ops scripts (Mailchimp etc.).

## 8. Gotchas that have caused real bugs (do not relearn these)

1. **Vercel kills fire-and-forget work.** The serverless function freezes the
   moment the response is sent. `await` every side effect (Mailchimp, CAPI,
   emails, log writes) before `res.json()`. This bug shipped once already.
2. **Convex-mode empty results**: endpoints reading `db.results` directly get
   `[]` on Vercel. Use `loadContactResults` / `reports:resultsByEvent`.
3. **Role changes need re-login** (role is in the JWT). UI should show a
   helpful message on 403 rather than spinning (see Assistant.jsx pattern).
4. **Convex bandwidth is a budget.** The free/starter tier disabled the whole
   production deployment mid-day once. Don't add per-request reads of big
   blobs or per-message array rewrites; use the caching layers (§4) and watch
   the usage card. One audiences recompute ≈ 8 MB; full contact export ≈
   tens of MB.
5. **Gemini quirks**: free-tier quotas are small (Flash-Lite = best free
   limits; plain Flash ≈ 20 req/day). "Thinking" models eat output tokens —
   `thinkingConfig: { thinkingBudget: 0 }` + a 400-retry-without is required.
   Models retire; keep the model dropdown current.
6. **Widget/system-prompt formatting**: LLMs emit markdown — the widget
   renders plain text + auto-linked bare URLs; the system prompt forbids
   markdown. Keep that contract if you change either side.
7. **Windows shell mangling**: `node -e` through bash mangles template
   literals/emoji. Put nontrivial code in files (or the Edit tool), not
   inline strings.
8. **Email-safe HTML**: reminder designs use inline CSS only, ~600px, no
   external assets. Mailchimp campaign content must include `*|UNSUB|*`.
9. **Deadline scraping**: matching is name-token based; every event keeps its
   BEST-scoring page (never last-writer-wins), and manual overrides always
   win. Registration open/closed is decided by EB/FR dates, not SE status.
10. **Duplicate SE events exist** (e.g. two "2026 Spring Lake Park"). Show
    counts, don't assume names are unique.

## 9. Refactor roadmap (do incrementally, one PR each, smoke-test between)

The server monolith works but started at 6.3k lines. Safe extraction order
(each step: branch → move code VERBATIM into a deps-injected factory →
unit tests → `npm run check` + `npm run smoke` → merge only when green):

1. ✅ `server/kv.js` — kvGet/kvSet/kvGetCached/appendCapped/chatLog (+ tests).
2. ✅ `server/assistant.js` — Sarah: settings, KB, FAQ, chat, widget,
   Messenger, LLM queue (+ tests). index.js 6,317 → 5,548 lines.
3. `server/reminders.js` — templates, designs, audiences, send, preview.
4. `server/deadlines.js` — scrape/match/CRUD (+ page-parse tests).
5. `server/tracking.js` — CAPI, webhooks, Meta ads.
6. Then: `server/app.js` composition root; index.js becomes assembly only.

Rules: never change behavior and move code in the same commit; keep
`server/index.js` as the single require entry until step 6; run
`graphify . --update` after big moves so the codebase map stays true.

## 10. Working with AI assistants on this repo

`CLAUDE.md` wires up project rules (Convex guidelines, graphify map). The
memory files under the developer's Claude profile track decisions — but this
file is the source of truth for humans. When an AI adds a feature, hold it to
§5 and §6 like any other contributor.
