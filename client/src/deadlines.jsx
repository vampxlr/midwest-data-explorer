/**
 * Shared deadline-marker state for every chart in the app.
 *  - useDeadlineMap(): the scraped/edited deadlines, fetched once and cached
 *  - useDeadlinesOn(): reactive ON/OFF state (persisted, default ON)
 *  - <DeadlineToggle/>: the ⏰ pill button — drop it next to any chart
 */
import React, { useEffect, useState } from 'react';
import { api } from './api.jsx';

const KEY = 'mw3-show-deadlines';
let cache = null, inflight = null;

export function isDeadlinesOn() {
  try { return localStorage.getItem(KEY) !== '0'; } catch { return true; }
}

/** Call after importing/scraping/editing deadlines so every mounted chart
 *  refetches — otherwise an open tab keeps the pre-import list forever. */
export function invalidateDeadlineCache() {
  cache = null; inflight = null;
  window.dispatchEvent(new Event('mw3-deadlines-refresh'));
}

export function useDeadlineMap() {
  const [map, setMap] = useState(cache || {});
  useEffect(() => {
    const fetchMap = () => {
      if (cache) { setMap(cache); return; }
      // a failed fetch must not poison the cache — reset inflight so the
      // next mount (or refresh event) retries instead of staying empty
      inflight = inflight || api.getDeadlines()
        .then(r => (cache = r.data.deadlines || {}))
        .catch(err => { inflight = null; throw err; });
      inflight.then(m => setMap(m)).catch(() => {});
    };
    fetchMap();
    window.addEventListener('mw3-deadlines-refresh', fetchMap);
    return () => window.removeEventListener('mw3-deadlines-refresh', fetchMap);
  }, []);
  return map;
}

export function useDeadlinesOn() {
  const [on, setOn] = useState(isDeadlinesOn());
  useEffect(() => {
    const f = () => setOn(isDeadlinesOn());
    window.addEventListener('mw3-deadlines-toggle', f);
    return () => window.removeEventListener('mw3-deadlines-toggle', f);
  }, []);
  return on;
}

export function DeadlineToggle({ style }) {
  const on = useDeadlinesOn();
  return (
    <button
      onClick={() => {
        try { localStorage.setItem(KEY, on ? '0' : '1'); } catch {}
        window.dispatchEvent(new Event('mw3-deadlines-toggle'));
      }}
      title="Show early-bird / final registration deadline markers on charts"
      style={{
        padding:'4px 10px', borderRadius:999, fontSize:11, fontWeight:700, cursor:'pointer',
        border: on ? '1px solid rgba(25,158,112,0.5)' : '1px solid var(--border)',
        background: on ? 'rgba(25,158,112,0.12)' : 'var(--bg-hover)',
        color: on ? 'var(--viz-2)' : 'var(--text-3)', ...style,
      }}>
      ⏰ Deadlines {on ? 'ON' : 'OFF'}
    </button>
  );
}

/** Nearest x-axis label to a deadline's MM-DD on a category axis — so the
 *  marker shows even when nobody registered on the exact deadline day. */
export function nearestLabel(chartData, isoDate, mmddKey = 'mmdd', labelKey = 'label') {
  if (!isoDate || !chartData?.length) return null;
  const target = isoDate.slice(5);
  let best = null;
  for (const d of chartData) {
    if (d[mmddKey] <= target) best = d;      // last point at/before the deadline
    else break;
  }
  return (best || chartData[0])[labelKey];
}
