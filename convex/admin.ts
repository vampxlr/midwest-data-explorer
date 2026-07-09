/**
 * Super-admin data: site settings (landing page content) + organizations
 * registry. All access control happens in the Express layer.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// ── Site settings (single JSON blob keyed 'main') ──────────────────────────────

export const getSettings = query({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q) => q.eq("key", "main"))
      .first();
    return row ? row.value : null;
  },
});

export const setSettings = mutation({
  args: { value: v.string() },
  handler: async (ctx, { value }) => {
    const now = new Date().toISOString();
    const existing = await ctx.db
      .query("siteSettings")
      .withIndex("by_key", (q) => q.eq("key", "main"))
      .first();
    if (existing) await ctx.db.patch(existing._id, { value, updatedAt: now });
    else await ctx.db.insert("siteSettings", { key: "main", value, updatedAt: now });
    return { ok: true };
  },
});

// ── Organizations registry ─────────────────────────────────────────────────────

export const listOrgs = query({
  args: {},
  handler: async (ctx) => ctx.db.query("organizations").collect(),
});

export const upsertOrg = mutation({
  args: {
    orgKey: v.string(),
    name: v.string(),
    seOrgId: v.optional(v.string()),
    seClientId: v.optional(v.string()),
    seClientSecret: v.optional(v.string()),
    status: v.string(),
    plan: v.optional(v.string()),
    stripeCustomerId: v.optional(v.string()),
    subscriptionStatus: v.optional(v.string()),
    createdAt: v.string(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("organizations")
      .withIndex("by_orgKey", (q) => q.eq("orgKey", args.orgKey))
      .first();
    if (existing) await ctx.db.patch(existing._id, args);
    else await ctx.db.insert("organizations", args);
    return { ok: true };
  },
});

export const removeOrg = mutation({
  args: { orgKey: v.string() },
  handler: async (ctx, { orgKey }) => {
    const doc = await ctx.db
      .query("organizations")
      .withIndex("by_orgKey", (q) => q.eq("orgKey", orgKey))
      .first();
    if (doc) await ctx.db.delete(doc._id);
    return { ok: true };
  },
});
