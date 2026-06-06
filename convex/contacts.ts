import { v } from "convex/values";
import { query, mutation } from "./_generated/server";

export const listByEvent = query({
  args: { eventId: v.string() },
  handler: async (ctx, { eventId }) => {
    return await ctx.db
      .query("contacts")
      .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
      .collect();
  },
});

export const upsert = mutation({
  args: {
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
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("contacts")
      .withIndex("by_resultId", (q) => q.eq("resultId", args.resultId))
      .first();
    if (existing) {
      const { resultId: _id, ...rest } = args;
      await ctx.db.patch(existing._id, rest);
      return existing._id;
    }
    return await ctx.db.insert("contacts", args);
  },
});

export const purgeByEvent = mutation({
  args: { eventId: v.string() },
  handler: async (ctx, { eventId }) => {
    const batch = await ctx.db
      .query("contacts")
      .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
      .take(500);
    for (const c of batch) {
      await ctx.db.delete(c._id);
    }
    return batch.length;
  },
});
