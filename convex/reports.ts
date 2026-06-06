/**
 * Convex report queries.
 *
 * Only queries that use indexed lookups (not full table scans) live here.
 * Aggregate reports that require scanning all 30k+ results (daily, gradYears,
 * yoy, byEvent) stay in Express until a pre-computed stats cache is added.
 */

import { v } from "convex/values";
import { query } from "./_generated/server";

// ── Store status ────────────────────────────────────────────────────────────

export const storeStatus = query({
  handler: async (ctx) => {
    const [allEvents, state] = await Promise.all([
      ctx.db.query("events").collect(),
      ctx.db
        .query("storeState")
        .withIndex("by_key", (q) => q.eq("key", "meta"))
        .first(),
    ]);

    const events: Record<string, unknown> = {};
    for (const e of allEvents) {
      events[e.seId] = {
        id: e.seId,
        name: e.name,
        status: e.status,
        open: e.open,
        close: e.close,
        sport: e.sport,
        fetchedAt: e.fetchedAt,
        resultCount: e.resultCount,
        resultsCompleted: e.resultsCompleted,
      };
    }

    return {
      meta: {
        orgId: state?.orgId ?? "8008",
        lastRunAt: state?.lastRunAt ?? null,
        totalResults: state?.totalResults ?? 0,
        lastUpdatedAt: state?.lastUpdatedAt ?? null,
      },
      events,
    };
  },
});

// ── Lightweight stats for Express status endpoint (no full event scan) ────────

export const storeStats = query({
  handler: async (ctx) => {
    const [state, allEvents] = await Promise.all([
      ctx.db.query("storeState").withIndex("by_key", (q) => q.eq("key", "meta")).first(),
      ctx.db.query("events").collect(),
    ]);
    const closed  = allEvents.filter(e => e.status === 2 && e.fetchedAt).length;
    const open    = allEvents.filter(e => e.status !== 2 && e.fetchedAt).length;
    const pending = allEvents.filter(e => !e.fetchedAt).length;
    return {
      totalResults: state?.totalResults ?? 0,
      totalEvents: allEvents.length,
      closedFetched: closed,
      openFetched: open,
      pending,
      meta: {
        orgId: state?.orgId ?? "8008",
        lastRunAt: state?.lastRunAt ?? null,
        lastUpdatedAt: state?.lastUpdatedAt ?? null,
        totalResults: state?.totalResults ?? 0,
      },
    };
  },
});

// ── Per-event results (indexed) ─────────────────────────────────────────────

export const resultsByEvent = query({
  args: { eventId: v.string() },
  handler: async (ctx, { eventId }) => {
    return await ctx.db
      .query("results")
      .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
      .collect();
  },
});

// ── Lapsed individuals (scans per-event, uses index) ───────────────────────

export const lapsedIndividuals = query({
  args: {
    sourceEventIds: v.array(v.string()),
    excludeEventIds: v.array(v.string()),
    genderFilter: v.optional(v.string()),
    gyFrom: v.optional(v.string()),
    gyTo: v.optional(v.string()),
  },
  handler: async (ctx, { sourceEventIds, excludeEventIds, genderFilter, gyFrom, gyTo }) => {
    if (!sourceEventIds.length) return { individuals: [], gradYearBreakdown: [] };

    // Build exclude index using by_eventId index (fast)
    const excludeIndex = new Set<string>();
    for (const eid of excludeEventIds) {
      const rows = await ctx.db
        .query("results")
        .withIndex("by_eventId", (q) => q.eq("eventId", eid))
        .collect();
      for (const r of rows) {
        for (const em of r.emails ?? []) {
          if (em) excludeIndex.add(em.toLowerCase().trim());
        }
        if (r.email) excludeIndex.add(r.email.toLowerCase().trim());
      }
    }

    // Build individual map from source events using by_eventId index
    const individualMap = new Map<
      string,
      {
        email: string;
        firstName?: string;
        lastName?: string;
        gender?: string;
        city?: string;
        state?: string;
        gradYears: Set<string>;
        phones: Set<string>;
      }
    >();

    for (const eid of sourceEventIds) {
      const rows = await ctx.db
        .query("results")
        .withIndex("by_eventId", (q) => q.eq("eventId", eid))
        .collect();

      for (const r of rows) {
        if (genderFilter && r.gender && r.gender !== genderFilter) continue;

        const allEmails = [
          ...(r.emails ?? []),
          ...(r.email ? [r.email] : []),
        ]
          .map((e) => e.toLowerCase().trim())
          .filter(Boolean);

        for (const em of [...new Set(allEmails)]) {
          if (!individualMap.has(em)) {
            individualMap.set(em, {
              email: em,
              firstName: r.firstName,
              lastName: r.lastName,
              gender: r.gender,
              city: r.city,
              state: r.state,
              gradYears: new Set(),
              phones: new Set(),
            });
          }
          const ind = individualMap.get(em)!;
          for (const gy of r.gradYears ?? []) {
            if (gy) ind.gradYears.add(String(gy));
          }
          for (const ph of r.phones ?? []) {
            if (ph) ind.phones.add(ph);
          }
          if (r.phone) ind.phones.add(r.phone);
        }
      }
    }

    // Filter: remove those in exclude events, apply grad year range
    const lapsed: Array<{
      email: string;
      firstName?: string;
      lastName?: string;
      gender?: string;
      city?: string;
      state?: string;
      gradYears: string[];
      phones: string[];
    }> = [];

    for (const [email, ind] of individualMap) {
      if (excludeIndex.has(email)) continue;
      const gradYearsSorted = [...ind.gradYears].sort();

      if (gyFrom || gyTo) {
        const hasMatch = gradYearsSorted.some((gy) => {
          if (gyFrom && gy < gyFrom) return false;
          if (gyTo && gy > gyTo) return false;
          return true;
        });
        if (!hasMatch) continue;
      }

      lapsed.push({
        email,
        firstName: ind.firstName,
        lastName: ind.lastName,
        gender: ind.gender,
        city: ind.city,
        state: ind.state,
        gradYears: gradYearsSorted,
        phones: [...ind.phones],
      });
    }

    const gyMap: Record<string, number> = {};
    for (const ind of lapsed) {
      for (const gy of ind.gradYears) {
        if (/^\d{4}$/.test(gy)) gyMap[gy] = (gyMap[gy] || 0) + 1;
      }
    }
    const gradYearBreakdown = Object.entries(gyMap)
      .map(([year, count]) => ({ year, count }))
      .sort((a, b) => a.year.localeCompare(b.year));

    return { individuals: lapsed, gradYearBreakdown };
  },
});

// ── Audience preview (scans per-event, uses index) ─────────────────────────

export const audiencePreview = query({
  args: {
    eventIds: v.array(v.string()),
    genderFilter: v.optional(v.string()),
    gradYearFilter: v.optional(v.string()),
  },
  handler: async (ctx, { eventIds, genderFilter, gradYearFilter }) => {
    if (!eventIds.length) return { total: 0, emails: [] };

    const allEmails = new Set<string>();

    for (const eid of eventIds) {
      const rows = await ctx.db
        .query("results")
        .withIndex("by_eventId", (q) => q.eq("eventId", eid))
        .collect();

      for (const r of rows) {
        if (genderFilter && r.gender && r.gender !== genderFilter) continue;
        if (gradYearFilter) {
          const hasYear = (r.gradYears ?? []).map(String).includes(gradYearFilter);
          if (!hasYear) continue;
        }
        const emails = [...(r.emails ?? []), ...(r.email ? [r.email] : [])].filter(Boolean);
        for (const em of emails) {
          allEmails.add(em.toLowerCase().trim());
        }
      }
    }

    return {
      total: allEmails.size,
      emails: [...allEmails],
    };
  },
});
