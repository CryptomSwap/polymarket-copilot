import { prisma } from "@/lib/db";
import type { EffectiveBotProfile } from "./bot-profiles";

export type PaperBotProfileRevisionStatus = "DRAFT" | "STAGED" | "ACTIVE" | "ARCHIVED";

export interface PaperBotProfileRevisionRecord {
  id: string;
  botType: string;
  revisionKey: string;
  status: PaperBotProfileRevisionStatus;
  targetLabel: string | null;
  profileSnapshotJson: string;
  notes: string | null;
  promotedAt: Date | null;
  rollbackTargetRevision: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toStatus(raw: string): PaperBotProfileRevisionStatus {
  if (raw === "STAGED" || raw === "ACTIVE" || raw === "ARCHIVED") return raw;
  return "DRAFT";
}

export function buildProfileSnapshot(profile: EffectiveBotProfile): string {
  return JSON.stringify(
    {
      botType: profile.botType,
      displayName: profile.displayName,
      targetLabel: profile.targetLabel,
      botVersion: profile.botVersion,
      threshold: profile.threshold,
      minScoreBuffer: profile.minScoreBuffer,
      cooldownHours: profile.cooldownHours,
      cooldownMarketHours: profile.cooldownMarketHours,
      maxOpenTotal: profile.maxOpenTotal,
      maxOpenPerMarket: profile.maxOpenPerMarket,
      maxOpenPerTheme: profile.maxOpenPerTheme,
      maxOpenPerCategory: profile.maxOpenPerCategory,
      maxDailyNewTrades: profile.maxDailyNewTrades,
      allowReviewRequired: profile.allowReviewRequired,
      allowPaperRelaxation: profile.allowPaperRelaxation,
      allowRelaxationReasons: profile.allowRelaxationReasons,
      allowedPolicyStates: profile.allowedPolicyStates,
      allowedPriceBands: profile.allowedPriceBands,
      excludedThemes: profile.excludedThemes,
      excludedCategories: profile.excludedCategories,
      notes: profile.notes,
      effectiveEnabled: profile.effectiveEnabled,
      overrideSource: profile.overrideSource ?? null,
    },
    null,
    2
  );
}

export async function registerProfileRevision(params: {
  profile: EffectiveBotProfile;
  revisionKey?: string;
  status?: PaperBotProfileRevisionStatus;
  notes?: string;
  rollbackTargetRevision?: string;
}): Promise<PaperBotProfileRevisionRecord> {
  const { profile } = params;
  const revisionKey = params.revisionKey ?? (profile.botVersion ?? `rev-${new Date().toISOString()}`);
  const status: PaperBotProfileRevisionStatus = params.status ?? "DRAFT";
  const snapshot = buildProfileSnapshot(profile);

  const row = await prisma.paperBotProfileRevision.create({
    data: {
      botType: profile.botType,
      revisionKey,
      status,
      targetLabel: profile.targetLabel,
      profileSnapshotJson: snapshot,
      notes: params.notes ?? null,
      rollbackTargetRevision: params.rollbackTargetRevision ?? null,
    },
  });

  return {
    id: row.id,
    botType: row.botType,
    revisionKey: row.revisionKey,
    status: toStatus(row.status),
    targetLabel: row.targetLabel,
    profileSnapshotJson: row.profileSnapshotJson,
    notes: row.notes,
    promotedAt: row.promotedAt,
    rollbackTargetRevision: row.rollbackTargetRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listProfileRevisions(botType?: string): Promise<PaperBotProfileRevisionRecord[]> {
  const rows = await prisma.paperBotProfileRevision.findMany({
    where: botType ? { botType } : undefined,
    orderBy: [{ botType: "asc" }, { createdAt: "asc" }],
  });
  return rows.map((row) => ({
    id: row.id,
    botType: row.botType,
    revisionKey: row.revisionKey,
    status: toStatus(row.status),
    targetLabel: row.targetLabel,
    profileSnapshotJson: row.profileSnapshotJson,
    notes: row.notes,
    promotedAt: row.promotedAt,
    rollbackTargetRevision: row.rollbackTargetRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function getProfileRevisionById(id: string): Promise<PaperBotProfileRevisionRecord | null> {
  const row = await prisma.paperBotProfileRevision.findUnique({ where: { id } });
  if (!row) return null;
  return {
    id: row.id,
    botType: row.botType,
    revisionKey: row.revisionKey,
    status: toStatus(row.status),
    targetLabel: row.targetLabel,
    profileSnapshotJson: row.profileSnapshotJson,
    notes: row.notes,
    promotedAt: row.promotedAt,
    rollbackTargetRevision: row.rollbackTargetRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function markRevisionActive(params: {
  revisionId: string;
  demotePreviousTo?: Exclude<PaperBotProfileRevisionStatus, "ACTIVE">;
}): Promise<{ promoted: PaperBotProfileRevisionRecord; demoted: PaperBotProfileRevisionRecord[] }> {
  const { revisionId } = params;
  const demoteTo: PaperBotProfileRevisionStatus = params.demotePreviousTo ?? "ARCHIVED";

  return await prisma.$transaction(async (tx) => {
    const current = await tx.paperBotProfileRevision.findUnique({ where: { id: revisionId } });
    if (!current) {
      throw new Error(`Revision not found: ${revisionId}`);
    }

    const botType = current.botType;
    const now = new Date();

    const previousActive = await tx.paperBotProfileRevision.findMany({
      where: { botType, status: "ACTIVE", id: { not: revisionId } },
    });

    const demoted: PaperBotProfileRevisionRecord[] = [];
    for (const prev of previousActive) {
      const updated = await tx.paperBotProfileRevision.update({
        where: { id: prev.id },
        data: { status: demoteTo },
      });
      demoted.push({
        id: updated.id,
        botType: updated.botType,
        revisionKey: updated.revisionKey,
        status: toStatus(updated.status),
        targetLabel: updated.targetLabel,
        profileSnapshotJson: updated.profileSnapshotJson,
        notes: updated.notes,
        promotedAt: updated.promotedAt,
        rollbackTargetRevision: updated.rollbackTargetRevision,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      });
    }

    const promotedRow = await tx.paperBotProfileRevision.update({
      where: { id: revisionId },
      data: {
        status: "ACTIVE",
        promotedAt: now,
      },
    });

    const promoted: PaperBotProfileRevisionRecord = {
      id: promotedRow.id,
      botType: promotedRow.botType,
      revisionKey: promotedRow.revisionKey,
      status: toStatus(promotedRow.status),
      targetLabel: promotedRow.targetLabel,
      profileSnapshotJson: promotedRow.profileSnapshotJson,
      notes: promotedRow.notes,
      promotedAt: promotedRow.promotedAt,
      rollbackTargetRevision: promotedRow.rollbackTargetRevision,
      createdAt: promotedRow.createdAt,
      updatedAt: promotedRow.updatedAt,
    };

    return { promoted, demoted };
  });
}

export async function getActiveRevisionForBot(botType: string): Promise<PaperBotProfileRevisionRecord | null> {
  const row = await prisma.paperBotProfileRevision.findFirst({
    where: { botType, status: "ACTIVE" },
    orderBy: { promotedAt: "desc" },
  });
  if (!row) return null;
  return {
    id: row.id,
    botType: row.botType,
    revisionKey: row.revisionKey,
    status: toStatus(row.status),
    targetLabel: row.targetLabel,
    profileSnapshotJson: row.profileSnapshotJson,
    notes: row.notes,
    promotedAt: row.promotedAt,
    rollbackTargetRevision: row.rollbackTargetRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

