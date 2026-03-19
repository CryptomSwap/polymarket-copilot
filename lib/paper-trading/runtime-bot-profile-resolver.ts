/**
 * Resolver for per-bot runtime profile: current behavior vs governance ACTIVE revision.
 * Default (flag OFF): current behavior only (BOT_PROFILES + global config + env).
 * When flag ON: ACTIVE revision snapshot if present and valid, then env overrides; else fallback to current.
 * Does not change behavior unless ENABLE_PAPER_RUNTIME_PROFILE_FROM_ACTIVE_REVISION is explicitly set.
 */

import { enablePaperRuntimeProfileFromActiveRevision } from "@/lib/ml/config";
import type { EffectiveBotProfile } from "./bot-profiles";
import { BOT_PROFILES, getEffectiveBotProfiles, getBotProfile } from "./bot-profiles";
import { getPaperTradingConfig } from "./config";
import type { PriceBandLabel } from "./bot-profiles";
import { getActiveRevisionForBot } from "./profile-revisions";
import { parseRevisionSnapshotJson, type BehavioralSnapshot } from "./governance-handshake-audit";

export type BotProfileResolutionSource = "current_behavior" | "active_revision";

export type BotProfileResolutionWarning =
  | "no_active_revision"
  | "invalid_revision_snapshot"
  | "missing_required_behavioral_fields"
  | "env_override_applied"
  | "fell_back_to_current_behavior";

export interface BotProfileResolutionResult {
  /** Resolved profile (always present; matches current behavior when fallback used). */
  profile: EffectiveBotProfile;
  source: BotProfileResolutionSource;
  fallbackUsed: boolean;
  warnings: BotProfileResolutionWarning[];
  resolvedProfileRevisionId: string | null;
  resolvedProfileRevisionKey: string | null;
  effectiveEnabled: boolean;
  overrideSource: "env" | null;
}

const REQUIRED_SNAPSHOT_FIELDS = ["botType", "threshold"] as const;

function isValidSnapshot(snap: BehavioralSnapshot | null, botType: string): {
  valid: boolean;
  warning?: BotProfileResolutionWarning;
} {
  if (!snap || typeof snap !== "object") {
    return { valid: false, warning: "invalid_revision_snapshot" };
  }
  for (const k of REQUIRED_SNAPSHOT_FIELDS) {
    if (!(k in snap)) return { valid: false, warning: "missing_required_behavioral_fields" };
    if (k === "botType" && typeof snap.botType !== "string") return { valid: false, warning: "missing_required_behavioral_fields" };
    if (k === "threshold") {
      const t = snap.threshold;
      if (typeof t !== "number" || !Number.isFinite(t) || t < 0 || t > 1) {
        return { valid: false, warning: "missing_required_behavioral_fields" };
      }
    }
  }
  if (snap.botType !== botType) return { valid: false, warning: "invalid_revision_snapshot" };
  return { valid: true };
}

function applyEnvOverridesToEffective(
  base: EffectiveBotProfile
): { profile: EffectiveBotProfile; overrideApplied: boolean } {
  const envKeyEnabled = `PAPER_BOT_ENABLED_${base.botType.toUpperCase()}`;
  const envKeyDisabled = `PAPER_BOT_DISABLED_${base.botType.toUpperCase()}`;
  const rawEnabled = typeof process !== "undefined" ? process.env[envKeyEnabled]?.trim().toLowerCase() : "";
  const rawDisabled = typeof process !== "undefined" ? process.env[envKeyDisabled]?.trim().toLowerCase() : "";
  const overrideEnabled =
    rawEnabled === "1" || rawEnabled === "true"
      ? true
      : rawDisabled === "1" || rawDisabled === "true"
        ? false
        : null;
  const effectiveEnabled = overrideEnabled != null ? overrideEnabled : base.enabled;
  const overrideSource = overrideEnabled != null ? ("env" as const) : null;
  return {
    profile: { ...base, effectiveEnabled, overrideSource },
    overrideApplied: overrideSource !== null,
  };
}

function effectiveFromSnapshot(
  snap: BehavioralSnapshot,
  botType: string,
  global: ReturnType<typeof getPaperTradingConfig>
): EffectiveBotProfile {
  const baseProfile = getBotProfile(botType);
  const displayName =
    (typeof snap.displayName === "string" && snap.displayName) || baseProfile?.displayName || botType;

  const num = (v: unknown, def: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : def;
  const arr = (v: unknown, def: string[]): string[] => (Array.isArray(v) ? v.map(String) : def);
  const arrOrNull = (v: unknown): string[] | null => (Array.isArray(v) ? v.map(String) : null);

  const effectiveEnabled = snap.effectiveEnabled === true;
  const profile: EffectiveBotProfile = {
    botType,
    displayName,
    enabled: baseProfile?.enabled ?? true,
    targetLabel: typeof snap.targetLabel === "string" ? snap.targetLabel : baseProfile?.targetLabel ?? null,
    botVersion: typeof snap.botVersion === "string" ? snap.botVersion : baseProfile?.botVersion ?? null,
    threshold: num(snap.threshold, global.threshold),
    minScoreBuffer: num(snap.minScoreBuffer, global.minScoreBuffer),
    allowReviewRequired: snap.allowReviewRequired === true,
    allowPaperRelaxation: snap.allowPaperRelaxation !== false,
    allowRelaxationReasons: arrOrNull(snap.allowRelaxationReasons) ?? baseProfile?.allowRelaxationReasons ?? null,
    allowedPolicyStates: arrOrNull(snap.allowedPolicyStates) ?? baseProfile?.allowedPolicyStates ?? null,
    allowedPriceBands: (arrOrNull(snap.allowedPriceBands) as PriceBandLabel[] | null) ?? baseProfile?.allowedPriceBands ?? null,
    excludedThemes: arr(snap.excludedThemes, baseProfile?.excludedThemes ?? []),
    excludedCategories: arr(snap.excludedCategories, baseProfile?.excludedCategories ?? []),
    cooldownHours: num(snap.cooldownHours, global.cooldownHours),
    cooldownMarketHours: num(snap.cooldownMarketHours, global.cooldownMarketHours),
    maxOpenTotal: num(snap.maxOpenTotal, global.maxOpenTotal),
    maxOpenPerMarket: num(snap.maxOpenPerMarket, global.maxOpenPerMarket),
    maxOpenPerTheme: num(snap.maxOpenPerTheme, global.maxOpenPerTheme),
    maxOpenPerCategory: num(snap.maxOpenPerCategory, global.maxOpenPerCategory),
    maxDailyNewTrades: num(snap.maxDailyNewTrades, global.maxDailyNewTrades),
    notes: typeof snap.notes === "string" ? snap.notes : null,
    effectiveEnabled,
    overrideSource: snap.overrideSource === "env" ? "env" : null,
    explorationEnabled: snap.explorationEnabled === true,
    explorationBandBelowMinScore: num(snap.explorationBandBelowMinScore, 0),
    explorationMaxPerTick: num(snap.explorationMaxPerTick, 0),
    explorationMaxPerDay: num(snap.explorationMaxPerDay, 0),
  };
  return profile;
}

/**
 * Resolve runtime bot profile for a bot. When flag OFF, returns current behavior only.
 * When flag ON, uses ACTIVE revision if valid, then env overrides; otherwise falls back to current behavior.
 * For reporting: pass forceGovernancePath: true to compute hypothetical ON result without enabling the flag.
 */
export async function resolveBotProfile(
  botType: string,
  options?: { forceGovernancePath?: boolean }
): Promise<BotProfileResolutionResult> {
  const useGovernance = options?.forceGovernancePath ?? enablePaperRuntimeProfileFromActiveRevision();
  const effectiveList = await getEffectiveBotProfiles();
  const currentProfile = effectiveList.find((p) => p.botType === botType);

  const fallbackResult = (): BotProfileResolutionResult => {
    const p = currentProfile ?? {
      botType,
      displayName: botType,
      enabled: false,
      targetLabel: null,
      botVersion: null,
      threshold: getPaperTradingConfig().threshold,
      minScoreBuffer: getPaperTradingConfig().minScoreBuffer,
      allowReviewRequired: false,
      allowPaperRelaxation: true,
      allowRelaxationReasons: null,
      allowedPolicyStates: null,
      allowedPriceBands: null,
      excludedThemes: [],
      excludedCategories: [],
      cooldownHours: getPaperTradingConfig().cooldownHours,
      cooldownMarketHours: getPaperTradingConfig().cooldownMarketHours,
      maxOpenTotal: getPaperTradingConfig().maxOpenTotal,
      maxOpenPerMarket: getPaperTradingConfig().maxOpenPerMarket,
      maxOpenPerTheme: getPaperTradingConfig().maxOpenPerTheme,
      maxOpenPerCategory: getPaperTradingConfig().maxOpenPerCategory,
      maxDailyNewTrades: getPaperTradingConfig().maxDailyNewTrades,
      notes: null,
      effectiveEnabled: false,
      overrideSource: null,
      explorationEnabled: false,
      explorationBandBelowMinScore: 0,
      explorationMaxPerTick: 0,
      explorationMaxPerDay: 0,
    };
    return {
      profile: p,
      source: "current_behavior",
      fallbackUsed: true,
      warnings: ["fell_back_to_current_behavior"],
      resolvedProfileRevisionId: null,
      resolvedProfileRevisionKey: null,
      effectiveEnabled: p.effectiveEnabled,
      overrideSource: p.overrideSource ?? null,
    };
  };

  if (!useGovernance) {
    const p = currentProfile ?? fallbackResult().profile;
    return {
      profile: p,
      source: "current_behavior",
      fallbackUsed: false,
      warnings: [],
      resolvedProfileRevisionId: null,
      resolvedProfileRevisionKey: null,
      effectiveEnabled: p.effectiveEnabled,
      overrideSource: p.overrideSource ?? null,
    };
  }

  let activeRevision: Awaited<ReturnType<typeof getActiveRevisionForBot>>;
  try {
    activeRevision = await getActiveRevisionForBot(botType);
  } catch {
    return { ...fallbackResult(), warnings: ["no_active_revision", "fell_back_to_current_behavior"] };
  }

  if (!activeRevision) {
    return { ...fallbackResult(), warnings: ["no_active_revision", "fell_back_to_current_behavior"] };
  }

  const snapshot = parseRevisionSnapshotJson(activeRevision.profileSnapshotJson);
  const { valid, warning: snapWarning } = isValidSnapshot(snapshot, botType);
  if (!valid || !snapshot) {
    const warnings: BotProfileResolutionWarning[] = [
      snapWarning ?? "invalid_revision_snapshot",
      "fell_back_to_current_behavior",
    ];
    return { ...fallbackResult(), warnings };
  }

  const global = getPaperTradingConfig();
  const fromSnapshot = effectiveFromSnapshot(snapshot, botType, global);
  const { profile, overrideApplied } = applyEnvOverridesToEffective(fromSnapshot);
  const warnings: BotProfileResolutionWarning[] = [];
  if (overrideApplied) warnings.push("env_override_applied");

  return {
    profile,
    source: "active_revision",
    fallbackUsed: false,
    warnings,
    resolvedProfileRevisionId: activeRevision.id,
    resolvedProfileRevisionKey: activeRevision.revisionKey,
    effectiveEnabled: profile.effectiveEnabled,
    overrideSource: profile.overrideSource ?? null,
  };
}

/**
 * Resolve runtime profiles for all bots in BOT_PROFILES. Same contract as resolveBotProfile per bot.
 */
export async function resolveAllBotProfiles(): Promise<BotProfileResolutionResult[]> {
  const botTypes = BOT_PROFILES.map((p) => p.botType);
  return Promise.all(botTypes.map((botType) => resolveBotProfile(botType)));
}
