/**
 * In-memory store for the latest portfolio risk snapshot.
 * Updated by decision recompute, guardrails/intelligence, or reconciliation flows.
 * Read by execution policy (worker) when building policy input.
 */

import type { PortfolioRiskSnapshot } from "./types";

let lastSnapshot: PortfolioRiskSnapshot | null = null;
let lastFunderAddress: string | null = null;

const MAX_AGE_MS = 10 * 60 * 1000; // 10 min

export function setPortfolioRiskSnapshot(
  snapshot: PortfolioRiskSnapshot,
  funderAddress: string
): void {
  lastSnapshot = snapshot;
  lastFunderAddress = funderAddress?.toLowerCase()?.trim() ?? null;
}

export function getPortfolioRiskSnapshot(
  funderAddress?: string | null
): PortfolioRiskSnapshot | null {
  if (lastSnapshot == null) return null;
  const funder = funderAddress?.toLowerCase()?.trim();
  if (funder != null && lastFunderAddress !== null && lastFunderAddress !== funder) {
    return null;
  }
  const at = new Date(lastSnapshot.computedAt).getTime();
  if (Number.isNaN(at) || Date.now() - at > MAX_AGE_MS) {
    return null;
  }
  return lastSnapshot;
}

export function clearPortfolioRiskSnapshot(): void {
  lastSnapshot = null;
  lastFunderAddress = null;
}
