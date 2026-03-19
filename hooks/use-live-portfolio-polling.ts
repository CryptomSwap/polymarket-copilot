"use client";

import { useState, useEffect, useCallback, useRef } from "react";

const DEFAULT_POLL_INTERVAL_MS = 10_000; // 10 seconds

export interface LivePortfolioPollingOptions {
  /** Poll interval in ms. Default 10_000. Set to 0 to disable polling. */
  intervalMs?: number;
  /** Refetch when window receives focus. Default true. */
  refetchOnFocus?: boolean;
  /** If true, do not start a new fetch while one is in flight. Default true. */
  preventOverlap?: boolean;
  /** If true, skip the initial fetch (caller will trigger). */
  skipInitialFetch?: boolean;
}

export interface LivePortfolioPollingResult<T> {
  data: T | null;
  setData: (data: T | null) => void;
  loading: boolean;
  error: string | null;
  /** Trigger a refetch. Respects preventOverlap. */
  refresh: () => void;
  /** True while a fetch is in progress (after first load). */
  isRefreshing: boolean;
  /** When the last successful fetch completed (ISO string or null). */
  lastFetchedAt: string | null;
}

/**
 * Polling hook for live portfolio data. Fetches on mount (unless skipInitialFetch),
 * every intervalMs, and on window focus. Cleans up interval and focus listener on unmount.
 * Prevents overlapping requests when preventOverlap is true.
 */
export function useLivePortfolioPolling<T>(
  fetchFn: () => Promise<T>,
  options: LivePortfolioPollingOptions = {}
): LivePortfolioPollingResult<T> {
  const {
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
    refetchOnFocus = true,
    preventOverlap = true,
    skipInitialFetch = false,
  } = options;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(!skipInitialFetch);
  const [error, setError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null);

  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const hasFetchedOnceRef = useRef(false);

  const doFetch = useCallback(async () => {
    if (preventOverlap && inFlightRef.current) return;
    inFlightRef.current = true;
    const isInitial = !hasFetchedOnceRef.current && !skipInitialFetch;
    if (!isInitial) setIsRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const result = await fetchFn();
      if (mountedRef.current) {
        hasFetchedOnceRef.current = true;
        setData(result);
        setLastFetchedAt(new Date().toISOString());
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "Refresh failed";
      if (mountedRef.current) setError(message);
    } finally {
      inFlightRef.current = false;
      if (mountedRef.current) {
        setLoading(false);
        setIsRefreshing(false);
      }
    }
  }, [fetchFn, preventOverlap, skipInitialFetch]);

  const refresh = useCallback(() => {
    doFetch();
  }, [doFetch]);

  useEffect(() => {
    mountedRef.current = true;
    if (!skipInitialFetch) {
      doFetch();
    }
    return () => {
      mountedRef.current = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- only on mount

  useEffect(() => {
    if (intervalMs <= 0) return;
    const id = setInterval(() => {
      if (mountedRef.current) doFetch();
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, doFetch]);

  useEffect(() => {
    if (!refetchOnFocus) return;
    const onFocus = () => {
      if (mountedRef.current) doFetch();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refetchOnFocus, doFetch]);

  return {
    data,
    setData,
    loading,
    error,
    refresh,
    isRefreshing,
    lastFetchedAt,
  };
}
