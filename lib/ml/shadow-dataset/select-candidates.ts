/**
 * Bounded selection of ShadowCandidate ids for dataset persistence.
 * prefer_missing_12h_label: prioritize rows that can still receive truthful 12h labels
 * (age-eligible, market+asset present, no example yet OR example.labelGoodDecision12h is null).
 * Does not fabricate labels — only steers which candidates are visited per run.
 * Does not require evaluatedAt: 12h markout truth comes from MarketPriceSnapshot at decision+12h,
 * independent of 24h shadow_evaluation classification.
 */

import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";

export interface SelectShadowCandidateIdsOptions {
  limit: number;
  funderAddress?: string;
  /** Default: 12h — candidates must be at least this old to admit truthful 12h horizon. */
  minAgeMs?: number;
  /** Ids already chosen (e.g. primary pass); fill avoids duplicates. */
  excludeIds?: string[];
}

/**
 * Returns ShadowCandidate ids ordered by createdAt ASC (oldest first among eligible).
 */
export async function selectShadowCandidateIdsPreferMissing12hLabel(
  prisma: PrismaClient,
  opts: SelectShadowCandidateIdsOptions
): Promise<string[]> {
  const minAgeMs = opts.minAgeMs ?? 12 * 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - minAgeMs);
  const funder = opts.funderAddress?.toLowerCase().trim();
  const exclude = opts.excludeIds?.filter(Boolean) ?? [];

  const funderClause = funder ? Prisma.sql`AND sc."funderAddress" = ${funder}` : Prisma.empty;

  const excludeClause =
    exclude.length > 0
      ? Prisma.sql`AND sc."id" NOT IN (${Prisma.join(exclude.map((id) => Prisma.sql`${id}`))})`
      : Prisma.empty;

  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT sc.id
    FROM "ShadowCandidate" sc
    LEFT JOIN "MlShadowTrainingExample" ex ON ex."shadowCandidateId" = sc.id
    WHERE sc."createdAt" <= ${cutoff}
      AND sc."marketId" IS NOT NULL
      AND sc."assetId" IS NOT NULL
      AND sc."marketId" != ''
      ${funderClause}
      ${excludeClause}
      AND (ex.id IS NULL OR ex."labelGoodDecision12h" IS NULL)
    ORDER BY sc."createdAt" ASC, sc.id ASC
    LIMIT ${opts.limit}
  `;

  return rows.map((r) => r.id);
}
