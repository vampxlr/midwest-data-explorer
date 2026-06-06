import { v } from "convex/values";
import { query, mutation } from "./_generated/server";

export const list = query({
  handler: async (ctx) => {
    return await ctx.db.query("events").collect();
  },
});

export const get = query({
  args: { seId: v.string() },
  handler: async (ctx, { seId }) => {
    return await ctx.db
      .query("events")
      .withIndex("by_seId", (q) => q.eq("seId", seId))
      .first();
  },
});

export const upsert = mutation({
  args: {
    seId: v.string(),
    name: v.string(),
    status: v.optional(v.number()),
    open: v.optional(v.string()),
    close: v.optional(v.string()),
    sport: v.optional(v.string()),
    fetchedAt: v.optional(v.string()),
    resultCount: v.optional(v.number()),
    resultsCompleted: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("events")
      .withIndex("by_seId", (q) => q.eq("seId", args.seId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, args);
      return existing._id;
    }
    return await ctx.db.insert("events", args);
  },
});

export const remove = mutation({
  args: { seId: v.string() },
  handler: async (ctx, { seId }) => {
    const existing = await ctx.db
      .query("events")
      .withIndex("by_seId", (q) => q.eq("seId", seId))
      .first();
    if (existing) await ctx.db.delete(existing._id);
  },
});
