/**
 * Convex-backed report hooks.
 *
 * Only efficient indexed queries live here. Aggregate stats (daily, gradYears,
 * yoy, byEvent) still come from Express — they require full-table scans that
 * exceed Convex's per-query read limit for the current dataset size.
 *
 * Each hook returns null when VITE_CONVEX_URL is not set (legacy mode).
 */

import { useQuery } from "convex/react";
import { api } from "@convex/api";
import { convex } from "../convexClient.js";

/** Current store meta (total count, lastRunAt) + all events map. */
export function useStoreStatus() {
  return useQuery(convex ? api.reports.storeStatus : null);
}

/** All raw results for a single event (from Convex index). */
export function useResultsByEvent(eventId) {
  return useQuery(
    convex && eventId ? api.reports.resultsByEvent : null,
    convex && eventId ? { eventId } : undefined
  );
}

/**
 * Lapsed individuals — people in sourceEventIds who are NOT in excludeEventIds.
 * Uses per-event indexed scans, stays within Convex read limits.
 */
export function useLapsedIndividuals({
  sourceEventIds = [],
  excludeEventIds = [],
  genderFilter,
  gyFrom,
  gyTo,
} = {}) {
  return useQuery(
    convex ? api.reports.lapsedIndividuals : null,
    convex
      ? { sourceEventIds, excludeEventIds, genderFilter, gyFrom, gyTo }
      : undefined
  );
}

/**
 * Audience preview — unique emails matching filters across given event IDs.
 */
export function useAudiencePreview({
  eventIds = [],
  genderFilter,
  gradYearFilter,
} = {}) {
  return useQuery(
    convex ? api.reports.audiencePreview : null,
    convex ? { eventIds, genderFilter, gradYearFilter } : undefined
  );
}
