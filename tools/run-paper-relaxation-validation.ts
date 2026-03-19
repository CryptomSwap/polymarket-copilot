/**
 * Run full paper relaxation validation: snapshots, tick, close-due, then all three dumps.
 * Run: npx tsx tools/run-paper-relaxation-validation.ts
 */

import "dotenv/config";
import { getFunderForDecisionRecompute, recomputeDecisions } from "../lib/decision/recompute";
import { runPaperTradingTick, closePaperTradesAt12h } from "../lib/paper-trading/engine";

async function main(): Promise<void> {
  console.log("1. Generating decision snapshots...");
  const funder = await getFunderForDecisionRecompute();
  if (!funder) {
    console.warn("No funder resolved; skipping recompute. Set funder or ensure recommendations exist.");
  } else {
    const result = await recomputeDecisions(funder);
    console.log("   Snapshots upserted:", result.snapshotsUpserted, "Errors:", result.errors.length);
    if (result.errors.length > 0) console.warn("   Errors:", result.errors.slice(0, 3));
  }

  console.log("2. Running one paper tick...");
  const tickResult = await runPaperTradingTick(funder ?? undefined);
  console.log("   Opened:", tickResult.opened, "Skipped:", tickResult.skipped, "Candidates loaded:", tickResult.candidatesLoaded);
  console.log("   Scored after relaxation:", tickResult.scoredAfterRelaxation ?? 0, "Paper trades created from relaxation:", tickResult.paperTradesCreatedFromRelaxation ?? 0);

  console.log("3. Running close-due (close trades past 12h)...");
  const closeResult = await closePaperTradesAt12h();
  console.log("   Closed:", closeResult.closed, "Errors:", closeResult.errors.length);

  console.log("4. Generating dumps...");
  const { execSync } = await import("child_process");
  const root = process.cwd();
  execSync("npx tsx tools/create-paper-relaxation-audit.ts", { cwd: root, stdio: "inherit" });
  execSync("npx tsx tools/create-paper-relaxation-regression.ts", { cwd: root, stdio: "inherit" });
  execSync("npx tsx tools/create-paper-relaxed-trades-review.ts", { cwd: root, stdio: "inherit" });
  execSync("npx tsx tools/create-paper-relaxed-cohort-analysis.ts", { cwd: root, stdio: "inherit" });
  execSync("npx tsx tools/create-paper-relaxed-threshold-sensitivity.ts", { cwd: root, stdio: "inherit" });
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
