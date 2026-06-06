import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

export const importEvents = internalMutation({
  args: {
    events: v.array(
      v.object({
        seId: v.string(),
        name: v.string(),
        status: v.optional(v.number()),
        open: v.optional(v.string()),
        close: v.optional(v.string()),
        sport: v.optional(v.string()),
        fetchedAt: v.optional(v.string()),
        resultCount: v.optional(v.number()),
        resultsCompleted: v.optional(v.number()),
      })
    ),
  },
  handler: async (ctx, { events }) => {
    let inserted = 0;
    let updated = 0;
    for (const ev of events) {
      const existing = await ctx.db
        .query("events")
        .withIndex("by_seId", (q) => q.eq("seId", ev.seId))
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, ev);
        updated++;
      } else {
        await ctx.db.insert("events", ev);
        inserted++;
      }
    }
    return { inserted, updated };
  },
});

export const importResults = internalMutation({
  args: {
    results: v.array(v.any()),
  },
  handler: async (ctx, { results }) => {
    let inserted = 0;
    let updated = 0;
    for (const r of results) {
      const existing = await ctx.db
        .query("results")
        .withIndex("by_seId", (q) => q.eq("seId", String(r.seId ?? r.id)))
        .first();

      const doc = {
        seId: String(r.seId ?? r.id),
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
        fetchedAt: r.fetchedAt || undefined,
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

export const setStoreState = internalMutation({
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

export const clearAll = internalMutation({
  handler: async (ctx) => {
    const [events, results, contacts, state] = await Promise.all([
      ctx.db.query("events").collect(),
      ctx.db.query("results").collect(),
      ctx.db.query("contacts").collect(),
      ctx.db.query("storeState").collect(),
    ]);
    for (const r of [...events, ...results, ...contacts, ...state]) {
      await ctx.db.delete(r._id);
    }
    return {
      cleared: events.length + results.length + contacts.length + state.length,
    };
  },
});
