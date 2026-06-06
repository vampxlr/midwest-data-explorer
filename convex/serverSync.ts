/**
 * Public mutations called by the Express server after each SportsEngine fetch.
 * These are separate from the one-time seed mutations.
 */

import { v } from "convex/values";
import { mutation } from "./_generated/server";

export const batchUpsertResults = mutation({
  args: { results: v.array(v.any()) },
  handler: async (ctx, { results }) => {
    let inserted = 0;
    let updated = 0;
    const now = new Date().toISOString();
    for (const r of results) {
      const seId = String(r.seId ?? r.id);
      const existing = await ctx.db
        .query("results")
        .withIndex("by_seId", (q) => q.eq("seId", seId))
        .first();
      const doc = {
        seId,
        eventId: String(r.eventId),
        eventName: String(r.eventName ?? ""),
        profileId: r.profileId ? String(r.profileId) : undefined,
        email: r.email || undefined,
        emails: Array.isArray(r.emails) ? r.emails.map(String) : [],
        phone: r.phone || undefined,
        phones: Array.isArray(r.phones) ? r.phones.map(String) : [],
        firstName: r.firstName || undefined,
        lastName: r.lastName || undefined,
        zip: r.zip || undefined,
        city: r.city || undefined,
        state: r.state || undefined,
        gender: r.gender || undefined,
        gradYears: Array.isArray(r.gradYears) ? r.gradYears.map(String) : [],
        grade: r.grade || undefined,
        revenue: typeof r.revenue === "number" ? r.revenue : undefined,
        players: Array.isArray(r.players) ? r.players : [],
        created: r.created || undefined,
        completed: typeof r.completed === "boolean" ? r.completed : undefined,
        fetchedAt: now,
      };
      if (existing) {
        await ctx.db.patch(existing._id, doc);
        updated++;
      } else {
        await ctx.db.insert("results", doc);
        inserted++;
      }
    }
    return { inserted, updated };
  },
});

export const batchUpsertEvents = mutation({
  args: { events: v.array(v.any()) },
  handler: async (ctx, { events }) => {
    let inserted = 0;
    let updated = 0;
    const now = new Date().toISOString();
    for (const e of events) {
      const seId = String(e.seId ?? e.id);
      const existing = await ctx.db
        .query("events")
        .withIndex("by_seId", (q) => q.eq("seId", seId))
        .first();
      const doc = {
        seId,
        name: String(e.name ?? ""),
        status: typeof e.status === "number" ? e.status : undefined,
        open: e.open || undefined,
        close: e.close || undefined,
        sport: e.sport || undefined,
        fetchedAt: e.fetchedAt || now,
        resultCount: typeof e.resultCount === "number" ? e.resultCount : undefined,
        resultsCompleted: typeof e.resultsCompleted === "number" ? e.resultsCompleted : undefined,
      };
      if (existing) {
        await ctx.db.patch(existing._id, doc);
        updated++;
      } else {
        await ctx.db.insert("events", doc);
        inserted++;
      }
    }
    return { inserted, updated };
  },
});

export const updateStoreState = mutation({
  args: {
    orgId: v.optional(v.string()),
    lastRunAt: v.optional(v.string()),
    totalResults: v.optional(v.number()),
    lastUpdatedAt: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("storeState")
      .withIndex("by_key", (q) => q.eq("key", "meta"))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, args);
    } else {
      await ctx.db.insert("storeState", { key: "meta", ...args });
    }
  },
});

export const purgeEventResults = mutation({
  args: { eventId: v.string() },
  handler: async (ctx, { eventId }) => {
    const batch = await ctx.db
      .query("results")
      .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
      .take(500);
    for (const r of batch) {
      await ctx.db.delete(r._id);
    }
    return batch.length;
  },
});
