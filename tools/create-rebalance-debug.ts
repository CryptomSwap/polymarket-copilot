/**
 * Read-only: per-bot open count vs maxOpenTotal, overflow, and candidate closes (no writes).
 *
 * Run: npx tsx tools/create-rebalance-debug.ts
 *
 * Output: dump/rebalance-debug.json
 */

import * as fs from "fs/promises";
import * as path from "path";
import "dotenv/config";
import { prisma } from "../lib/db";
import { getEffectiveBotProfiles } from "../lib/paper-trading/bot-profiles";
import { computeRebalanceDebugSnapshot } from "../lib/paper-trading/rebalance";

const DUMP_DIR = path.join(process.cwd(), "dump");
const OUT = path.join(DUMP_DIR, "rebalance-debug.json");

async function main(): Promise<void> {
  await fs.mkdir(DUMP_DIR, { recursive: true });
  const effectiveProfiles = await getEffectiveBotProfiles();
  const snapshot = await computeRebalanceDebugSnapshot({ prisma, effectiveProfiles });
  await fs.writeFile(OUT, JSON.stringify(snapshot, null, 2), "utf8");
  console.log(`Wrote ${OUT}`);
  console.log(JSON.stringify(snapshot, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
