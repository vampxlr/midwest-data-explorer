/**
 * Convex report queries.
 *
 * Only queries that use indexed lookups (not full table scans) live here.
 * Aggregate reports that require scanning all 30k+ results (daily, gradYears,
 * yoy, byEvent) stay in Express until a pre-computed stats cache is added.
 */

import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { action, internalMutation, internalQuery, query } from "./_generated/server";
import { internal } from "./_generated/api";

const CDT_OFFSET_MS = -5 * 60 * 60 * 1000;
function toCDTDate(isoStr: string): string {
  const ms = new Date(isoStr).getTime();
  if (isNaN(ms)) return isoStr.slice(0, 10);
  return new Date(ms + CDT_OFFSET_MS).toISOString().slice(0, 10);
}

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

// ── Report: daily registration counts (uses pre-computed statsDaily) ──────────

export const reportDaily = query({
  args: {
    fromDate: v.optional(v.string()),
    toDate: v.optional(v.string()),
    eventId: v.optional(v.string()),
  },
  handler: async (ctx, { fromDate, toDate, eventId }) => {
    if (eventId) {
      // Per-event: scan results using index (bounded by event size)
      const rows = await ctx.db
        .query("results")
        .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
        .collect();
      const map: Record<string, number> = {};
      for (const r of rows) {
        if (!r.created) continue;
        const date = toCDTDate(r.created);
        if (fromDate && date < fromDate) continue;
        if (toDate && date > toDate) continue;
        map[date] = (map[date] || 0) + 1;
      }
      return Object.entries(map)
        .map(([date, total]) => ({ date, total }))
        .sort((a, b) => a.date.localeCompare(b.date));
    }
    // Global: use pre-computed statsDaily
    const stats = await ctx.db.query("statsDaily").collect();
    return stats
      .filter(
        (s) => (!fromDate || s.date >= fromDate) && (!toDate || s.date <= toDate)
      )
      .map((s) => ({ date: s.date, total: s.count }))
      .sort((a, b) => a.date.localeCompare(b.date));
  },
});

// ── Report: grad-year breakdown (uses pre-computed statsGradYear) ─────────────

export const reportGradYears = query({
  args: {
    fromDate: v.optional(v.string()),
    toDate: v.optional(v.string()),
    eventId: v.optional(v.string()),
  },
  handler: async (ctx, { fromDate, toDate, eventId }) => {
    if (eventId) {
      // Per-event: scan results using index
      const rows = await ctx.db
        .query("results")
        .withIndex("by_eventId", (q) => q.eq("eventId", eventId))
        .collect();
      const map: Record<string, number> = {};
      for (const r of rows) {
        if (!r.completed) continue;
        if (fromDate || toDate) {
          const date = r.created ? toCDTDate(r.created) : "";
          if (fromDate && date < fromDate) continue;
          if (toDate && date > toDate) continue;
        }
        for (const gy of r.gradYears ?? []) {
          if (/^\d{4}$/.test(gy)) map[gy] = (map[gy] || 0) + 1;
        }
      }
      return Object.entries(map)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);
    }
    // Global: use pre-computed statsGradYear (date filter ignored for global)
    const stats = await ctx.db.query("statsGradYear").collect();
    return stats
      .map((s) => ({ name: s.year, count: s.count }))
      .sort((a, b) => b.count - a.count);
  },
});

// ── Report: today / yesterday / month counts (uses statsDaily) ────────────────

export const reportRecent = query({
  handler: async (ctx) => {
    const nowMs = Date.now();
    const todayCDT = new Date(nowMs + CDT_OFFSET_MS).toISOString().slice(0, 10);
    const yesterdayCDT = new Date(nowMs + CDT_OFFSET_MS - 86400000)
      .toISOString()
      .slice(0, 10);
    const thisMonth = todayCDT.slice(0, 7);
    const d = new Date();
    const lastMonth = new Date(d.getFullYear(), d.getMonth() - 1, 15)
      .toISOString()
      .slice(0, 7);
    const last30start = new Date(nowMs + CDT_OFFSET_MS - 30 * 86400000)
      .toISOString()
      .slice(0, 10);

    const allDaily = await ctx.db.query("statsDaily").collect();

    let todayCount = 0,
      yesterdayCount = 0,
      thisMonthCount = 0,
      lastMonthCount = 0,
      allTimeCount = 0;
    const daily30: Array<{ date: string; total: number }> = [];

    for (const s of allDaily) {
      allTimeCount += s.count;
      if (s.date === todayCDT) todayCount = s.count;
      if (s.date === yesterdayCDT) yesterdayCount = s.count;
      if (s.date.slice(0, 7) === thisMonth) thisMonthCount += s.count;
      if (s.date.slice(0, 7) === lastMonth) lastMonthCount += s.count;
      if (s.date >= last30start) daily30.push({ date: s.date, total: s.count });
    }

    daily30.sort((a, b) => a.date.localeCompare(b.date));

    return {
      today: todayCount,
      yesterday: yesterdayCount,
      thisMonth: thisMonthCount,
      lastMonth: lastMonthCount,
      allTime: allTimeCount,
      daily30,
    };
  },
});

// ── Backfill: one-time scan of all results to populate stats tables ────────────

export const resultPageInternal = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    const result = await ctx.db.query("results").paginate(paginationOpts);
    return {
      page: result.page.map((r) => ({
        created: r.created,
        gradYears: r.gradYears,
        completed: r.completed,
      })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const writeBackfilledStats = internalMutation({
  args: {
    dailyStats: v.array(v.object({ date: v.string(), count: v.number() })),
    gradYearStats: v.array(v.object({ year: v.string(), count: v.number() })),
  },
  handler: async (ctx, { dailyStats, gradYearStats }) => {
    for (const { date, count } of dailyStats) {
      const existing = await ctx.db
        .query("statsDaily")
        .withIndex("by_date", (q) => q.eq("date", date))
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, { count });
      } else {
        await ctx.db.insert("statsDaily", { date, count });
      }
    }
    for (const { year, count } of gradYearStats) {
      const existing = await ctx.db
        .query("statsGradYear")
        .withIndex("by_year", (q) => q.eq("year", year))
        .first();
      if (existing) {
        await ctx.db.patch(existing._id, { count });
      } else {
        await ctx.db.insert("statsGradYear", { year, count });
      }
    }
  },
});

export const backfillStats = action({
  handler: async (ctx) => {
    const dailyDelta: Record<string, number> = {};
    const gradYearDelta: Record<string, number> = {};
    let cursor: string | null = null;
    let isDone = false;
    let total = 0;

    while (!isDone) {
      const result = await ctx.runQuery(internal.reports.resultPageInternal, {
        paginationOpts: { cursor, numItems: 500 },
      });
      for (const r of result.page) {
        if (r.created) {
          const date = toCDTDate(r.created);
          dailyDelta[date] = (dailyDelta[date] || 0) + 1;
        }
        if (r.completed) {
          for (const gy of r.gradYears ?? []) {
            if (/^\d{4}$/.test(gy)) {
              gradYearDelta[gy] = (gradYearDelta[gy] || 0) + 1;
            }
          }
        }
        total++;
      }
      cursor = result.continueCursor;
      isDone = result.isDone;
    }

    // Write in batches of 400 to avoid Convex write limits per transaction
    const dailyEntries = Object.entries(dailyDelta).map(([date, count]) => ({ date, count }));
    for (let i = 0; i < dailyEntries.length; i += 400) {
      await ctx.runMutation(internal.reports.writeBackfilledStats, {
        dailyStats: dailyEntries.slice(i, i + 400),
        gradYearStats: [],
      });
    }
    const gradYearEntries = Object.entries(gradYearDelta).map(([year, count]) => ({ year, count }));
    if (gradYearEntries.length > 0) {
      await ctx.runMutation(internal.reports.writeBackfilledStats, {
        dailyStats: [],
        gradYearStats: gradYearEntries,
      });
    }

    return {
      total,
      dailyDays: Object.keys(dailyDelta).length,
      gradYears: Object.keys(gradYearDelta).length,
    };
  },
});
