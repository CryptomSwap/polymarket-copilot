/**
 * Read-only governance/runtime handshake audit.
 * Detects mismatch between runtime-effective config, ACTIVE profile revision snapshot,
 * INTENDED_ACTIVE model linkage, and actual scoring model selected by runtime.
 * Does not change runtime or admission behavior; ML remains advisory and paper-only.
 */

import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../db";
import type { EffectiveBotProfile } from "./bot-profiles";
import { getEffectiveBotProfiles } from "./bot-profiles";
import { getActiveOrApprovedShadowModel } from "@/lib/ml/shadow-score";

/** Inline read of ACTIVE revision for a bot (avoids importing profile-revisions so script runs under tsx). */
async function getActiveRevisionForAudit(
  botType: string,
  db: PrismaClient
): Promise<{
  id: string;
  revisionKey: string;
  profileSnapshotJson: string;
} | null> {
  try {
    const row = await db.paperBotProfileRevision.findFirst({
      where: { botType, status: "ACTIVE" },
      orderBy: { promotedAt: "desc" },
      select: { id: true, revisionKey: true, profileSnapshotJson: true },
    });
    return row;
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e && e.code === "P2021") return null;
    throw e;
  }
}

/** Inline read of INTENDED_ACTIVE model run id for a bot's ACTIVE revision (avoids importing profile-model-links). */
async function getIntendedActiveModelRunIdForAudit(
  botType: string,
  db: PrismaClient
): Promise<string | null> {
  try {
    const revision = await db.paperBotProfileRevision.findFirst({
      where: { botType, status: "ACTIVE" },
      orderBy: { promotedAt: "desc" },
      select: { id: true },
    });
    if (!revision) return null;
    const link = await db.paperBotProfileModelLink.findFirst({
      where: { profileRevisionId: revision.id, linkageRole: "INTENDED_ACTIVE" },
      orderBy: { createdAt: "desc" },
      select: { modelRunId: true },
    });
    return link?.modelRunId ?? null;
  } catch (e: unknown) {
    if (e && typeof e === "object" && "code" in e && e.code === "P2021") return null;
    throw e;
  }
}

/** Keys used for stable behavioral profile comparison (excludes display-only: displayName, notes). Exported for resolver reuse. */
export const BEHAVIORAL_PROFILE_KEYS = [
  "botType",
  "targetLabel",
  "botVersion",
  "threshold",
  "minScoreBuffer",
  "cooldownHours",
  "cooldownMarketHours",
  "maxOpenTotal",
  "maxOpenPerMarket",
  "maxOpenPerTheme",
  "maxOpenPerCategory",
  "maxDailyNewTrades",
  "allowReviewRequired",
  "allowPaperRelaxation",
  "allowRelaxationReasons",
  "allowedPolicyStates",
  "allowedPriceBands",
  "excludedThemes",
  "excludedCategories",
  "effectiveEnabled",
  "overrideSource",
  "explorationEnabled",
  "explorationBandBelowMinScore",
  "explorationMaxPerTick",
  "explorationMaxPerDay",
] as const;

export type BehavioralSnapshot = Record<string, unknown>;

function normalizeToBehavioralSnapshot(profile: EffectiveBotProfile): BehavioralSnapshot {
  const out: BehavioralSnapshot = {};
  for (const k of BEHAVIORAL_PROFILE_KEYS) {
    if (k in profile) {
      const v = (profile as Record<string, unknown>)[k];
      out[k] = v === undefined ? null : v;
    }
  }
  return out;
}

/** Parse ACTIVE revision profileSnapshotJson to behavioral snapshot. Exported for resolver reuse. */
export function parseRevisionSnapshotJson(json: string): BehavioralSnapshot | null {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const out: BehavioralSnapshot = {};
    for (const k of BEHAVIORAL_PROFILE_KEYS) {
      if (k in parsed) {
        out[k] = parsed[k] === undefined ? null : parsed[k];
      }
    }
    if (typeof parsed.displayName === "string") out.displayName = parsed.displayName;
    return out;
  } catch {
    return null;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const keysA = Object.keys(a as object).sort();
    const keysB = Object.keys(b as object).sort();
    if (keysA.length !== keysB.length || keysA.some((k, i) => k !== keysB[i])) return false;
    return keysA.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

export interface ProfileComparisonResult {
  profileMismatch: boolean;
  mismatchFields: string[];
}

/**
 * Compare runtime effective profile to ACTIVE revision snapshot using only behavioral fields.
 */
export function compareBehavioralSnapshots(
  runtimeSnapshot: BehavioralSnapshot,
  revisionSnapshot: BehavioralSnapshot | null
): ProfileComparisonResult {
  if (!revisionSnapshot) {
    return { profileMismatch: true, mismatchFields: ["no_active_revision_snapshot"] };
  }
  const mismatchFields: string[] = [];
  const allKeys = new Set([...Object.keys(runtimeSnapshot), ...Object.keys(revisionSnapshot)]);
  for (const k of allKeys) {
    if (!BEHAVIORAL_PROFILE_KEYS.includes(k as (typeof BEHAVIORAL_PROFILE_KEYS)[number])) continue;
    const r = runtimeSnapshot[k];
    const rev = revisionSnapshot[k];
    if (!deepEqual(r, rev)) {
      mismatchFields.push(k);
    }
  }
  return {
    profileMismatch: mismatchFields.length > 0,
    mismatchFields: mismatchFields.sort(),
  };
}

export interface GovernanceHandshakeAuditEntry {
  botType: string;
  runtimeProfileSnapshot: BehavioralSnapshot;
  activeRevisionId: string | null;
  activeRevisionKey: string | null;
  activeRevisionSnapshot: BehavioralSnapshot | null;
  profileMismatch: boolean;
  mismatchFields: string[];
  intendedActiveModelRunId: string | null;
  runtimeSelectedChampionModelRunId: string | null;
  modelMismatch: boolean;
  notes: string[];
  warnings: string[];
}

/**
 * Build a single audit entry for one bot. Does not throw; fills notes/warnings on missing data.
 * When run from a script (e.g. tsx), pass prisma so DB resolution works; from Next.js, optional.
 */
export async function getGovernanceHandshakeAuditForBot(
  botType: string,
  db?: PrismaClient
): Promise<GovernanceHandshakeAuditEntry> {
  const effective = await getEffectiveBotProfiles();
  const profile = effective.find((p) => p.botType === botType);
  const runtimeSnapshot = profile ? normalizeToBehavioralSnapshot(profile) : {};
  const notes: string[] = [];
  const warnings: string[] = [];
  const prismaClient = db ?? defaultPrisma;

  const [activeRevision, intendedActiveModelRunId, champion] = await Promise.all([
    getActiveRevisionForAudit(botType, prismaClient),
    getIntendedActiveModelRunIdForAudit(botType, prismaClient),
    getActiveOrApprovedShadowModel(),
  ]);

  const activeRevisionSnapshot = activeRevision?.profileSnapshotJson
    ? parseRevisionSnapshotJson(activeRevision.profileSnapshotJson)
    : null;

  const { profileMismatch, mismatchFields } = compareBehavioralSnapshots(runtimeSnapshot, activeRevisionSnapshot);
  const runtimeSelectedChampionModelRunId = champion?.run.id ?? null;
  const modelMismatch =
    intendedActiveModelRunId != null &&
    runtimeSelectedChampionModelRunId != null &&
    intendedActiveModelRunId !== runtimeSelectedChampionModelRunId;

  if (!profile) {
    warnings.push("bot_not_in_effective_profiles");
  }
  if (!activeRevision) {
    notes.push("no_active_governance_revision");
  }
  if (intendedActiveModelRunId == null && activeRevision) {
    notes.push("active_revision_has_no_intended_active_model_link");
  }
  if (runtimeSelectedChampionModelRunId == null) {
    warnings.push("no_runtime_champion_model");
  }
  if (profileMismatch && mismatchFields.length > 0) {
    notes.push(`profile_mismatch_fields: ${mismatchFields.join(", ")}`);
  }
  if (modelMismatch) {
    notes.push(
      `model_mismatch: intended=${intendedActiveModelRunId} vs runtime_champion=${runtimeSelectedChampionModelRunId}`
    );
  }

  return {
    botType,
    runtimeProfileSnapshot: runtimeSnapshot,
    activeRevisionId: activeRevision?.id ?? null,
    activeRevisionKey: activeRevision?.revisionKey ?? null,
    intendedActiveModelRunId: intendedActiveModelRunId ?? null,
    activeRevisionSnapshot,
    profileMismatch,
    mismatchFields,
    runtimeSelectedChampionModelRunId,
    modelMismatch,
    notes,
    warnings,
  };
}

/**
 * Audit all bots that appear in effective profiles.
 * When run from a script (e.g. tsx), pass prisma so DB resolution works; from Next.js, optional.
 */
export async function getGovernanceHandshakeAudit(db?: PrismaClient): Promise<{
  generatedAt: string;
  runtimeChampionModelRunId: string | null;
  audits: GovernanceHandshakeAuditEntry[];
}> {
  const [effective, champion] = await Promise.all([
    getEffectiveBotProfiles(),
    getActiveOrApprovedShadowModel(),
  ]);

  const botTypes = new Set<string>(effective.map((p) => p.botType));
  const prismaClient = db ?? defaultPrisma;

  const audits = await Promise.all(
    Array.from(botTypes).sort().map((botType) => getGovernanceHandshakeAuditForBot(botType, prismaClient))
  );

  return {
    generatedAt: new Date().toISOString(),
    runtimeChampionModelRunId: champion?.run.id ?? null,
    audits,
  };
}
