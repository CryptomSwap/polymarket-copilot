/**
 * CLI: backfill path/regime columns on MlShadowTrainingExample from snapshots.
 * Env: DRY_RUN=1, LIMIT=5000, REQUIRE_12H_LABEL=1
 */

import "dotenv/config";
import { prisma } from "../lib/db";
import { backfillPathRegimeFeaturesForMlExamples } from "../lib/ml/shadow-dataset/backfill-path-regime-features";

async function main(): Promise<void> {
  const dryRun = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
  const limit = Math.min(
    100_000,
    Math.max(100, parseInt(process.env.LIMIT ?? "5000", 10) || 5000)
  );
  const requireLabelGoodDecision12h =
    process.env.REQUIRE_12H_LABEL === "1" || process.env.REQUIRE_12H_LABEL === "true";

  const r = await backfillPathRegimeFeaturesForMlExamples(prisma, {
    limit,
    batchSize: Math.min(100, Math.max(10, parseInt(process.env.BATCH_SIZE ?? "50", 10) || 50)),
    dryRun,
    requireLabelGoodDecision12h,
  });

  console.log(JSON.stringify({ dryRun, ...r }, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect().catch(() => undefined));
