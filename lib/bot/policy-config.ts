/**
 * Bot policy config: persisted TradingPolicyConfig with fallback to defaults.
 * Single source of truth for effective guardrail config used by dry-run, precheck, and execute.
 */

import { prisma } from "@/lib/db";
import {
  DEFAULT_GUARDRAIL_CONFIG,
  type BotGuardrailConfig,
} from "./types";

const CONFIG_KEY = "default";

function rowToConfig(row: {
  perMarketCapPct: number;
  perThemeCapPct: number;
  nearResolutionBlockHours: number;
  allowNearResolutionAdd: boolean;
  duplicateThesisThemeCapPct: number;
  blockStaleSync: boolean;
  blockUnresolvedCatalog: boolean;
}): BotGuardrailConfig {
  return {
    blockUnresolvedCatalog: Boolean(row.blockUnresolvedCatalog),
    blockStaleSync: Boolean(row.blockStaleSync),
    perMarketCapPct: Number(row.perMarketCapPct) || DEFAULT_GUARDRAIL_CONFIG.perMarketCapPct,
    perThemeCapPct: Number(row.perThemeCapPct) || DEFAULT_GUARDRAIL_CONFIG.perThemeCapPct,
    nearResolutionBlockHours: Number(row.nearResolutionBlockHours) ?? DEFAULT_GUARDRAIL_CONFIG.nearResolutionBlockHours,
    allowNearResolutionAdd: Boolean(row.allowNearResolutionAdd),
    duplicateThesisThemeCapPct: Number(row.duplicateThesisThemeCapPct) ?? DEFAULT_GUARDRAIL_CONFIG.duplicateThesisThemeCapPct,
  };
}

/**
 * Returns the effective guardrail config: stored config if present, merged over defaults.
 * Used by dry-run, precheck, and execute so all paths share the same policy.
 */
export async function getEffectiveGuardrailConfig(): Promise<BotGuardrailConfig> {
  const row = await prisma.tradingPolicyConfig.findUnique({
    where: { key: CONFIG_KEY },
  });
  if (!row) return { ...DEFAULT_GUARDRAIL_CONFIG };
  return {
    ...DEFAULT_GUARDRAIL_CONFIG,
    ...rowToConfig(row),
  };
}

/**
 * Persist policy config. Creates or updates the singleton row (key = "default").
 */
export async function savePolicyConfig(
  input: Partial<{
    perMarketCapPct: number;
    perThemeCapPct: number;
    nearResolutionBlockHours: number;
    allowNearResolutionAdd: boolean;
    duplicateThesisThemeCapPct: number;
    blockStaleSync: boolean;
    blockUnresolvedCatalog: boolean;
  }>
): Promise<BotGuardrailConfig> {
  const existing = await prisma.tradingPolicyConfig.findUnique({
    where: { key: CONFIG_KEY },
  });

  const data = {
    perMarketCapPct: input.perMarketCapPct ?? existing?.perMarketCapPct ?? DEFAULT_GUARDRAIL_CONFIG.perMarketCapPct,
    perThemeCapPct: input.perThemeCapPct ?? existing?.perThemeCapPct ?? DEFAULT_GUARDRAIL_CONFIG.perThemeCapPct,
    nearResolutionBlockHours: input.nearResolutionBlockHours ?? existing?.nearResolutionBlockHours ?? DEFAULT_GUARDRAIL_CONFIG.nearResolutionBlockHours,
    allowNearResolutionAdd: input.allowNearResolutionAdd ?? existing?.allowNearResolutionAdd ?? DEFAULT_GUARDRAIL_CONFIG.allowNearResolutionAdd,
    duplicateThesisThemeCapPct: input.duplicateThesisThemeCapPct ?? existing?.duplicateThesisThemeCapPct ?? DEFAULT_GUARDRAIL_CONFIG.duplicateThesisThemeCapPct,
    blockStaleSync: input.blockStaleSync ?? existing?.blockStaleSync ?? DEFAULT_GUARDRAIL_CONFIG.blockStaleSync,
    blockUnresolvedCatalog: input.blockUnresolvedCatalog ?? existing?.blockUnresolvedCatalog ?? DEFAULT_GUARDRAIL_CONFIG.blockUnresolvedCatalog,
  };

  if (existing) {
    const updated = await prisma.tradingPolicyConfig.update({
      where: { key: CONFIG_KEY },
      data: { ...data, updatedAt: new Date() },
    });
    return rowToConfig(updated);
  }

  const created = await prisma.tradingPolicyConfig.create({
    data: {
      key: CONFIG_KEY,
      ...data,
    },
  });
  return rowToConfig(created);
}

/**
 * Get stored config row for API (read). Returns null if none saved (frontend can show defaults).
 */
export async function getStoredPolicyConfig(): Promise<{
  perMarketCapPct: number;
  perThemeCapPct: number;
  nearResolutionBlockHours: number;
  allowNearResolutionAdd: boolean;
  duplicateThesisThemeCapPct: number;
  blockStaleSync: boolean;
  blockUnresolvedCatalog: boolean;
  updatedAt: string;
} | null> {
  const row = await prisma.tradingPolicyConfig.findUnique({
    where: { key: CONFIG_KEY },
  });
  if (!row) return null;
  return {
    perMarketCapPct: row.perMarketCapPct,
    perThemeCapPct: row.perThemeCapPct,
    nearResolutionBlockHours: row.nearResolutionBlockHours,
    allowNearResolutionAdd: row.allowNearResolutionAdd,
    duplicateThesisThemeCapPct: row.duplicateThesisThemeCapPct,
    blockStaleSync: row.blockStaleSync,
    blockUnresolvedCatalog: row.blockUnresolvedCatalog,
    updatedAt: row.updatedAt.toISOString(),
  };
}
