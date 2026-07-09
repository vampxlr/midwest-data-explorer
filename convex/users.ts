import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    return ctx.db.query("users").collect();
  },
});

export const upsertUser = mutation({
  args: {
    userId: v.string(),
    username: v.string(),
    passwordHash: v.string(),
    role: v.string(),
    createdAt: v.string(),
    lastLoginAt: v.optional(v.string()),
    email: v.optional(v.string()),
    provider: v.optional(v.string()),
    accountKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_userId", (q) => q.eq("userId", args.userId))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, args);
    } else {
      await ctx.db.insert("users", args);
    }
  },
});

export const removeUser = mutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => {
    const doc = await ctx.db
      .query("users")
      .withIndex("by_userId", (q) => q.eq("userId", userId))
      .first();
    if (doc) await ctx.db.delete(doc._id);
  },
});
