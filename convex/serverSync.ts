/**
 * Public mutations called by the Express server after each SportsEngine fetch.
 * These are separate from the one-time seed mutations.
 */

import { v } from "convex/values";
import { mutation } from "./_generated/server";

const CDT_OFFSET_MS = -5 * 60 * 60 * 1000;
function toCDTDate(isoStr: string): string {
  const ms = new Date(isoStr).getTime();
  if (isNaN(ms)) return isoStr.slice(0, 10);
  return new Date(ms + CDT_OFFSET_MS).toISOString().slice(0, 10);
}

// ── YoY classification helpers (mirrors /api/reports/yoy-daily in server/index.js) ─
function classifyEvent(name: string = ""): string {
  const n = name.toLowerCase();
  if (/\btournament\b|\btourney\b/.test(n)) return "tournament";
  if (/\bcamp\b|\bclinic\b|\bshooting\b|\bscoring\b|\bskills?\b|\btraining\b|\bacademy\b|\bdevelopment\b/.test(n)) return "camp";
  return "league";
}
function seasonYear(eventName: string, eventClose?: string, eventOpen?: string): string {
  const m = (eventName || "").match(/\b(20\d{2})\b/);
  if (m) return m[1];
  return (eventClose || eventOpen || "").slice(0, 4) || "unknown";
}
function dayOfYear(dateStr: string): number | null {
  if (!dateStr || dateStr.length < 10) return null;
  const [y, m, d] = dateStr.split("-").map(Number);
  const start = Date.UTC(y, 0, 1);
  const cur = Date.UTC(y, m - 1, d);
  return Math.floor((cur - start) / 86400000) + 1;
}

export const batchUpsertResults = mutation({
  args: { results: v.array(v.any()) },
  handler: async (ctx, { results }) => {
    let inserted = 0;
    let updated = 0;
    const now = new Date().toISOString();
    const dailyDelta: Record<string, number> = {};
    const gradYearDelta: Record<string, number> = {};
    const genderDelta: Record<string, number> = {};
    const stateDelta: Record<string, number> = {};
    const cityDelta: Record<string, number> = {};
    const zipDelta: Record<string, number> = {};
    const yoyDailyDelta: Record<string, number> = {};
    const eventCache = new Map<string, { name: string; close?: string; open?: string } | null>();

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
        // Track stats delta for new inserts only
        if (doc.created) {
          const date = toCDTDate(doc.created);
          dailyDelta[date] = (dailyDelta[date] || 0) + 1;
        }
        if (doc.completed) {
          for (const gy of doc.gradYears) {
            if (/^\d{4}$/.test(gy)) {
              gradYearDelta[gy] = (gradYearDelta[gy] || 0) + 1;
            }
          }
          if (doc.gender) genderDelta[doc.gender] = (genderDelta[doc.gender] || 0) + 1;
          const st = doc.state?.trim();
          if (st) stateDelta[st] = (stateDelta[st] || 0) + 1;
          const ci = doc.city?.trim();
          if (ci) cityDelta[ci] = (cityDelta[ci] || 0) + 1;
          if (doc.zip) {
            const z = String(doc.zip).slice(0, 5);
            zipDelta[z] = (zipDelta[z] || 0) + 1;
          }
          if (doc.created) {
            const date = toCDTDate(doc.created);
            const day = dayOfYear(date);
            if (day) {
              let ev = eventCache.get(doc.eventId);
              if (ev === undefined) {
                const eventDoc = await ctx.db
                  .query("events")
                  .withIndex("by_seId", (q) => q.eq("seId", doc.eventId))
                  .first();
                ev = eventDoc ? { name: eventDoc.name, close: eventDoc.close, open: eventDoc.open } : null;
                eventCache.set(doc.eventId, ev);
              }
              const name = ev?.name || doc.eventName;
              const year = seasonYear(name, ev?.close, ev?.open);
              if (/^20\d{2}$/.test(year)) {
                const type = classifyEvent(name);
                const key = `${year}|${type}|${day}`;
                yoyDailyDelta[key] = (yoyDailyDelta[key] || 0) + 1;
              }
            }
          }
        }
      }
    }

    // Apply daily stats delta
    for (const [date, delta] of Object.entries(dailyDelta)) {
      const stat = await ctx.db
        .query("statsDaily")
        .withIndex("by_date", (q) => q.eq("date", date))
        .first();
      if (stat) {
        await ctx.db.patch(stat._id, { count: stat.count + delta });
      } else {
        await ctx.db.insert("statsDaily", { date, count: delta });
      }
    }

    // Apply grad year stats delta
    for (const [year, delta] of Object.entries(gradYearDelta)) {
      const stat = await ctx.db
        .query("statsGradYear")
        .withIndex("by_year", (q) => q.eq("year", year))
        .first();
      if (stat) {
        await ctx.db.patch(stat._id, { count: stat.count + delta });
      } else {
        await ctx.db.insert("statsGradYear", { year, count: delta });
      }
    }

    // Apply gender stats delta
    for (const [gender, delta] of Object.entries(genderDelta)) {
      const stat = await ctx.db
        .query("statsGender")
        .withIndex("by_gender", (q) => q.eq("gender", gender))
        .first();
      if (stat) {
        await ctx.db.patch(stat._id, { count: stat.count + delta });
      } else {
        await ctx.db.insert("statsGender", { gender, count: delta });
      }
    }

    // Apply state stats delta
    for (const [state, delta] of Object.entries(stateDelta)) {
      const stat = await ctx.db
        .query("statsState")
        .withIndex("by_state", (q) => q.eq("state", state))
        .first();
      if (stat) {
        await ctx.db.patch(stat._id, { count: stat.count + delta });
      } else {
        await ctx.db.insert("statsState", { state, count: delta });
      }
    }

    // Apply city stats delta
    for (const [city, delta] of Object.entries(cityDelta)) {
      const stat = await ctx.db
        .query("statsCity")
        .withIndex("by_city", (q) => q.eq("city", city))
        .first();
      if (stat) {
        await ctx.db.patch(stat._id, { count: stat.count + delta });
      } else {
        await ctx.db.insert("statsCity", { city, count: delta });
      }
    }

    // Apply zip stats delta
    for (const [zip, delta] of Object.entries(zipDelta)) {
      const stat = await ctx.db
        .query("statsZip")
        .withIndex("by_zip", (q) => q.eq("zip", zip))
        .first();
      if (stat) {
        await ctx.db.patch(stat._id, { count: stat.count + delta });
      } else {
        await ctx.db.insert("statsZip", { zip, count: delta });
      }
    }

    // Apply YoY-daily stats delta (year|type|day → count)
    for (const [key, delta] of Object.entries(yoyDailyDelta)) {
      const [year, type, dayStr] = key.split("|");
      const day = Number(dayStr);
      const stat = await ctx.db
        .query("statsYoyDaily")
        .withIndex("by_year_type_day", (q) => q.eq("year", year).eq("type", type).eq("day", day))
        .first();
      if (stat) {
        await ctx.db.patch(stat._id, { count: stat.count + delta });
      } else {
        await ctx.db.insert("statsYoyDaily", { year, type, day, count: delta });
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
      .collect();

    // Track stats to decrement — mirrors what batchUpsertResults increments on insert
    const dailyDelta: Record<string, number> = {};
    const gradYearDelta: Record<string, number> = {};
    const genderDelta: Record<string, number> = {};
    const stateDelta: Record<string, number> = {};
    const cityDelta: Record<string, number> = {};
    const zipDelta: Record<string, number> = {};
    const yoyDailyDelta: Record<string, number> = {};

    const eventDoc = await ctx.db
      .query("events")
      .withIndex("by_seId", (q) => q.eq("seId", eventId))
      .first();

    for (const r of batch) {
      await ctx.db.delete(r._id);

      if (r.created) {
        const date = toCDTDate(r.created);
        dailyDelta[date] = (dailyDelta[date] || 0) + 1;
      }
      if (r.completed) {
        for (const gy of r.gradYears ?? []) {
          if (/^\d{4}$/.test(gy)) gradYearDelta[gy] = (gradYearDelta[gy] || 0) + 1;
        }
        if (r.gender) genderDelta[r.gender] = (genderDelta[r.gender] || 0) + 1;
        const st = r.state?.trim();
        if (st) stateDelta[st] = (stateDelta[st] || 0) + 1;
        const ci = r.city?.trim();
        if (ci) cityDelta[ci] = (cityDelta[ci] || 0) + 1;
        if (r.zip) {
          const z = String(r.zip).slice(0, 5);
          zipDelta[z] = (zipDelta[z] || 0) + 1;
        }
        if (r.created) {
          const date = toCDTDate(r.created);
          const day = dayOfYear(date);
          if (day) {
            const name = eventDoc?.name || r.eventName;
            const year = seasonYear(name, eventDoc?.close, eventDoc?.open);
            if (/^20\d{2}$/.test(year)) {
              const type = classifyEvent(name);
              const key = `${year}|${type}|${day}`;
              yoyDailyDelta[key] = (yoyDailyDelta[key] || 0) + 1;
            }
          }
        }
      }
    }

    // Decrement all affected stats tables
    for (const [date, delta] of Object.entries(dailyDelta)) {
      const stat = await ctx.db.query("statsDaily").withIndex("by_date", (q) => q.eq("date", date)).first();
      if (stat) await ctx.db.patch(stat._id, { count: Math.max(0, stat.count - delta) });
    }
    for (const [year, delta] of Object.entries(gradYearDelta)) {
      const stat = await ctx.db.query("statsGradYear").withIndex("by_year", (q) => q.eq("year", year)).first();
      if (stat) await ctx.db.patch(stat._id, { count: Math.max(0, stat.count - delta) });
    }
    for (const [gender, delta] of Object.entries(genderDelta)) {
      const stat = await ctx.db.query("statsGender").withIndex("by_gender", (q) => q.eq("gender", gender)).first();
      if (stat) await ctx.db.patch(stat._id, { count: Math.max(0, stat.count - delta) });
    }
    for (const [state, delta] of Object.entries(stateDelta)) {
      const stat = await ctx.db.query("statsState").withIndex("by_state", (q) => q.eq("state", state)).first();
      if (stat) await ctx.db.patch(stat._id, { count: Math.max(0, stat.count - delta) });
    }
    for (const [city, delta] of Object.entries(cityDelta)) {
      const stat = await ctx.db.query("statsCity").withIndex("by_city", (q) => q.eq("city", city)).first();
      if (stat) await ctx.db.patch(stat._id, { count: Math.max(0, stat.count - delta) });
    }
    for (const [zip, delta] of Object.entries(zipDelta)) {
      const stat = await ctx.db.query("statsZip").withIndex("by_zip", (q) => q.eq("zip", zip)).first();
      if (stat) await ctx.db.patch(stat._id, { count: Math.max(0, stat.count - delta) });
    }
    for (const [key, delta] of Object.entries(yoyDailyDelta)) {
      const [year, type, dayStr] = key.split("|");
      const day = parseInt(dayStr);
      const stat = await ctx.db
        .query("statsYoyDaily")
        .withIndex("by_year_type_day", (q) => q.eq("year", year).eq("type", type).eq("day", day))
        .first();
      if (stat) await ctx.db.patch(stat._id, { count: Math.max(0, stat.count - delta) });
    }

    return batch.length;
  },
});
