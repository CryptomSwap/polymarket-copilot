/**
 * Quick verification: recent PaperTrade rows vs MlShadowTrainingExample join
 * (recommendationId + assetId + side) and labelGoodDecision12h presence.
 *
 * Run: npx tsx tools/create-recommendation-linkage-check.ts
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { normalizeShadowSideForJoin } from "../lib/shadow-telemetry";

const DUMP_DIR = path.join(process.cwd(), "dump");
const OUT_JSON = path.join(DUMP_DIR, "recommendation-linkage-check.json");
const RECENT = Math.min(500, Math.max(1, Number(process.env.RECOMMENDATION_LINKAGE_RECENT_N ?? "50") || 50));

function parseRecommendationId(metadataJson: string | null): string | null {
  if (!metadataJson) return null;
  try {
    const o = JSON.parse(metadataJson) as Record<string, unknown>;
    const id = o.recommendationId;
    if (typeof id === "string" && id.trim()) return id.trim();
    return null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });

  const trades = await prisma.paperTrade.findMany({
    orderBy: { entryTime: "desc" },
    take: RECENT,
    select: {
      id: true,
      entryTime: true,
      metadataJson: true,
      assetId: true,
      side: true,
    },
  });

  const rows: Array<{
    paperTradeId: string;
    entryTime: string;
    recommendationIdFromMetadata: string | null;
    assetId: string;
    sideRaw: string;
    sideNormalized: "BUY" | "SELL";
    trainingExampleMatchCount: number;
    hasNonNullLabelGoodDecision12h: boolean;
  }> = [];

  let withRec = 0;
  let joined = 0;
  let labeled = 0;

  for (const t of trades) {
    const rec = parseRecommendationId(t.metadataJson);
    if (rec) withRec++;
    const sideNorm = normalizeShadowSideForJoin(t.side);
    let trainingExampleMatchCount = 0;
    let hasNonNullLabelGoodDecision12h = false;

    if (rec) {
      trainingExampleMatchCount = await prisma.mlShadowTrainingExample.count({
        where: {
          recommendationId: rec,
          assetId: t.assetId,
          side: sideNorm,
        },
      });
      if (trainingExampleMatchCount > 0) {
        joined++;
        const anyLabeled = await prisma.mlShadowTrainingExample.findFirst({
          where: {
            recommendationId: rec,
            assetId: t.assetId,
            side: sideNorm,
            labelGoodDecision12h: { not: null },
          },
          select: { id: true },
        });
        if (anyLabeled) {
          hasNonNullLabelGoodDecision12h = true;
          labeled++;
        }
      }
    }

    rows.push({
      paperTradeId: t.id,
      entryTime: t.entryTime.toISOString(),
      recommendationIdFromMetadata: rec,
      assetId: t.assetId,
      sideRaw: t.side,
      sideNormalized: sideNorm,
      trainingExampleMatchCount,
      hasNonNullLabelGoodDecision12h,
    });
  }

  const n = trades.length;
  const pct = (x: number) => (n === 0 ? 0 : (100 * x) / n);
  const pctOfWithRec = withRec === 0 ? 0 : (100 * joined) / withRec;

  const summary = {
    recentPaperTradesScanned: n,
    tradesWithRecommendationIdInMetadata: withRec,
    tradesJoinedToTrainingExample: joined,
    tradesWithNonNullLabelGoodDecision12h: labeled,
    pctPaperTradesJoinedToExample: Number(pct(joined).toFixed(1)),
    pctPaperTradesWithNonNullLabel12h: Number(pct(labeled).toFixed(1)),
    pctOfTradesWithMetadataRecThatJoin: Number(pctOfWithRec.toFixed(1)),
    note: "Join uses metadataJson.recommendationId + PaperTrade.assetId + normalized side (BUY/SELL), same as dataset builder.",
  };

  const payload = { generatedAt: new Date().toISOString(), summary, trades: rows };
  await fs.writeFile(OUT_JSON, JSON.stringify(payload, null, 2), "utf8");

  console.log("[recommendation-linkage-check]", summary);
  console.log("Wrote", OUT_JSON);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
