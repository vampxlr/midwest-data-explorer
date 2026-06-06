import { v } from "convex/values";
import { query, mutation } from "./_generated/server";

export const listByEvent = query({
  args: { eventId: v.string() },
  handler: async (ctx, { eventId }) => {
    return await ctx.db
      .query("results")
      .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
      .collect();
  },
});

export const count = query({
  handler: async (ctx) => {
    const all = await ctx.db.query("results").collect();
    return all.length;
  },
});

export const upsert = mutation({
  args: {
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
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("results")
      .withIndex("by_seId", (q) => q.eq("seId", args.seId))
      .first();
    if (existing) {
      const { seId: _seId, ...rest } = args;
      await ctx.db.patch(existing._id, rest);
      return existing._id;
    }
    return await ctx.db.insert("results", args);
  },
});

export const purgeByEvent = mutation({
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
