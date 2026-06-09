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
    role: v.string(),
    createdAt: v.string(),
    lastLoginAt: v.optional(v.string()),
  }).index("by_userId", ["userId"]).index("by_username", ["username"]),
});
