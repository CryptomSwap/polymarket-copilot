/**
 * Writes dump/self-improving-loop-status.{json,md} from current DB + job history.
 * Run: npx tsx tools/report-self-improving-loop-status.ts
 */

import { writeSelfImprovingLoopStatusReports } from "../lib/ops/self-improving-loop-status";

async function main(): Promise<void> {
  await writeSelfImprovingLoopStatusReports();
  console.log("Wrote dump/self-improving-loop-status.json and .md");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
