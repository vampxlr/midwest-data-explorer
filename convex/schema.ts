import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  events: defineTable({
    seId: v.string(),
    name: v.string(),
    status: v.optional(v.number()),
    open: v.optional(v.string()),
    close: v.optional(v.string()),
    sport: v.optional(v.string()),
    fetchedAt: v.optional(v.string()),
    resultCount: v.optional(v.number()),
    resultsCompleted: v.optional(v.number()),
  }).index("by_seId", ["seId"]),

  results: defineTable({
    seId: v.string(),
    eventId: v.string(),
    eventName: v.string(),
    profileId: v.optional(v.string()),
    email: v.optional(v.string()),
    emails: v.array(v.string()),
    phone: v.optional(v.string()),
    phones: v.array(v.string()),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    zip: v.optional(v.string()),
    city: v.optional(v.string()),
    state: v.optional(v.string()),
    gender: v.optional(v.string()),
    gradYears: v.array(v.string()),
    grade: v.optional(v.string()),
    revenue: v.optional(v.number()),
    players: v.array(v.any()),
    created: v.optional(v.string()),
    completed: v.optional(v.boolean()),
    fetchedAt: v.optional(v.string()),
  })
    .index("by_seId", ["seId"])
    .index("by_eventId", ["eventId"])
    .index("by_created", ["created"]),

  contacts: defineTable({
    resultId: v.string(),
    eventId: v.string(),
    eventName: v.string(),
    email: v.optional(v.string()),
    emails: v.array(v.string()),
    phone: v.optional(v.string()),
    phones: v.array(v.string()),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    zip: v.optional(v.string()),
    city: v.optional(v.string()),
    state: v.optional(v.string()),
    gender: v.optional(v.string()),
    gradYears: v.array(v.string()),
    fetchedAt: v.optional(v.string()),
  })
    .index("by_eventId", ["eventId"])
    .index("by_resultId", ["resultId"]),

  storeState: defineTable({
    key: v.string(),
    orgId: v.optional(v.string()),
    lastRunAt: v.optional(v.string()),
    totalResults: v.optional(v.number()),
    lastUpdatedAt: v.optional(v.string()),
  }).index("by_key", ["key"]),

  statsDaily: defineTable({
    date: v.string(),   // "YYYY-MM-DD" in CDT
    count: v.number(),
  }).index("by_date", ["date"]),

  statsGradYear: defineTable({
    year: v.string(),   // "YYYY"
    count: v.number(),  // completed registrations only
  }).index("by_year", ["year"]),

  statsGender: defineTable({
    gender: v.string(),
    count: v.number(),  // completed registrations only
  }).index("by_gender", ["gender"]),

  statsState: defineTable({
    state: v.string(),
    count: v.number(),  // completed registrations only
  }).index("by_state", ["state"]),

  statsCity: defineTable({
    city: v.string(),
    count: v.number(),  // completed registrations only
  }).index("by_city", ["city"]),

  statsZip: defineTable({
    zip: v.string(),    // 5-digit
    count: v.number(),  // completed registrations only
  }).index("by_zip", ["zip"]),

  statsYoyDaily: defineTable({
    year: v.string(),   // season year "YYYY"
    type: v.string(),   // "league" | "camp" | "tournament"
    day: v.number(),    // day-of-year, 1-366 (CDT)
    count: v.number(),  // completed registrations only
  }).index("by_year_type_day", ["year", "type", "day"]),

  users: defineTable({
    userId: v.string(),
    username: v.string(),
    passwordHash: v.string(),
    role: v.string(),                    // superadmin | admin | editor | viewer
    createdAt: v.string(),
    lastLoginAt: v.optional(v.string()),
    email: v.optional(v.string()),       // set for Google sign-in accounts
    provider: v.optional(v.string()),    // 'google' | undefined (password)
    accountKey: v.optional(v.string()),  // company this user belongs to
  }).index("by_userId", ["userId"]).index("by_username", ["username"]),

  // Insert-only chat/assistant logs (conversations, questions, unanswered).
  // Replaces the old rewrite-the-whole-array KV blobs — each log write is a
  // ~1KB insert instead of a ~100KB read+rewrite, which matters at scale.
  chatLogs: defineTable({
    type: v.string(),   // 'convo' | 'question' | 'unanswered'
    at: v.string(),     // ISO timestamp
    data: v.string(),   // JSON-encoded entry
  }).index("by_type", ["type"]),

  // Per-user UI preferences (dashboard slot selections etc.) — survives
  // devices/browsers, unlike localStorage.
  preferences: defineTable({
    userId: v.string(),
    key: v.string(),
    value: v.string(),          // JSON-encoded payload
    updatedAt: v.string(),
  }).index("by_user_key", ["userId", "key"]),

  // Site-wide settings edited from the super admin panel (landing page
  // pricing/features, beta banner, etc.). Single row keyed 'main'.
  siteSettings: defineTable({
    key: v.string(),
    value: v.string(),          // JSON-encoded settings object
    updatedAt: v.string(),
  }).index("by_key", ["key"]),

  // Customer organizations (multi-tenant registry). Credentials verified
  // against SportsEngine then encrypted (AES-256-GCM, key in server env) and
  // locked — never returned by any API. Fetching per-org lands in Phase B.
  organizations: defineTable({
    orgKey: v.string(),                       // internal uuid
    accountKey: v.optional(v.string()),       // owning company account
    name: v.string(),
    seOrgId: v.optional(v.string()),          // SportsEngine organization id
    seClientId: v.optional(v.string()),       // SportsEngine OAuth client
    seClientSecret: v.optional(v.string()),   // legacy plaintext (pre-lock) — cleared on verify
    seClientSecretEnc: v.optional(v.string()),// AES-256-GCM ciphertext (iv:tag:data, hex)
    verified: v.optional(v.boolean()),        // passed a live SE token test
    verifiedOrgName: v.optional(v.string()),  // SE-reported org name at verify time
    lockedAt: v.optional(v.string()),         // credentials locked (write-only) since
    status: v.string(),                       // 'beta' | 'active' | 'suspended'
    plan: v.optional(v.string()),
    stripeCustomerId: v.optional(v.string()),
    subscriptionStatus: v.optional(v.string()), // 'beta'|'active'|'past_due'|'canceled'
    createdAt: v.string(),
    notes: v.optional(v.string()),
  }).index("by_orgKey", ["orgKey"]),

  // Company accounts — a customer company owns one or more organizations.
  accounts: defineTable({
    accountKey: v.string(),
    name: v.string(),
    ownerUserId: v.optional(v.string()),
    createdAt: v.string(),
  }).index("by_accountKey", ["accountKey"]),

  // Per-organization role assignments (a user can hold different roles in
  // different orgs): 'org_admin' | 'analyst' | 'viewer'.
  memberships: defineTable({
    userId: v.string(),
    orgKey: v.string(),
    role: v.string(),
    createdAt: v.string(),
  }).index("by_user", ["userId"]).index("by_org", ["orgKey"]),
});
