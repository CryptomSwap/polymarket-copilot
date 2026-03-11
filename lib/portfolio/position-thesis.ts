/**
 * Position Thesis v1: lightweight thesis tracking per position.
 * One thesis per (funderAddress, assetId). Reused for bot policies and explainability.
 */

import { prisma } from "@/lib/db";

export const THESIS_STATUSES = ["intact", "weakened", "invalidated", "unknown"] as const;
export type ThesisStatus = (typeof THESIS_STATUSES)[number];

export interface PositionThesisPayload {
  entryThesis?: string | null;
  currentThesisStatus?: ThesisStatus;
  exitReason?: string | null;
  notes?: string | null;
  marketId?: string | null;
}

export interface PositionThesisRow {
  id: string;
  funderAddress: string;
  assetId: string;
  marketId: string | null;
  entryThesis: string | null;
  currentThesisStatus: string;
  exitReason: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Get thesis for a position by funder + assetId.
 */
export async function getPositionThesis(
  funderAddress: string,
  assetId: string
): Promise<PositionThesisRow | null> {
  const funder = funderAddress.toLowerCase().trim();
  const row = await prisma.positionThesis.findUnique({
    where: { funderAddress_assetId: { funderAddress: funder, assetId } },
  });
  return row;
}

/**
 * List all theses for a funder (e.g. for positions that have a thesis).
 */
export async function listPositionTheses(funderAddress: string): Promise<PositionThesisRow[]> {
  const funder = funderAddress.toLowerCase().trim();
  const rows = await prisma.positionThesis.findMany({
    where: { funderAddress: funder },
    orderBy: { updatedAt: "desc" },
  });
  return rows;
}

/**
 * Upsert thesis for a position. Position (DerivedPosition) must exist for funder+assetId.
 * Creates a new thesis with default status "unknown" if none exists.
 */
export async function upsertPositionThesis(
  funderAddress: string,
  assetId: string,
  payload: PositionThesisPayload
): Promise<PositionThesisRow> {
  const funder = funderAddress.toLowerCase().trim();
  const position = await prisma.derivedPosition.findUnique({
    where: { funderAddress_assetId: { funderAddress: funder, assetId } },
  });
  if (!position) {
    throw new Error("Position not found. Thesis can only be set for an existing position.");
  }

  const status = payload.currentThesisStatus ?? "unknown";
  if (!THESIS_STATUSES.includes(status)) {
    throw new Error(`Invalid currentThesisStatus: ${status}. Use one of ${THESIS_STATUSES.join(", ")}.`);
  }

  const data = {
    entryThesis: payload.entryThesis ?? undefined,
    currentThesisStatus: status,
    exitReason: payload.exitReason ?? undefined,
    notes: payload.notes ?? undefined,
    marketId: payload.marketId ?? position.syncedMarketId ?? undefined,
  };

  const row = await prisma.positionThesis.upsert({
    where: { funderAddress_assetId: { funderAddress: funder, assetId } },
    create: {
      funderAddress: funder,
      assetId,
      marketId: data.marketId,
      entryThesis: data.entryThesis,
      currentThesisStatus: data.currentThesisStatus,
      exitReason: data.exitReason,
      notes: data.notes,
    },
    update: data,
  });
  return row;
}
