import { prisma } from "@/lib/db";
import type { PaperBotProfileRevisionRecord } from "./profile-revisions";

export type ProfileModelLinkRole =
  | "EVALUATED_WITH"
  | "INTENDED_ACTIVE"
  | "ROLLBACK_TARGET";

export interface ProfileModelLinkRecord {
  id: string;
  botType: string;
  profileRevisionId: string;
  modelRunId: string;
  linkageRole: ProfileModelLinkRole | string;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function createProfileModelLink(params: {
  botType: string;
  profileRevisionId: string;
  modelRunId: string;
  linkageRole: ProfileModelLinkRole;
  notes?: string;
}): Promise<ProfileModelLinkRecord> {
  const row = await prisma.paperBotProfileModelLink.create({
    data: {
      botType: params.botType,
      profileRevisionId: params.profileRevisionId,
      modelRunId: params.modelRunId,
      linkageRole: params.linkageRole,
      notes: params.notes ?? null,
    },
  });
  return {
    id: row.id,
    botType: row.botType,
    profileRevisionId: row.profileRevisionId,
    modelRunId: row.modelRunId,
    linkageRole: row.linkageRole as ProfileModelLinkRole | string,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listProfileModelLinks(filters: {
  botType?: string;
  profileRevisionId?: string;
} = {}): Promise<ProfileModelLinkRecord[]> {
  const where: {
    botType?: string;
    profileRevisionId?: string;
  } = {};
  if (filters.botType) where.botType = filters.botType;
  if (filters.profileRevisionId) where.profileRevisionId = filters.profileRevisionId;

  const rows = await prisma.paperBotProfileModelLink.findMany({
    where,
    orderBy: [{ botType: "asc" }, { createdAt: "asc" }],
  });
  return rows.map((row) => ({
    id: row.id,
    botType: row.botType,
    profileRevisionId: row.profileRevisionId,
    modelRunId: row.modelRunId,
    linkageRole: row.linkageRole as ProfileModelLinkRole | string,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function getProfileModelLinksForRevision(
  profileRevisionId: string
): Promise<ProfileModelLinkRecord[]> {
  return listProfileModelLinks({ profileRevisionId });
}

export async function summarizeGovernanceHandshakeForBot(botType: string): Promise<{
  botType: string;
  activeRevisionKey: string | null;
  activeRevisionId: string | null;
  intendedModelRunId: string | null;
  latestEvaluatedWithModelRunId: string | null;
}> {
  const [revisions, links] = await Promise.all([
    prisma.paperBotProfileRevision.findMany({
      where: { botType },
      orderBy: { createdAt: "asc" },
    }),
    prisma.paperBotProfileModelLink.findMany({
      where: { botType },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const active = revisions.find((r) => r.status === "ACTIVE") ?? null;

  let intendedModelRunId: string | null = null;
  let latestEvaluatedWithModelRunId: string | null = null;

  if (active) {
    const activeLinks = links.filter((l) => l.profileRevisionId === active.id);
    const intended = activeLinks
      .filter((l) => l.linkageRole === "INTENDED_ACTIVE")
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    if (intended.length > 0) {
      intendedModelRunId = intended[intended.length - 1].modelRunId;
    }
    const evaluated = activeLinks
      .filter((l) => l.linkageRole === "EVALUATED_WITH")
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    if (evaluated.length > 0) {
      latestEvaluatedWithModelRunId = evaluated[evaluated.length - 1].modelRunId;
    }
  }

  return {
    botType,
    activeRevisionKey: active?.revisionKey ?? null,
    activeRevisionId: active?.id ?? null,
    intendedModelRunId,
    latestEvaluatedWithModelRunId,
  };
}

