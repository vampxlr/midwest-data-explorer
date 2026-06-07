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

// ── YoY retention (per-event indexed scans, bounded by year/type filters) ──
// Source = ALL completed results from sourceEventIds, deduplicated across events.
// Target = ALL completed results from targetEventIds, matched against source.

function getKeysFor(r: { profileId?: string; emails?: string[]; email?: string; phones?: string[]; phone?: string }): string[] {
  const keys: string[] = [];
  if (r.profileId) keys.push(`pid:${String(r.profileId)}`);
  const allEmails = r.emails?.length ? r.emails : (r.email ? [r.email] : []);
  for (const e of allEmails) {
    if (e && e.includes("@")) keys.push(`em:${e.toLowerCase().trim()}`);
  }
  const allPhones = r.phones?.length ? r.phones : (r.phone ? [r.phone] : []);
  for (const p of allPhones) {
    const d = String(p).replace(/\D/g, "");
    if (d.length >= 10) keys.push(`ph:${d.slice(-10)}`);
  }
  return keys;
}

export const yoyRetention = query({
  args: {
    sourceEventIds: v.array(v.string()),
    targetEventIds: v.array(v.string()),
  },
  handler: async (ctx, { sourceEventIds, targetEventIds }) => {
    type Canonical = {
      seId: string;
      email?: string;
      phone?: string;
      gradYears: string[];
      grade?: string;
      gender?: string;
      city?: string;
      revenue?: number;
    };

    const toCanonical = (r: any): Canonical => ({
      seId: r.seId,
      email: r.email,
      phone: r.phone,
      gradYears: r.gradYears ?? [],
      grade: r.grade,
      gender: r.gender,
      city: r.city,
      revenue: r.revenue,
    });

    // Build deduplicated source index: identifier key → canonical participant
    const srcIndex = new Map<string, Canonical>();
    let uniqueSrc = 0;
    let sourceResultsCount = 0;

    for (const eid of sourceEventIds) {
      const rows = await ctx.db
        .query("results")
        .withIndex("by_eventId", (q) => q.eq("eventId", eid))
        .collect();
      for (const r of rows) {
        if (!r.completed) continue;
        sourceResultsCount++;
        const keys = getKeysFor(r);
        let canonical: Canonical | null = null;
        for (const k of keys) {
          if (srcIndex.has(k)) { canonical = srcIndex.get(k)!; break; }
        }
        if (!canonical) {
          canonical = toCanonical(r);
          uniqueSrc++;
        }
        for (const k of keys) {
          if (!srcIndex.has(k)) srcIndex.set(k, canonical);
        }
      }
    }

    // Match target results against source index — bucket by target event
    const bucketMap = new Map<string, {
      eventId: string;
      eventName: string;
      participants: Array<{
        sourceId: string;
        email: string | null;
        phone: string | null;
        gradYearPast: string | null;
        gradYearNow: string | null;
        grade: string | null;
        gender: string | null;
        city: string | null;
      }>;
    }>();
    const matchedSrcIds = new Set<string>();
    let revenueTotal = 0;
    let revenueAll = 0;

    for (const eid of targetEventIds) {
      const rows = await ctx.db
        .query("results")
        .withIndex("by_eventId", (q) => q.eq("eventId", eid))
        .collect();
      for (const rT of rows) {
        if (!rT.completed) continue;
        revenueAll += rT.revenue || 0;
        const keys = getKeysFor(rT);
        let srcCanonical: Canonical | null = null;
        for (const k of keys) {
          if (srcIndex.has(k)) { srcCanonical = srcIndex.get(k)!; break; }
        }
        if (!srcCanonical) continue;
        revenueTotal += rT.revenue || 0;

        if (!bucketMap.has(eid)) {
          bucketMap.set(eid, { eventId: eid, eventName: rT.eventName, participants: [] });
        }
        const bucket = bucketMap.get(eid)!;
        if (!bucket.participants.some((p) => p.sourceId === srcCanonical!.seId)) {
          bucket.participants.push({
            sourceId: srcCanonical.seId,
            email: rT.email || srcCanonical.email || null,
            phone: rT.phone || srcCanonical.phone || null,
            gradYearPast: srcCanonical.gradYears?.[0] || null,
            gradYearNow: rT.gradYears?.[0] || null,
            grade: rT.grade || srcCanonical.grade || null,
            gender: rT.gender || srcCanonical.gender || null,
            city: rT.city || srcCanonical.city || null,
          });
          matchedSrcIds.add(srcCanonical.seId);
        }
      }
    }

    const buckets = [...bucketMap.values()]
      .map((b) => ({ ...b, count: b.participants.length }))
      .sort((a, b) => b.count - a.count);

    // Lapsed: unique source participants with no match in target
    const lapsed: Array<{
      sourceId: string;
      email: string | null;
      phone: string | null;
      gradYear: string | null;
      grade: string | null;
      gender: string | null;
      city: string | null;
    }> = [];
    const seen = new Set<string>();
    for (const canonical of srcIndex.values()) {
      if (seen.has(canonical.seId)) continue;
      seen.add(canonical.seId);
      if (matchedSrcIds.has(canonical.seId)) continue;
      lapsed.push({
        sourceId: canonical.seId,
        email: canonical.email || null,
        phone: canonical.phone || null,
        gradYear: canonical.gradYears?.[0] || null,
        grade: canonical.grade || null,
        gender: canonical.gender || null,
        city: canonical.city || null,
      });
    }

    return {
      source: { totalResults: sourceResultsCount, uniqueParticipants: uniqueSrc },
      returned: { unique: matchedSrcIds.size },
      lapsed: { count: lapsed.length, participants: lapsed },
      buckets,
      revenue: { returned: revenueTotal, allTarget: revenueAll },
    };
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

// ── Report: gender/state/city/zip distributions (pre-computed, completed only) ─

export const reportDemographics = query({
  handler: async (ctx) => {
    const [gender, state, city, zip] = await Promise.all([
      ctx.db.query("statsGender").collect(),
      ctx.db.query("statsState").collect(),
      ctx.db.query("statsCity").collect(),
      ctx.db.query("statsZip").collect(),
    ]);
    const toArr = (rows: Array<{ count: number }>, key: string) =>
      rows
        .map((r: any) => ({ name: r[key], count: r.count }))
        .sort((a, b) => b.count - a.count);
    return {
      gender: toArr(gender, "gender"),
      state: toArr(state, "state"),
      city: toArr(city, "city").slice(0, 50),
      zip: toArr(zip, "zip").slice(0, 100),
    };
  },
});

// ── Report: year-over-year daily registration activity (statsYoyDaily) ────────

export const reportYoyDaily = query({
  handler: async (ctx) => {
    const rows = await ctx.db.query("statsYoyDaily").collect();
    return rows.map((r) => ({ year: r.year, type: r.type, day: r.day, count: r.count }));
  },
});

// ── Report: daily league activity for one date (statsDaily + indexed range) ───

export const reportDailyActivity = query({
  args: { date: v.string() },
  handler: async (ctx, { date }) => {
    // A CDT calendar date "YYYY-MM-DD" covers UTC [date 05:00, date+1 05:00)
    const fromCreated = `${date}T05:00:00.000Z`;
    const nextDate = new Date(new Date(`${date}T00:00:00.000Z`).getTime() + 86400000)
      .toISOString()
      .slice(0, 10);
    const toCreated = `${nextDate}T05:00:00.000Z`;

    const [dayResults, dailyStats] = await Promise.all([
      ctx.db
        .query("results")
        .withIndex("by_created", (q) => q.gte("created", fromCreated).lt("created", toCreated))
        .collect(),
      ctx.db.query("statsDaily").collect(),
    ]);

    return {
      dayResults: dayResults.map((r) => ({
        eventId: r.eventId,
        eventName: r.eventName,
        gradYears: r.gradYears,
      })),
      dailyStats: dailyStats.map((s) => ({ date: s.date, count: s.count })),
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
        eventId: r.eventId,
        eventName: r.eventName,
        created: r.created,
        gradYears: r.gradYears,
        completed: r.completed,
        gender: r.gender,
        state: r.state,
        city: r.city,
        zip: r.zip,
      })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const allEventsInternal = internalQuery({
  args: {},
  handler: async (ctx) => {
    const events = await ctx.db.query("events").collect();
    return events.map((e) => ({ seId: e.seId, name: e.name, close: e.close, open: e.open }));
  },
});

export const writeBackfilledStats = internalMutation({
  args: {
    dailyStats: v.array(v.object({ date: v.string(), count: v.number() })),
    gradYearStats: v.array(v.object({ year: v.string(), count: v.number() })),
    genderStats: v.array(v.object({ gender: v.string(), count: v.number() })),
    stateStats: v.array(v.object({ state: v.string(), count: v.number() })),
    cityStats: v.array(v.object({ city: v.string(), count: v.number() })),
    zipStats: v.array(v.object({ zip: v.string(), count: v.number() })),
    yoyDailyStats: v.array(v.object({ year: v.string(), type: v.string(), day: v.number(), count: v.number() })),
  },
  handler: async (ctx, { dailyStats, gradYearStats, genderStats, stateStats, cityStats, zipStats, yoyDailyStats }) => {
    for (const { date, count } of dailyStats) {
      const existing = await ctx.db
        .query("statsDaily")
        .withIndex("by_date", (q) => q.eq("date", date))
        .first();
      if (existing) await ctx.db.patch(existing._id, { count });
      else await ctx.db.insert("statsDaily", { date, count });
    }
    for (const { year, count } of gradYearStats) {
      const existing = await ctx.db
        .query("statsGradYear")
        .withIndex("by_year", (q) => q.eq("year", year))
        .first();
      if (existing) await ctx.db.patch(existing._id, { count });
      else await ctx.db.insert("statsGradYear", { year, count });
    }
    for (const { gender, count } of genderStats) {
      const existing = await ctx.db
        .query("statsGender")
        .withIndex("by_gender", (q) => q.eq("gender", gender))
        .first();
      if (existing) await ctx.db.patch(existing._id, { count });
      else await ctx.db.insert("statsGender", { gender, count });
    }
    for (const { state, count } of stateStats) {
      const existing = await ctx.db
        .query("statsState")
        .withIndex("by_state", (q) => q.eq("state", state))
        .first();
      if (existing) await ctx.db.patch(existing._id, { count });
      else await ctx.db.insert("statsState", { state, count });
    }
    for (const { city, count } of cityStats) {
      const existing = await ctx.db
        .query("statsCity")
        .withIndex("by_city", (q) => q.eq("city", city))
        .first();
      if (existing) await ctx.db.patch(existing._id, { count });
      else await ctx.db.insert("statsCity", { city, count });
    }
    for (const { zip, count } of zipStats) {
      const existing = await ctx.db
        .query("statsZip")
        .withIndex("by_zip", (q) => q.eq("zip", zip))
        .first();
      if (existing) await ctx.db.patch(existing._id, { count });
      else await ctx.db.insert("statsZip", { zip, count });
    }
    for (const { year, type, day, count } of yoyDailyStats) {
      const existing = await ctx.db
        .query("statsYoyDaily")
        .withIndex("by_year_type_day", (q) => q.eq("year", year).eq("type", type).eq("day", day))
        .first();
      if (existing) await ctx.db.patch(existing._id, { count });
      else await ctx.db.insert("statsYoyDaily", { year, type, day, count });
    }
  },
});

export const backfillStats = action({
  handler: async (ctx) => {
    const dailyDelta: Record<string, number> = {};
    const gradYearDelta: Record<string, number> = {};
    const genderDelta: Record<string, number> = {};
    const stateDelta: Record<string, number> = {};
    const cityDelta: Record<string, number> = {};
    const zipDelta: Record<string, number> = {};
    const yoyDailyDelta: Record<string, number> = {};
    let cursor: string | null = null;
    let isDone = false;
    let total = 0;

    const allEvents = await ctx.runQuery(internal.reports.allEventsInternal, {});
    const eventMap = new Map<string, { name: string; close?: string; open?: string }>();
    for (const e of allEvents) {
      eventMap.set(e.seId, { name: e.name, close: e.close, open: e.open });
    }

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
              const ev = eventMap.get(r.eventId);
              const name = ev?.name || r.eventName;
              const year = seasonYear(name, ev?.close, ev?.open);
              if (/^20\d{2}$/.test(year)) {
                const type = classifyEvent(name);
                const key = `${year}|${type}|${day}`;
                yoyDailyDelta[key] = (yoyDailyDelta[key] || 0) + 1;
              }
            }
          }
        }
        total++;
      }
      cursor = result.continueCursor;
      isDone = result.isDone;
    }

    const empty = { dailyStats: [], gradYearStats: [], genderStats: [], stateStats: [], cityStats: [], zipStats: [], yoyDailyStats: [] };

    // Write in batches of 400 to avoid Convex write limits per transaction
    const dailyEntries = Object.entries(dailyDelta).map(([date, count]) => ({ date, count }));
    for (let i = 0; i < dailyEntries.length; i += 400) {
      await ctx.runMutation(internal.reports.writeBackfilledStats, {
        ...empty,
        dailyStats: dailyEntries.slice(i, i + 400),
      });
    }
    const gradYearEntries = Object.entries(gradYearDelta).map(([year, count]) => ({ year, count }));
    if (gradYearEntries.length > 0) {
      await ctx.runMutation(internal.reports.writeBackfilledStats, { ...empty, gradYearStats: gradYearEntries });
    }
    const genderEntries = Object.entries(genderDelta).map(([gender, count]) => ({ gender, count }));
    if (genderEntries.length > 0) {
      await ctx.runMutation(internal.reports.writeBackfilledStats, { ...empty, genderStats: genderEntries });
    }
    const stateEntries = Object.entries(stateDelta).map(([state, count]) => ({ state, count }));
    for (let i = 0; i < stateEntries.length; i += 400) {
      await ctx.runMutation(internal.reports.writeBackfilledStats, { ...empty, stateStats: stateEntries.slice(i, i + 400) });
    }
    const cityEntries = Object.entries(cityDelta).map(([city, count]) => ({ city, count }));
    for (let i = 0; i < cityEntries.length; i += 400) {
      await ctx.runMutation(internal.reports.writeBackfilledStats, { ...empty, cityStats: cityEntries.slice(i, i + 400) });
    }
    const zipEntries = Object.entries(zipDelta).map(([zip, count]) => ({ zip, count }));
    for (let i = 0; i < zipEntries.length; i += 400) {
      await ctx.runMutation(internal.reports.writeBackfilledStats, { ...empty, zipStats: zipEntries.slice(i, i + 400) });
    }
    const yoyDailyEntries = Object.entries(yoyDailyDelta).map(([key, count]) => {
      const [year, type, dayStr] = key.split("|");
      return { year, type, day: Number(dayStr), count };
    });
    for (let i = 0; i < yoyDailyEntries.length; i += 400) {
      await ctx.runMutation(internal.reports.writeBackfilledStats, { ...empty, yoyDailyStats: yoyDailyEntries.slice(i, i + 400) });
    }

    return {
      total,
      dailyDays: Object.keys(dailyDelta).length,
      gradYears: Object.keys(gradYearDelta).length,
      genders: Object.keys(genderDelta).length,
      states: Object.keys(stateDelta).length,
      cities: Object.keys(cityDelta).length,
      zips: Object.keys(zipDelta).length,
      yoyDailyKeys: Object.keys(yoyDailyDelta).length,
    };
  },
});
