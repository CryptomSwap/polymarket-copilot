import type { PriceBandLabel } from "./bot-profiles";

export const ENTRY_PRICE_BAND_DEFINITIONS: {
  label: PriceBandLabel;
  min: number;
  max: number;
  minInclusive: boolean;
  maxInclusive: boolean;
}[] = [
  { label: "0.0-0.1", min: 0, max: 0.1, minInclusive: true, maxInclusive: false },
  { label: "0.1-0.3", min: 0.1, max: 0.3, minInclusive: true, maxInclusive: false },
  { label: "0.3-0.7", min: 0.3, max: 0.7, minInclusive: true, maxInclusive: false },
  { label: "0.7-0.9", min: 0.7, max: 0.9, minInclusive: true, maxInclusive: false },
  { label: "0.9-1.0", min: 0.9, max: 1, minInclusive: true, maxInclusive: true },
];

export function parseEntryPrice(entryPrice: string | null | undefined): number | null {
  if (entryPrice == null || entryPrice === "") return null;
  const n = parseFloat(entryPrice);
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return n;
}

export function classifyEntryPriceBand(price: number | null): PriceBandLabel | null {
  if (price == null || price < 0 || price > 1) return null;
  for (const b of ENTRY_PRICE_BAND_DEFINITIONS) {
    const inMin = b.minInclusive ? price >= b.min : price > b.min;
    const inMax = b.maxInclusive ? price <= b.max : price < b.max;
    if (inMin && inMax) return b.label;
  }
  return null;
}

