/**
 * Per-user UI preferences — small JSON blobs keyed by (userId, key).
 * Backs /api/prefs/:key so dashboard selections survive across devices.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const getPref = query({
  args: { userId: v.string(), key: v.string() },
  handler: async (ctx, { userId, key }) => {
    const row = await ctx.db
      .query("preferences")
      .withIndex("by_user_key", (q) => q.eq("userId", userId).eq("key", key))
      .first();
    return row ? row.value : null;
  },
});

export const setPref = mutation({
  args: { userId: v.string(), key: v.string(), value: v.string() },
  handler: async (ctx, { userId, key, value }) => {
    const now = new Date().toISOString();
    const existing = await ctx.db
      .query("preferences")
      .withIndex("by_user_key", (q) => q.eq("userId", userId).eq("key", key))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { value, updatedAt: now });
    } else {
      await ctx.db.insert("preferences", { userId, key, value, updatedAt: now });
    }
    return { ok: true };
  },
});
