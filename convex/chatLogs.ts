/**
 * Insert-only assistant logs (conversations, visitor questions, unanswered
 * questions). High-volume path: one small insert per chat message, instead of
 * the old KV pattern that read and rewrote a whole capped array every time.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const add = mutation({
  args: { type: v.string(), at: v.string(), data: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.insert("chatLogs", args);
    return { ok: true };
  },
});

// Latest N entries of one type, newest first.
export const recent = query({
  args: { type: v.string(), limit: v.number() },
  handler: async (ctx, { type, limit }) => {
    return await ctx.db
      .query("chatLogs")
      .withIndex("by_type", (q) => q.eq("type", type))
      .order("desc")
      .take(Math.min(limit, 500));
  },
});

// Retention: delete the oldest entries beyond `keep` for one type. Called by
// the daily cron in small batches so it never reads much in one go.
export const prune = mutation({
  args: { type: v.string(), keep: v.number() },
  handler: async (ctx, { type, keep }) => {
    const rows = await ctx.db
      .query("chatLogs")
      .withIndex("by_type", (q) => q.eq("type", type))
      .order("desc")
      .take(Math.min(keep, 5000) + 200);
    const excess = rows.slice(Math.min(keep, 5000));
    for (const r of excess) await ctx.db.delete(r._id);
    return { deleted: excess.length };
  },
});
