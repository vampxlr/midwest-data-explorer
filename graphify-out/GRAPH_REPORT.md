# Graph Report - .  (2026-07-10)

## Corpus Check
- 75 files · ~83,032 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 641 nodes · 972 edges · 47 communities (36 shown, 11 thin omitted)
- Extraction: 94% EXTRACTED · 6% INFERRED · 0% AMBIGUOUS · INFERRED: 62 edges (avg confidence: 0.55)
- Token cost: 45,000 input · 4,490 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Dashboard Chart Components|Dashboard Chart Components]]
- [[_COMMUNITY_Express Server Core|Express Server Core]]
- [[_COMMUNITY_Convex Admin Functions|Convex Admin Functions]]
- [[_COMMUNITY_Convex Reports & Codegen|Convex Reports & Codegen]]
- [[_COMMUNITY_Client Package Manifest|Client Package Manifest]]
- [[_COMMUNITY_Store & SSE Aggregator|Store & SSE Aggregator]]
- [[_COMMUNITY_Docs Convex Guidelines & Spec|Docs: Convex Guidelines & Spec]]
- [[_COMMUNITY_Root Package Manifest|Root Package Manifest]]
- [[_COMMUNITY_Blob Storage & Seeding|Blob Storage & Seeding]]
- [[_COMMUNITY_Server Package Manifest|Server Package Manifest]]
- [[_COMMUNITY_User Store (Dual-Mode)|User Store (Dual-Mode)]]
- [[_COMMUNITY_League Scatter Charts|League Scatter Charts]]
- [[_COMMUNITY_App Shell & Routing|App Shell & Routing]]
- [[_COMMUNITY_Auth & JWT Roles|Auth & JWT Roles]]
- [[_COMMUNITY_Convex TS Config|Convex TS Config]]
- [[_COMMUNITY_Demo Mode Masking|Demo Mode Masking]]
- [[_COMMUNITY_League Detail & Exports|League Detail & Exports]]
- [[_COMMUNITY_Meta Ads Page|Meta Ads Page]]
- [[_COMMUNITY_Super Admin Panel|Super Admin Panel]]
- [[_COMMUNITY_Convex Login Script|Convex Login Script]]
- [[_COMMUNITY_API Client & Auth Context|API Client & Auth Context]]
- [[_COMMUNITY_Aggregate Panel|Aggregate Panel]]
- [[_COMMUNITY_League Overlap Contacts|League Overlap Contacts]]
- [[_COMMUNITY_Vercel Deploy Config|Vercel Deploy Config]]
- [[_COMMUNITY_Analytics Page|Analytics Page]]
- [[_COMMUNITY_Registration Answer Extraction|Registration Answer Extraction]]
- [[_COMMUNITY_Org & Site Settings IO|Org & Site Settings IO]]
- [[_COMMUNITY_Data Management Page|Data Management Page]]
- [[_COMMUNITY_KV & Secret Crypto|KV & Secret Crypto]]
- [[_COMMUNITY_Users Admin Page|Users Admin Page]]
- [[_COMMUNITY_Convex Data Model Types|Convex Data Model Types]]
- [[_COMMUNITY_Convex Server Types|Convex Server Types]]
- [[_COMMUNITY_Guide Page|Guide Page]]
- [[_COMMUNITY_Query Explorer Page|Query Explorer Page]]
- [[_COMMUNITY_Convex Deploy Script|Convex Deploy Script]]
- [[_COMMUNITY_Landing Page|Landing Page]]
- [[_COMMUNITY_Convex Sync Helpers|Convex Sync Helpers]]
- [[_COMMUNITY_SportsEngine GraphQL Fetch|SportsEngine GraphQL Fetch]]
- [[_COMMUNITY_Deadline Page Parser|Deadline Page Parser]]
- [[_COMMUNITY_Deadline Token Matcher|Deadline Token Matcher]]
- [[_COMMUNITY_Vite Config|Vite Config]]
- [[_COMMUNITY_Date Window Helpers|Date Window Helpers]]
- [[_COMMUNITY_Font Asset|Font Asset]]
- [[_COMMUNITY_Convex HTTP Action|Convex HTTP Action]]
- [[_COMMUNITY_Convex Internal Action|Convex Internal Action]]

## God Nodes (most connected - your core abstractions)
1. `api` - 23 edges
2. `useAuth()` - 20 edges
3. `Convex Guidelines` - 14 edges
4. `maskDeep()` - 13 edges
5. `compilerOptions` - 13 edges
6. `AdsReport()` - 10 edges
7. `localLoad()` - 9 edges
8. `withToken()` - 8 edges
9. `DailyActivityPanel()` - 8 edges
10. `scripts` - 8 edges

## Surprising Connections (you probably didn't know these)
- `Throttled Data Sync with Progress Bar` --semantically_similar_to--> `Convex Query Guidelines (withIndex, bounded reads)`  [INFERRED] [semantically similar]
  claude_prompt.md → convex/_generated/ai/guidelines.md
- `App Entry Script /src/index.jsx` --implements--> `Registration Dashboard Objective`  [INFERRED]
  client/index.html → claude_prompt.md
- `Convex Guidelines` --conceptually_related_to--> `Registration Dashboard Objective`  [INFERRED]
  convex/_generated/ai/guidelines.md → claude_prompt.md
- `ExportHistoryEntry()` --calls--> `useAuth()`  [EXTRACTED]
  client/src/components/LeagueDetailPanel.jsx → client/src/AuthContext.jsx
- `aggregateAnswers()` --indirect_call--> `count()`  [INFERRED]
  server/index.js → server/userStore.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Registration Dashboard Plan (sync, report, visualize)** — claude_prompt_registration_dashboard_objective, claude_prompt_sportsengine_api, claude_prompt_throttled_data_sync, claude_prompt_daily_registration_reporting, claude_prompt_registration_visualizations [EXTRACTED 1.00]
- **Convex Function Lifecycle (register, reference, call)** — convex__generated_ai_guidelines_function_registration, convex__generated_ai_guidelines_function_references, convex__generated_ai_guidelines_validators, convex__generated_ai_guidelines_cron_guidelines [INFERRED 0.85]
- **Client HTML Shell (root mount + entry + Leaflet CSS)** — client_index_root_div, client_index_app_entry_script, client_index_leaflet_css, client_index_inter_font [EXTRACTED 1.00]

## Communities (47 total, 11 thin omitted)

### Community 0 - "Dashboard Chart Components"
Cohesion: 0.08
Nodes (36): react, Collapsible(), DailyActivityPanel(), fmt(), fmtFull(), todayCDT(), COUNT_OPTIONS, emptySlot() (+28 more)

### Community 1 - "Express Server Core"
Cohesion: 0.04
Nodes (26): ACCOUNTS_FILE, app, auth, axios, blobStorage, cache, convexSync, cors (+18 more)

### Community 2 - "Convex Admin Functions"
Cohesion: 0.06
Nodes (35): getSettings, listAccounts, listOrgs, removeAccount, removeOrg, setSettings, upsertAccount, upsertOrg (+27 more)

### Community 3 - "Convex Reports & Codegen"
Cohesion: 0.05
Nodes (28): api, components, internal, action, internalQuery, allEventsInternal, audiencePreview, backfillStats (+20 more)

### Community 4 - "Client Package Manifest"
Cohesion: 0.06
Nodes (33): author, browserslist, development, production, dependencies, ace-builds, axios, convex (+25 more)

### Community 5 - "Store & SSE Aggregator"
Cohesion: 0.09
Nodes (23): broadcast(), clients, extractAnswers(), getState(), log(), run(), sleep(), state (+15 more)

### Community 6 - "Docs: Convex Guidelines & Spec"
Cohesion: 0.11
Nodes (24): Daily Registration Reporting, Registration Dashboard Objective, Registration Charts (Bar and Line), SportsEngine API Credentials, Throttled Data Sync with Progress Bar, App Entry Script /src/index.jsx, Leaflet 1.9.4 CSS (CDN), Root Div Mount Point (Vite index) (+16 more)

### Community 7 - "Root Package Manifest"
Cohesion: 0.09
Nodes (22): dependencies, axios, bcryptjs, convex, cors, dotenv, express, express-rate-limit (+14 more)

### Community 8 - "Blob Storage & Seeding"
Cohesion: 0.14
Nodes (19): blobStorage, DATA_DIR, FILES_TO_SEED, fs, path, DATA_DIR, deleteAllBlobs(), deleteFile() (+11 more)

### Community 9 - "Server Package Manifest"
Cohesion: 0.09
Nodes (21): author, dependencies, axios, bcryptjs, cors, dotenv, express, express-rate-limit (+13 more)

### Community 10 - "User Store (Dual-Mode)"
Cohesion: 0.22
Nodes (21): convexMutation(), convexQuery(), count(), create(), crypto, DATA_DIR, findByEmail(), findById() (+13 more)

### Community 11 - "League Scatter Charts"
Cohesion: 0.13
Nodes (13): BAR_COLORS, fmt10(), IndParticipantSection(), LeagueScatter(), ParticipantMini(), TD, TH, SearchableSelect() (+5 more)

### Community 12 - "App Shell & Routing"
Cohesion: 0.21
Nodes (12): App(), getActiveOrg(), getInitialTheme(), useAuth(), isDemoMode(), CompanyDashboard(), Dashboard(), Login() (+4 more)

### Community 13 - "Auth & JWT Roles"
Cohesion: 0.13
Nodes (10): bcrypt, jwt, PLATFORM_ROLES, requireAdmin, requireAuth(), requireRole(), userStore, verifyToken() (+2 more)

### Community 14 - "Convex TS Config"
Cohesion: 0.12
Nodes (15): compilerOptions, allowJs, allowSyntheticDefaultImports, forceConsistentCasingInFileNames, isolatedModules, jsx, lib, module (+7 more)

### Community 15 - "Demo Mode Masking"
Cohesion: 0.29
Nodes (13): KEEP_WORDS, looksLikeEvent(), looksLikeEventName(), looksLikePerson(), maskCity(), maskDeep(), maskEmail(), maskEventName() (+5 more)

### Community 16 - "League Detail & Exports"
Cohesion: 0.17
Nodes (6): BUCKET_COLOR, ExportHistoryEntry(), LeagueDetailPanel(), LOG_COLOR, PIE_COLORS, withTotal()

### Community 17 - "Meta Ads Page"
Cohesion: 0.27
Nodes (9): adsManagerUrl(), AdsReport(), agoLabel(), DEFAULT_VIEW, fmtNum(), fmtUsd(), HIDDEN_ACTIONS, isoShift() (+1 more)

### Community 18 - "Super Admin Panel"
Cohesion: 0.20
Nodes (4): CompaniesPanel(), emptyOrg(), inputStyle, PLATFORM_ROLE_INFO

### Community 19 - "Convex Login Script"
Cohesion: 0.29
Nodes (10): CONVEX_CONFIG, __dirname, isLoggedIn(), main(), pollForToken(), readToken(), root, saveToken() (+2 more)

### Community 20 - "API Client & Auth Context"
Cohesion: 0.38
Nodes (6): api, getAuthToken(), setAuthToken(), AuthContext, AuthProvider(), root

### Community 21 - "Aggregate Panel"
Cohesion: 0.31
Nodes (8): withToken(), AggregatePanel(), BAR_COLOR, classifyEvent(), computeSmartEvents(), eventYear(), BootTerminal(), LEVEL_COLOR

### Community 22 - "League Overlap Contacts"
Cohesion: 0.29
Nodes (9): allEmailsFrom(), allPhonesFrom(), ContactActions(), fmt10(), LeagueOverlap(), ParticipantTable(), TAB_CONFIG, td (+1 more)

### Community 23 - "Vercel Deploy Config"
Cohesion: 0.20
Nodes (9): maxDuration, memory, buildCommand, functions, api/index.js, installCommand, outputDirectory, rewrites (+1 more)

### Community 24 - "Analytics Page"
Cohesion: 0.22
Nodes (3): Analytics(), COLORS, SCENARIOS

### Community 25 - "Registration Answer Extraction"
Cohesion: 0.43
Nodes (8): aggregateAnswers(), extractAnswers(), extractContact(), extractPlayers(), findEmailFallback(), pickAnswer(), pickAnswerAll(), resolveAnswerVal()

### Community 26 - "Org & Site Settings IO"
Cohesion: 0.39
Nodes (8): ensureDefaultCompany(), listAccountsRaw(), loadOrg(), loadSiteSettings(), localJsonLoad(), localJsonSave(), saveAccountDoc(), saveOrgDoc()

### Community 28 - "KV & Secret Crypto"
Cohesion: 0.33
Nodes (7): adsSettings(), checkDeleteGuards(), decryptSecret(), kvGet(), kvSet(), localPrefsLoad(), localPrefsSave()

### Community 31 - "Convex Data Model Types"
Cohesion: 0.33
Nodes (4): DataModel, Doc, Id, TableNames

### Community 32 - "Convex Server Types"
Cohesion: 0.33
Nodes (5): ActionCtx, DatabaseReader, DatabaseWriter, MutationCtx, QueryCtx

### Community 35 - "Convex Deploy Script"
Cohesion: 0.50
Nodes (4): __dirname, main(), root, vercelSetEnv()

### Community 38 - "SportsEngine GraphQL Fetch"
Cohesion: 0.67
Nodes (3): fetchAllRegistrationResults(), getAccessToken(), graphql()

### Community 39 - "Deadline Page Parser"
Cohesion: 0.67
Nodes (3): htmlToText(), parseDeadlineDate(), parsePage()

### Community 40 - "Deadline Token Matcher"
Cohesion: 0.67
Nodes (3): matchScrapedEvents(), SCRAPE_STOP, scrapeTokens()

## Knowledge Gaps
- **255 isolated node(s):** `name`, `version`, `description`, `main`, `start` (+250 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **11 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `dependencies` connect `Client Package Manifest` to `Dashboard Chart Components`?**
  _High betweenness centrality (0.036) - this node is a cross-community bridge._
- **Why does `react` connect `Dashboard Chart Components` to `Client Package Manifest`?**
  _High betweenness centrality (0.035) - this node is a cross-community bridge._
- **What connects `name`, `version`, `description` to the rest of the system?**
  _255 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Dashboard Chart Components` be split into smaller, more focused modules?**
  _Cohesion score 0.07547169811320754 - nodes in this community are weakly interconnected._
- **Should `Express Server Core` be split into smaller, more focused modules?**
  _Cohesion score 0.04 - nodes in this community are weakly interconnected._
- **Should `Convex Admin Functions` be split into smaller, more focused modules?**
  _Cohesion score 0.05612244897959184 - nodes in this community are weakly interconnected._
- **Should `Convex Reports & Codegen` be split into smaller, more focused modules?**
  _Cohesion score 0.05405405405405406 - nodes in this community are weakly interconnected._